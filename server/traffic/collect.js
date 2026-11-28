'use strict';
/**
 * Report's traffic collector (plan AD.40): the host's nginx log of every request any OpenVibe site answered
 * (/var/log/nginx/ov-traffic.log: one JSON object a line, snippets/ov-traffic.conf) → report_traffic_days.
 *
 *   createTrafficCollector({ store, file, verify, log, maxBytes })
 *     runOnce() → { lines, rows, skipped? }   read what is new since the saved place, count it, save the place
 *
 * The place is the file's inode and byte position, saved in the same transaction as the counts, so a pass that fails
 * counts nothing twice. When the file was rotated (nginx's logrotate: ov-traffic.log → ov-traffic.log.1), the rest of
 * the old file is read from `<file>.1` first. Only whole lines are read; a half-written last line waits for the next
 * pass. Each line keeps: the day, the site, who asked (agents.js, a crawler's claim checked by verify.js), what was asked
 * for (paths.js), the status, bytes and time. The client address is used for the check and dropped.
 */
const fs = require('fs');
const { classify } = require('./agents');
const { kindOf } = require('./paths');

const SOURCE = 'nginx';
const MAX_PAGE_PATHS = 150;           // page sections kept per site and day; the rest are counted as '/…'
const HOST = /^[a-z0-9][a-z0-9.-]{0,252}$/i;

function readRange(file, start, end) {
    const fd = fs.openSync(file, 'r');
    try {
        const len = Math.max(0, end - start);
        const buf = Buffer.alloc(len);
        let got = 0;
        while (got < len) {
            const n = fs.readSync(fd, buf, got, len - got, start + got);
            if (!n) break;
            got += n;
        }
        return buf.subarray(0, got);
    } finally { fs.closeSync(fd); }
}

/** Whole lines of a buffer and how many bytes they used. */
function wholeLines(buf) {
    const last = buf.lastIndexOf(0x0a);
    if (last < 0) return { lines: [], used: 0 };
    return { lines: buf.subarray(0, last).toString('utf8').split('\n'), used: last + 1 };
}

function statusBucket(s) {
    if (s >= 200 && s < 300) return 'ok';
    if (s >= 300 && s < 400) return 'redirects';
    if (s === 404 || s === 410) return 'missing';
    if (s >= 400 && s < 500) return 'refused';
    if (s >= 500) return 'errors';
    return null;
}

