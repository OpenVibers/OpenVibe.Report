'use strict';
/**
 * The AI ledger (plan L40 and L41): Report keeps the meter.
 *
 * OpenVibe.AI writes one ai.call.recorded@1 event per run. Report takes that event on its own HMAC-verified
 * /internal/events, writes the record once (the key is the system and the run id, or the turn id), and rolls the
 * records up by day. The raw records are kept for 90 days; the roll-ups are kept for good.
 *
 * The questions:
 *   usage()      the rows of one group (day, site, model, system, paid_by), for one person or for everyone
 *   openTotals() the public totals: the tokens, the cache's share, the own-key share and the spend by week.
 *               No person, no site and no key is in them: the rows are summed before they are answered.
 *
 * A group that fewer than ten people share reads 'fewer than 10' instead of counting them.
 */

const GROUPS = { day: 'day', site: 'attribution', model: 'model', system: 'system', paid_by: 'paid_by' };
const RAW_RETENTION_DAYS = 90;
const PEOPLE_FLOOR = 10;
const EMPTY = '';
// The empty string as SQL writes it (two quotes), and one quote on its own.
const SQL_EMPTY = String.fromCharCode(39, 39);
const q = String.fromCharCode(39);

const num = (v) => (v === null || v === undefined || v === '' ? 0 : (Number.isFinite(Number(v)) ? Number(v) : 0));
const int = (v) => Math.trunc(num(v));
/** Six decimals, the way money is written here. */
const money = (v) => Math.round(num(v) * 1e6) / 1e6;

/** The idempotency key of a record: the system and the run (or the turn). */
const recordKey = (p) => `${String(p.system || 'ai')}|${p.run_id || p.turn_id || ''}`;

/** The day of a timestamp (YYYY-MM-DD). */
const dayOf = (v) => (v instanceof Date ? v : new Date(v)).toISOString().slice(0, 10);

/** The Monday of the week a day falls in. */
const weekOf = (day) => {
    const d = new Date(`${day}T00:00:00Z`);
    const dow = (d.getUTCDay() + 6) % 7;
    return new Date(d.getTime() - dow * 86400000).toISOString().slice(0, 10);
};

/**
 * Write one record inside the delivery's own transaction. The same call twice is one row: the key is the system
 * and the run id (or the turn id).
 */
async function recordUsage(t, payload, { occurredAt = null, source = 'events' } = {}) {
    const p = payload && typeof payload === 'object' ? payload : {};
    const at = p.at || occurredAt || new Date().toISOString();
    const key = recordKey(p);
    const sql = 'INSERT INTO report_ai_usage (record_key, system, run_id, turn_id, subject, attribution, surface, provider, model, effort,'
        + ' paid_by, paid_by_detail, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, cache_write_ttl,'
        + ' images, audio_seconds, video_seconds, list_cost_usd, charged_usd, fee_usd, cache_saved_usd, price_source, price_date,'
        + ' latency_ms, ttft_ms, attempts, outcome, at, day, source)'
        + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        + ' ON CONFLICT (record_key) DO NOTHING';
    const r = await t.prepare(sql)
        .run(key, String(p.system || 'ai'), p.run_id || null, p.turn_id || null, p.subject || null, String(p.attribution || EMPTY),
            String(p.surface || EMPTY), p.provider || null, p.model || null, p.effort || null, String(p.paid_by || EMPTY), p.paid_by_detail || null,
            int(p.input), int(p.output), int(p.reasoning), int(p.cache_read), int(p.cache_write), p.cache_write_ttl || null,
            int(p.images), num(p.audio_seconds), num(p.video_seconds), money(p.list_cost_usd), money(p.charged_usd), money(p.fee_usd), money(p.cache_saved_usd),
            String(p.price_source || EMPTY), p.price_date || null, p.latency_ms == null ? null : int(p.latency_ms), p.ttft_ms == null ? null : int(p.ttft_ms),
            int(p.attempts) || 1, String(p.outcome || 'succeeded'), at, dayOf(at), String(source || 'events'));
    return Number(r && r.changes) ? 'usage:recorded' : 'usage:duplicate';
}

