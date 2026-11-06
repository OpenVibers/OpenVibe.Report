#!/usr/bin/env node
'use strict';
/**
 * Give every session report written before the sharing system a share row, from the visibility column it already has.
 *
 * The mapping is the design's own (VISIBILITY-EVERYWHERE-DESIGN-2026-11-06, "Report: session reports"): a report that
 * was private is Only me, unlisted is Anyone with the link, public is Everyone. Nothing else changes: the owner stays
 * the owner, the column is left exactly as it is (it is still written for N-1), and a report that already has a share
 * row is skipped, whatever its audience — the owner may have chosen something else in the sheet, and this script never
 * overrules that.
 *
 * Idempotent: a second run registers nothing. It prints what it would do and writes nothing unless --apply is given:
 *
 *   node scripts/backfill-session-shares.js                       a dry run, the plan only
 *   node scripts/backfill-session-shares.js --apply               register the rows
 *   node scripts/backfill-session-shares.js --limit 500 --apply   the first 500 at a time
 *
 * It needs the service's own environment (DATABASE_URL, DATABASE_DIRECT_URL) and runs where the database is, as the
 * service's role: on the host, by the operator. It never creates a table — migration 0008 already made them.
 */
const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const APPLY = argv.includes('--apply');
const LIMIT = Math.max(1, Math.min(100000, Number(opt('--limit')) || 100000));

/** The design's mapping, written out here so the script states it rather than importing a rule it could drift from. */
const FROM_VISIBILITY = { private: 'private', unlisted: 'link', public: 'public' };
const LABEL = { public: 'Everyone', link: 'Anyone with the link', people: 'Specific people', private: 'Only me' };
const ORDER = ['public', 'link', 'people', 'private'];

/** The rows that still need a share row: every report without one, oldest id first, at most `limit` of them. */
async function plan(db, { limit = LIMIT } = {}) {
    const rows = await db.prepare(
        `SELECT r.id, r.owner, r.visibility FROM report_sessions r
         LEFT JOIN shares s ON s.service = 'report' AND s.kind = 'session-report' AND s.resource_id = r.id
         WHERE s.resource_id IS NULL
         ORDER BY r.id ASC LIMIT ?`).all(Math.max(1, Number(limit) || LIMIT));
    return rows.map((row) => ({
        id: row.id,
        owner: row.owner,
        from: row.visibility,
        to: FROM_VISIBILITY[row.visibility] || 'private',
    }));
}

/**
 * The plan as lines of text (the same in a dry run and a real one, so the two can be compared) and the counts.
 */
function describe(rows) {
    const counts = rows.reduce((a, p) => ({ ...a, [p.to]: (a[p.to] || 0) + 1 }), {});
    const lines = [];
    for (const audience of ORDER) {
        if (counts[audience]) lines.push(`  ${String(counts[audience]).padStart(6)}  ${LABEL[audience]} (from ${audience === 'link' ? 'unlisted' : audience})`);
    }
    if (rows.length) {
        lines.push('The first few:');
        for (const p of rows.slice(0, 10)) lines.push(`  ${p.id}  ${p.from} -> ${p.to}`);
        if (rows.length > 10) lines.push(`  ... and ${rows.length - 10} more`);
    }
    return { lines, counts };
}

/**
 * Run the plan. `register(id, owner, oldVisibility)` is server/sharing's own register, so a backfilled report is
 * exactly one a fresh write would have made. Answers { planned, made, failed }: a false from register means another
 * run got there first (409 share.exists), which is not a failure unless no row exists afterwards.
 */
async function backfill({ db, register, apply = false, limit = LIMIT }) {
    const rows = await plan(db, { limit });
    if (!apply) return { planned: rows.length, made: 0, failed: 0, rows };
    let made = 0;
    let failed = 0;
    for (const p of rows) {
        if (await register(p.id, p.owner, p.from)) { made++; continue; }
        const there = await db.prepare('SELECT 1 AS one FROM shares WHERE service = ? AND kind = ? AND resource_id = ?')
            .get('report', 'session-report', p.id);
        if (!there) failed++;
    }
    return { planned: rows.length, made, failed, rows };
}

async function main() {
    const configLib = require('../server/config');
    const { openStore } = require('../server/db');
    const sharing = require('../server/sharing');

    const config = configLib.load();
    if (!config.db || !config.db.url) {
        console.error('No DATABASE_URL: run this with the service environment (OpenVibe.Host roles/data), never against nothing.');
        return 2;
    }
    const store = await openStore(config, { log: { warn() {}, log() {}, error() {}, info() {} } });
    try {
        if (!sharing.init({ store })) {
            console.error('The sharing system is not available in this checkout (openvibe-sdk/share missing): nothing was done.');
            return 3;
        }
        const rows = await plan(store.db, { limit: LIMIT });
        const { lines } = describe(rows);
        console.log(`${APPLY ? 'Backfilling' : 'Would backfill'} ${rows.length} session report(s) with no share row:`);
        for (const line of lines) console.log(line);
        if (!APPLY) {
            console.log('A dry run: nothing was written. Run again with --apply to register these rows.');
            return 0;
        }
        const done = await backfill({ db: store.db, register: sharing.register, apply: true, limit: LIMIT });
        console.log(`Registered ${done.made} share row(s)${done.failed ? `, ${done.failed} failed (run it again; the script is idempotent)` : ''}.`);
        return done.failed ? 1 : 0;
    } finally {
        await store.close();
    }
}

if (require.main === module) {
    main().then((code) => process.exit(code)).catch((err) => {
        console.error(`[backfill-session-shares] ${(err && err.message) || err}`);
        process.exit(1);
    });
}

module.exports = { main, plan, describe, backfill, FROM_VISIBILITY, LABEL };