function createTrafficCollector({ store, file, verify = async () => '', log = console, maxBytes = 32 * 1024 * 1024 } = {}) {
    let running = false;
    const pagePaths = new Map();   // `${day}|${host}` → Set of page paths already kept

    async function knownPages(day, host) {
        const key = `${day}|${host}`;
        if (!pagePaths.has(key)) {
            const rows = await store.db.prepare("SELECT DISTINCT path FROM report_traffic_days WHERE day = ?::date AND host = ? AND kind = 'page'").all(day, host);
            pagePaths.set(key, new Set(rows.map((r) => r.path)));
            if (pagePaths.size > 4000) pagePaths.delete(pagePaths.keys().next().value);
        }
        return pagePaths.get(key);
    }

    /** Parsed lines → aggregated rows keyed by day, site, who, agent, verified, kind and path. */
    async function aggregate(lines) {
        const parsed = [];
        const checks = new Map();   // `${address}|${agent}` → suffixes
        for (const line of lines) {
            if (!line) continue;
            let d;
            try { d = JSON.parse(line); } catch { continue; }
            const t = Date.parse(d.t);
            const host = String(d.h || '').toLowerCase().replace(/:\d+$/, '');
            if (!Number.isFinite(t) || !HOST.test(host) || host === '_' || /^\d+\.\d+\.\d+\.\d+$/.test(host)) continue;
            const who = classify(d.ua);
            const what = kindOf(d.m, d.u);
            const row = { t, day: new Date(t).toISOString().slice(0, 10), host, who: who.who, agent: who.agent, kind: what.kind, path: what.path,
                status: Number(d.s) || 0, bytes: Number(d.b) || 0, ms: Math.round((Number(d.rt) || 0) * 1000), address: who.verify ? String(d.a || '') : '', verify: who.verify };
            if (row.verify && row.address) checks.set(`${row.address}|${row.agent}`, row.verify);
            parsed.push(row);
        }
        const answers = new Map();
        const pending = [...checks.entries()];
        for (let i = 0; i < pending.length; i += 8) {
            await Promise.all(pending.slice(i, i + 8).map(async ([key, suffixes]) => {
                answers.set(key, await verify(key.slice(0, key.lastIndexOf('|')), suffixes).catch(() => ''));
            }));
        }
        const rows = new Map();
        for (const r of parsed) {
            const verified = r.verify ? (answers.get(`${r.address}|${r.agent}`) || '') : '';
            let path = r.path;
            if (r.kind === 'page' && path) {
                const kept = await knownPages(r.day, r.host);
                if (!kept.has(path)) {
                    if (kept.size >= MAX_PAGE_PATHS) path = '/…'; else kept.add(path);
                }
            }
            const key = [r.day, r.host, r.who, r.agent, verified, r.kind, path].join('\u0001');
            let a = rows.get(key);
            if (!a) {
                a = { day: r.day, host: r.host, who: r.who, agent: r.agent, verified, kind: r.kind, path, requests: 0, ok: 0, redirects: 0, missing: 0, refused: 0, errors: 0, bytes: 0, ms: 0, first: r.t, last: r.t };
                rows.set(key, a);
            }
            a.requests += 1;
            const b = statusBucket(r.status);
            if (b) a[b] += 1;
            a.bytes += r.bytes;
            a.ms += r.ms;
            if (r.t < a.first) a.first = r.t;
            if (r.t > a.last) a.last = r.t;
        }
        return [...rows.values()];
    }

    async function save(rows, place) {
        await store.tx(async () => {
            for (const a of rows) {
                await store.db.prepare(`INSERT INTO report_traffic_days (day, host, who, agent, verified, kind, path, requests, ok, redirects, missing, refused, errors, bytes, ms, first_at, last_at)
                    VALUES (?::date, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::timestamptz, ?::timestamptz)
                    ON CONFLICT (day, host, who, agent, verified, kind, path) DO UPDATE SET
                        requests = report_traffic_days.requests + EXCLUDED.requests, ok = report_traffic_days.ok + EXCLUDED.ok,
                        redirects = report_traffic_days.redirects + EXCLUDED.redirects, missing = report_traffic_days.missing + EXCLUDED.missing,
                        refused = report_traffic_days.refused + EXCLUDED.refused, errors = report_traffic_days.errors + EXCLUDED.errors,
                        bytes = report_traffic_days.bytes + EXCLUDED.bytes, ms = report_traffic_days.ms + EXCLUDED.ms,
                        first_at = LEAST(report_traffic_days.first_at, EXCLUDED.first_at), last_at = GREATEST(report_traffic_days.last_at, EXCLUDED.last_at)`)
                    .run(a.day, a.host, a.who, a.agent, a.verified, a.kind, a.path, a.requests, a.ok, a.redirects, a.missing, a.refused, a.errors, a.bytes, a.ms,
                        new Date(a.first).toISOString(), new Date(a.last).toISOString());
            }
            await store.db.prepare(`INSERT INTO report_traffic_cursor (source, inode, position, lines, updated_at) VALUES (?, ?, ?, ?, now())
                ON CONFLICT (source) DO UPDATE SET inode = EXCLUDED.inode, position = EXCLUDED.position, lines = report_traffic_cursor.lines + EXCLUDED.lines, updated_at = now()`)
                .run(SOURCE, place.inode, place.position, place.lines);
        });
    }

    async function runOnce() {
        if (!file) return { skipped: 'no_log' };
        if (running) return { skipped: 'running' };
        running = true;
        try {
            let st;
            try { st = fs.statSync(file); } catch { return { skipped: 'no_log' }; }
            const cur = await store.db.prepare('SELECT inode, position FROM report_traffic_cursor WHERE source = ?').get(SOURCE);
            const inode = String(st.ino);
            const lines = [];
            let budget = maxBytes;
            let position = 0;
            if (cur && String(cur.inode) === inode) {
                position = Number(cur.position) > st.size ? 0 : Number(cur.position);   // truncated: from the start
            } else if (cur) {
                // Rotated since the last pass: finish the old file (now <file>.1) from the saved place.
                try {
                    const old = fs.statSync(`${file}.1`);
                    if (String(old.ino) === String(cur.inode) && Number(cur.position) < old.size) {
                        const end = Math.min(old.size, Number(cur.position) + budget);
                        const got = wholeLines(readRange(`${file}.1`, Number(cur.position), end));
                        lines.push(...got.lines);
                        budget -= got.used;
                    }
                } catch { /* the old file is gone: its rest is lost, the new one starts at 0 */ }
            }
            if (budget > 0 && position < st.size) {
                const got = wholeLines(readRange(file, position, Math.min(st.size, position + budget)));
                lines.push(...got.lines);
                position += got.used;
            }
            const rows = await aggregate(lines);
            await save(rows, { inode, position, lines: lines.length });
            return { lines: lines.length, rows: rows.length };
        } catch (err) {
            const msg = String((err && err.message) || err).replace(/\s+/g, ' ').slice(0, 200);
            log.warn('[OpenVibe.Report] traffic: the pass failed: ' + msg);
            return { error: msg };
        } finally { running = false; }
    }

    /** Daily counts older than `days` go (the totals by day are what the pages read). */
    async function prune(days = 400) {
        const r = await store.db.prepare("DELETE FROM report_traffic_days WHERE day < (CURRENT_DATE - ?::int)").run(Math.max(30, days));
        return { pruned: r && r.changes != null ? r.changes : null };
    }

    return { runOnce, prune };
}

module.exports = { createTrafficCollector, wholeLines, statusBucket };