/** The rows of one day, recomputed from the raw records (delete-then-insert, so a second pass counts nothing twice). */
async function rollupDay(store, day) {
    const sql = 'SELECT day, COALESCE(subject, ' + SQL_EMPTY + ') AS subject, attribution, system, COALESCE(provider, ' + SQL_EMPTY + ') AS provider,'
        + ' COALESCE(model, ' + SQL_EMPTY + ') AS model, paid_by, COUNT(*)::bigint AS calls, SUM(tokens_input)::bigint AS tokens_input,'
        + ' SUM(tokens_output)::bigint AS tokens_output, SUM(tokens_reasoning)::bigint AS tokens_reasoning,'
        + ' SUM(tokens_cache_read)::bigint AS tokens_cache_read, SUM(tokens_cache_write)::bigint AS tokens_cache_write,'
        + ' SUM(images)::bigint AS images, SUM(audio_seconds) AS audio_seconds, SUM(video_seconds) AS video_seconds,'
        + ' SUM(list_cost_usd) AS list_cost_usd, SUM(charged_usd) AS charged_usd, SUM(fee_usd) AS fee_usd, SUM(cache_saved_usd) AS cache_saved_usd,'
        + ' SUM(COALESCE(latency_ms, 0))::bigint AS latency_ms, SUM(attempts)::bigint AS attempts'
        + ' FROM report_ai_usage WHERE day = ?::date GROUP BY day, subject, attribution, system, provider, model, paid_by';
    const rows = await store.db.prepare(sql).all(day);
    await store.db.prepare('DELETE FROM report_ai_usage_days WHERE day = ?::date').run(day);
    const insert = 'INSERT INTO report_ai_usage_days (day, subject, attribution, system, provider, model, paid_by, calls, tokens_input, tokens_output,'
        + ' tokens_reasoning, tokens_cache_read, tokens_cache_write, images, audio_seconds, video_seconds, list_cost_usd, charged_usd, fee_usd, cache_saved_usd,'
        + ' latency_ms, attempts, updated_at)'
        + ' VALUES (?::date, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now())';
    for (const r of rows) {
        await store.db.prepare(insert)
            .run(r.day, r.subject, r.attribution, r.system, r.provider, r.model, r.paid_by, r.calls, r.tokens_input, r.tokens_output,
                r.tokens_reasoning, r.tokens_cache_read, r.tokens_cache_write, r.images, r.audio_seconds, r.video_seconds,
                money(r.list_cost_usd), money(r.charged_usd), money(r.fee_usd), money(r.cache_saved_usd), r.latency_ms, r.attempts);
    }
    return rows.length;
}

/** The days that still have raw records, rolled up again (the job calls this every hour). */
async function rollup(store, { days = 14 } = {}) {
    const list = await store.db.prepare('SELECT DISTINCT day FROM report_ai_usage ORDER BY day DESC LIMIT ?').all(Math.max(1, days));
    let n = 0;
    for (const r of list) n += await rollupDay(store, r.day);
    return { days: list.length, rows: n };
}

/** The raw records go after 90 days; the roll-ups stay. */
async function prune(store, { now = Date.now(), days = RAW_RETENTION_DAYS } = {}) {
    const floor = new Date(now - days * 86400000).toISOString().slice(0, 10);
    const r = await store.db.prepare('DELETE FROM report_ai_usage WHERE day < ?::date').run(floor);
    return { raw: Number(r && r.changes) || 0 };
}

/** One row of a group, ready to be answered with. */
function rowOf(group, key, r) {
    const people = Number(r.people) || 0;
    return {
        group, key,
        calls: Number(r.calls) || 0,
        people: people >= PEOPLE_FLOOR ? people : 'fewer than 10',
        input: Number(r.tokens_input) || 0,
        output: Number(r.tokens_output) || 0,
        reasoning: Number(r.tokens_reasoning) || 0,
        cache_read: Number(r.tokens_cache_read) || 0,
        cache_write: Number(r.tokens_cache_write) || 0,
        images: Number(r.images) || 0,
        audio_seconds: Number(r.audio_seconds) || 0,
        video_seconds: Number(r.video_seconds) || 0,
        list_cost_usd: money(r.list_cost_usd),
        charged_usd: money(r.charged_usd),
        fee_usd: money(r.fee_usd),
        cache_saved_usd: money(r.cache_saved_usd),
    };
}

/** The day bounds of a from/to pair: either may be a day (YYYY-MM-DD) or a full timestamp. */
function bounds({ from = null, to = null } = {}) {
    const day = (v) => (v ? String(v).slice(0, 10) : null);
    return { from: day(from), to: day(to) };
}

/** The measures every group answers with. */
const MEASURES = 'COUNT(DISTINCT NULLIF(subject, ' + SQL_EMPTY + '))::bigint AS people,'
    + ' SUM(calls)::bigint AS calls, SUM(tokens_input)::bigint AS tokens_input, SUM(tokens_output)::bigint AS tokens_output,'
    + ' SUM(tokens_reasoning)::bigint AS tokens_reasoning, SUM(tokens_cache_read)::bigint AS tokens_cache_read,'
    + ' SUM(tokens_cache_write)::bigint AS tokens_cache_write, SUM(images)::bigint AS images,'
    + ' SUM(audio_seconds) AS audio_seconds, SUM(video_seconds) AS video_seconds,'
    + ' SUM(list_cost_usd) AS list_cost_usd, SUM(charged_usd) AS charged_usd, SUM(fee_usd) AS fee_usd, SUM(cache_saved_usd) AS cache_saved_usd';

/** The usage rows of one group: 'day', 'site', 'model', 'system' or 'paid_by'. */
async function usage(store, { from = null, to = null, group = 'day', subject = null } = {}) {
    const column = GROUPS[group];
    if (!column) throw new Error('group must be one of ' + Object.keys(GROUPS).join(', '));
    const { from: fromDay, to: toDay } = bounds({ from, to });
    const where = [];
    const args = [];
    if (fromDay) { where.push('day >= ?::date'); args.push(fromDay); }
    if (toDay) { where.push('day <= ?::date'); args.push(toDay); }
    if (subject) { where.push('subject = ?'); args.push(subject); }
    const sql = 'SELECT ' + column + ' AS bucket, ' + MEASURES + ' FROM report_ai_usage_days'
        + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' GROUP BY ' + column + ' ORDER BY ' + column;
    const rows = await store.db.prepare(sql).all(...args);
    return rows.map((r) => rowOf(group, r.bucket == null ? EMPTY : r.bucket, r));
}

/** The totals of the rows: the calls, the tokens and the money. */
function totalsOf(rows) {
    const t = { calls: 0, input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0, images: 0, audio_seconds: 0, video_seconds: 0, list_cost_usd: 0, charged_usd: 0, fee_usd: 0, cache_saved_usd: 0 };
    for (const r of rows) {
        t.calls += r.calls; t.input += r.input; t.output += r.output; t.reasoning += r.reasoning;
        t.cache_read += r.cache_read; t.cache_write += r.cache_write; t.images += r.images;
        t.audio_seconds += r.audio_seconds; t.video_seconds += r.video_seconds;
        t.list_cost_usd += r.list_cost_usd; t.charged_usd += r.charged_usd; t.fee_usd += r.fee_usd; t.cache_saved_usd += r.cache_saved_usd;
    }
    for (const k of ['list_cost_usd', 'charged_usd', 'fee_usd', 'cache_saved_usd']) t[k] = money(t[k]);
    return t;
}

/** The daily rows of a range. */
async function daily(store, { from = null, to = null } = {}) {
    const { from: fromDay, to: toDay } = bounds({ from, to });
    const where = [];
    const args = [];
    if (fromDay) { where.push('day >= ?::date'); args.push(fromDay); }
    if (toDay) { where.push('day <= ?::date'); args.push(toDay); }
    const sel = 'SUM(calls)::bigint AS calls, SUM(tokens_input)::bigint AS tokens_input, SUM(tokens_output)::bigint AS tokens_output,'
        + ' SUM(tokens_reasoning)::bigint AS tokens_reasoning, SUM(tokens_cache_read)::bigint AS tokens_cache_read,'
        + ' SUM(tokens_cache_write)::bigint AS tokens_cache_write, SUM(list_cost_usd) AS list_cost_usd,'
        + ' SUM(charged_usd) AS charged_usd, SUM(fee_usd) AS fee_usd, SUM(cache_saved_usd) AS cache_saved_usd';
    const sql = 'SELECT day, ' + sel + ' FROM report_ai_usage_days' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' GROUP BY day ORDER BY day';
    return await store.db.prepare(sql).all(...args);
}

/**
 * The public totals: the tokens, the cache's share, the own-key share and the spend by week. No person, no site
 * and no key is in them.
 */
async function openTotals(store, { from = null, to = null } = {}) {
    const sel = 'SUM(calls)::bigint AS calls, SUM(tokens_input)::bigint AS tokens_input, SUM(tokens_output)::bigint AS tokens_output,'
        + ' SUM(tokens_reasoning)::bigint AS tokens_reasoning, SUM(tokens_cache_read)::bigint AS tokens_cache_read,'
        + ' SUM(tokens_cache_write)::bigint AS tokens_cache_write, SUM(list_cost_usd) AS list_cost_usd,'
        + ' SUM(charged_usd) AS charged_usd, SUM(fee_usd) AS fee_usd, SUM(cache_saved_usd) AS cache_saved_usd';
    const total = (await store.db.prepare('SELECT ' + sel + ' FROM report_ai_usage_days').all())[0] || {};
    const own = (await store.db.prepare('SELECT ' + sel + ' FROM report_ai_usage_days WHERE paid_by = ' + q + 'own_key' + q).all())[0] || {};
    const calls = Number(total.calls) || 0;
    const input = Number(total.tokens_input) || 0;
    const output = Number(total.tokens_output) || 0;
    const cacheRead = Number(total.tokens_cache_read) || 0;
    const cacheWrite = Number(total.tokens_cache_write) || 0;
    const prompt = input + cacheRead + cacheWrite;
    const ownTokens = (Number(own.tokens_input) || 0) + (Number(own.tokens_output) || 0) + (Number(own.tokens_cache_read) || 0) + (Number(own.tokens_cache_write) || 0);
    const allTokens = input + output + cacheRead + cacheWrite;
    const weeks = new Map();
    for (const r of await daily(store, { from, to })) {
        const w = weekOf(String(r.day).slice(0, 10));
        const cur = weeks.get(w) || { week: w, calls: 0, list_cost_usd: 0, charged_usd: 0, cache_saved_usd: 0 };
        cur.calls += Number(r.calls) || 0;
        cur.list_cost_usd = money(cur.list_cost_usd + (Number(r.list_cost_usd) || 0));
        cur.charged_usd = money(cur.charged_usd + (Number(r.charged_usd) || 0));
        cur.cache_saved_usd = money(cur.cache_saved_usd + (Number(r.cache_saved_usd) || 0));
        weeks.set(w, cur);
    }
    return {
        calls,
        tokens: { input, output, cache_read: cacheRead, cache_write: cacheWrite },
        cache_share: prompt > 0 ? Math.round((cacheRead / prompt) * 1e6) / 1e6 : 0,
        cache_saved_usd: money(total.cache_saved_usd),
        own_key_share: allTokens > 0 ? Math.round((ownTokens / allTokens) * 1e6) / 1e6 : 0,
        own_key_calls: Number(own.calls) || 0,
        list_cost_usd: money(total.list_cost_usd),
        charged_usd: money(total.charged_usd),
        fee_usd: money(total.fee_usd),
        spend_by_week: [...weeks.values()].sort((a, b) => (a.week < b.week ? -1 : 1)),
    };
}

/**
 * ADR-033: a person's own records and roll-ups, for the export of their account. The rows leave with the account.
 */
async function exportFor(store, subject) {
    if (!subject) throw new TypeError('exportFor needs a subject');
    const records = await store.db.prepare('SELECT * FROM report_ai_usage WHERE subject = ? ORDER BY at').all(subject);
    const days = await store.db.prepare('SELECT * FROM report_ai_usage_days WHERE subject = ? ORDER BY day').all(subject);
    return {
        subject,
        exported_at: new Date().toISOString(),
        records,
        days,
    };
}

/** ADR-033: the same rows are erased with the account. The roll-ups of other people are not touched. */
async function eraseFor(store, subject) {
    if (!subject) throw new TypeError('eraseFor needs a subject');
    const records = await store.db.prepare('DELETE FROM report_ai_usage WHERE subject = ?').run(subject);
    const days = await store.db.prepare('DELETE FROM report_ai_usage_days WHERE subject = ?').run(subject);
    return { subject, records: Number(records && records.changes) || 0, days: Number(days && days.changes) || 0 };
}

/** The ledger as one object: the routes, the job and the account tools share it. */
function createAiUsage({ store, now = () => Date.now(), log = console } = {}) {
    if (!store) return null;
    return {
        store,
        usage: (opts = {}) => usage(store, opts),
        openTotals: (opts = {}) => openTotals(store, opts),
        totalsOf,
        rollup: (opts = {}) => rollup(store, opts),
        prune: (opts = {}) => prune(store, { now, ...opts }),
        exportFor: (subject) => exportFor(store, subject),
        eraseFor: (subject) => eraseFor(store, subject),
        recordUsage,
    };
}
module.exports = { GROUPS, RAW_RETENTION_DAYS, PEOPLE_FLOOR, recordKey, recordUsage, rollup, rollupDay, prune, usage, totalsOf, daily, openTotals, exportFor, eraseFor, createAiUsage, weekOf, dayOf, money };
