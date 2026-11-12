'use strict';
/**
 * AI performance (plan L40/L41, ai-metrics.md): the per-call roll-ups behind report.ai-performance@1.
 *
 * ai.call.recorded@1 carries the 1.1.0 fields: operation, task and task_id, task_ms, harness, place, streamed, tps,
 * error_class, fallbacks, cache_hit and tool_calls. Report keeps the raw record for 90 days and, inside the same
 * ingest transaction, adds it to:
 *
 *   report_ai_perf_days   one row per day and system/provider/model/operation/task/place/harness: counts, token and
 *                         cost sums, and three histograms. The histograms are 40 counts over the log-scale bounds in
 *                         HISTOGRAM_BOUNDS below: time to first token (ms), latency (ms) and output tokens per second.
 *   report_ai_task_days   one row per day, task kind and system: how many tasks, and the cost and time of each task
 *                         as histograms. A task is the calls that share task_id; its time is task_ms when any call
 *                         gives it, else the sum of its calls' latency_ms. Its cost is the sum of the calls'
 *                         charged_usd.
 *
 * performance() answers the rows of one group. A percentile answers the UPPER BOUND of the bucket the p-th call
 * falls in, never an invented value inside the bucket: with 40 buckets a p50 is at most one bucket's width off, and
 * the answer says so by being a bound. The public groups are model, provider and operation, with a floor of 20 calls;
 * system, task, place and harness are for staff.
 */

const DAY_MS = 86400000;
const BUCKET_COUNT = 40;
const DEFAULT_RANGE_DAYS = 30;
const MAX_RANGE_DAYS = 400;
const PUBLIC_CALL_FLOOR = 20;

/** The groups report.ai-performance@1 has. */
const GROUPS = Object.freeze({
    model: 'model', provider: 'provider', operation: 'operation', system: 'system', task: 'task', place: 'place', harness: 'harness',
});
const PERFORMANCE_GROUPS = Object.freeze(Object.keys(GROUPS));
/** The groups anyone may ask for, and the groups a staff caller may ask for. */
const PUBLIC_GROUPS = Object.freeze(['model', 'provider', 'operation']);
const STAFF_GROUPS = Object.freeze(['system', 'task', 'place', 'harness']);
/** A filter may name any group's column; the public route only accepts the public three. */
const FILTERS = Object.freeze(['provider', 'model', 'operation', 'system', 'task', 'place', 'harness']);
const PUBLIC_FILTERS = Object.freeze(['provider', 'model', 'operation']);

/**
 * The upper bound of each log-scale bucket, written once. The bounds are per measure because the ranges differ by
 * orders of magnitude; a value at or below a bound falls in that bucket, above the last bound in the last bucket, and
 * a percentile answers the bucket's upper bound.
 */
function logBounds(min, max, count = BUCKET_COUNT) {
    const lo = Math.log(min);
    const hi = Math.log(max);
    const out = [];
    for (let i = 1; i <= count; i += 1) out.push(Math.round(Math.exp(lo + ((hi - lo) * i) / count) * 1e6) / 1e6);
    return Object.freeze(out);
}
const HISTOGRAM_BOUNDS = Object.freeze({
    ttft: logBounds(1, 120000),
    latency: logBounds(1, 3600000),
    tps: logBounds(0.1, 10000),
    task_cost_usd: logBounds(0.000001, 100),
    task_time_ms: logBounds(1, 3600000),
});

const num = (v) => (v === null || v === undefined || v === '' ? 0 : (Number.isFinite(Number(v)) ? Number(v) : 0));
const int = (v) => Math.trunc(num(v));
/** Six decimals, the way money is written here. */
const money = (v) => Math.round(num(v) * 1e6) / 1e6;
const round = (v, places = 6) => {
    const f = 10 ** places;
    return Math.round(num(v) * f) / f;
};
const dayOf = (v) => (v instanceof Date ? v : new Date(v)).toISOString().slice(0, 10);
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

/** A text field, cut to its contract's maximum and never null (the empty string means none). */
function text(v, max) {
    if (v == null) return '';
    return String(v).slice(0, max);
}

/** The bucket a value falls in: 0 for a value at or below the first bound, the last bucket above the last bound. */
function bucketOf(value, bounds) {
    const v = Number(value);
    if (!Number.isFinite(v) || v <= 0) return 0;
    let lo = 0;
    let hi = bounds.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (v <= bounds[mid]) hi = mid;
        else lo = mid + 1;
    }
    return lo;
}

/** A fresh histogram: 40 zero counts. */
const zeroHist = () => new Array(BUCKET_COUNT).fill(0);

/** Add one value to a histogram; a null (not measured) adds nothing. */
function bump(hist, value, bounds) {
    if (value === null || value === undefined || value === '') return false;
    const v = Number(value);
    if (!Number.isFinite(v) || v < 0) return false;
    hist[bucketOf(v, bounds)] += 1;
    return true;
}

/** A jsonb histogram from the database as 40 numbers (a missing or short one is padded with zeros). */
function asHist(value) {
    const out = zeroHist();
    let arr = value;
    if (typeof arr === 'string') {
        try { arr = JSON.parse(arr); } catch { arr = []; }
    }
    if (!Array.isArray(arr)) return out;
    for (let i = 0; i < Math.min(arr.length, out.length); i += 1) out[i] = int(arr[i]);
    return out;
}

/** Merge one histogram into another (the first is changed). */
function mergeHist(into, from) {
    for (let i = 0; i < BUCKET_COUNT; i += 1) into[i] += int(from[i]);
    return into;
}

/** A jsonb error-class map from the database. */
function asMap(value) {
    let obj = value;
    if (typeof obj === 'string') {
        try { obj = JSON.parse(obj); } catch { obj = {}; }
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        const key = String(k).slice(0, 60);
        if (key) out[key] = int(v);
    }
    return out;
}

/**
 * The p-th percentile of a histogram: the upper bound of the bucket the nearest-rank call lands in. n = 0 answers
 * null; a p below 1 counts as 1 and above 100 as 100. Never an interpolation, never a value below the data.
 */
function percentile(hist, bounds, p) {
    const counts = Array.isArray(hist) ? hist : [];
    const n = counts.reduce((s, c) => s + int(c), 0);
    if (!n) return null;
    const want = Math.min(n, Math.max(1, Math.ceil((Math.max(1, Math.min(100, Number(p) || 50)) / 100) * n)));
    let seen = 0;
    for (let i = 0; i < bounds.length; i += 1) {
        seen += int(counts[i]);
        if (seen >= want) return round(bounds[i]);
    }
    return round(bounds[bounds.length - 1]);
}

/** p50, p90, p95 and the number of samples of a histogram. */
function summary(hist, bounds) {
    return {
        p50: percentile(hist, bounds, 50),
        p90: percentile(hist, bounds, 90),
        p95: percentile(hist, bounds, 95),
        n: (Array.isArray(hist) ? hist : []).reduce((s, c) => s + int(c), 0),
    };
}

/** The key of a performance row, as SQL compares it. */
const KEY_WHERE = 'day = ?::date AND system = ? AND provider = ? AND model = ? AND operation = ? AND task = ? AND place = ? AND harness = ?';

const succeededOutcome = (outcome) => outcome === 'succeeded' || outcome === 'cached';
const failedOutcome = (outcome) => outcome === 'failed' || outcome === 'cancelled';

/**
 * Add one ai.call.recorded@1 payload to report_ai_perf_days, inside the delivery's own transaction. The caller has
 * already inserted the raw record and returns early on a duplicate, so the same call is counted once. The row is
 * claimed first (an insert that conflicts does nothing), then read under a row lock and written back, so two
 * deliveries for the same group cannot lose an increment.
 */
async function recordPerformance(t, payload, day) {
    const p = payload && typeof payload === 'object' ? payload : {};
    const perfDay = day || dayOf(p.at || new Date().toISOString());
    const system = text(p.system || 'ai', 100);
    const provider = text(p.provider, 128);
    const model = text(p.model, 200);
    const operation = text(p.operation, 64);
    const task = text(p.task, 120);
    const place = text(p.place, 40);
    const harness = text(p.harness, 60);
    const key = [perfDay, system, provider, model, operation, task, place, harness];

    await t.prepare('INSERT INTO report_ai_perf_days (day, system, provider, model, operation, task, place, harness)'
        + ' VALUES (?::date, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING')
        .run(...key);
    const current = (await t.prepare('SELECT calls, succeeded, errors, fallbacks, streamed, cache_hits, tool_calls,'
        + ' tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, charged_usd, list_cost_usd,'
        + ' cache_saved_usd, ttft_hist, latency_hist, tps_hist, errors_by_class FROM report_ai_perf_days WHERE '
        + KEY_WHERE + ' FOR UPDATE').all(...key))[0];
    if (!current) throw new Error('report_ai_perf_days row vanished inside its transaction');

    const outcome = String(p.outcome || 'succeeded');
    const succeeded = succeededOutcome(outcome);
    const failed = failedOutcome(outcome);
    const ttft = asHist(current.ttft_hist);
    const latency = asHist(current.latency_hist);
    const tps = asHist(current.tps_hist);
    bump(ttft, p.ttft_ms == null ? null : num(p.ttft_ms), HISTOGRAM_BOUNDS.ttft);
    bump(latency, p.latency_ms == null ? null : num(p.latency_ms), HISTOGRAM_BOUNDS.latency);
    bump(tps, p.tps == null ? null : num(p.tps), HISTOGRAM_BOUNDS.tps);
    const errors = asMap(current.errors_by_class);
    const errorClass = text(p.error_class, 60);
    if (failed && errorClass) errors[errorClass] = (errors[errorClass] || 0) + 1;

    await t.prepare('UPDATE report_ai_perf_days SET calls = ?, succeeded = ?, errors = ?, fallbacks = ?, streamed = ?,'
        + ' cache_hits = ?, tool_calls = ?, tokens_input = ?, tokens_output = ?, tokens_reasoning = ?, tokens_cache_read = ?,'
        + ' tokens_cache_write = ?, charged_usd = ?, list_cost_usd = ?, cache_saved_usd = ?, ttft_hist = ?::jsonb,'
        + ' latency_hist = ?::jsonb, tps_hist = ?::jsonb, errors_by_class = ?::jsonb, updated_at = now() WHERE ' + KEY_WHERE)
        .run(int(current.calls) + 1,
            int(current.succeeded) + (succeeded ? 1 : 0),
            int(current.errors) + (failed ? 1 : 0),
            int(current.fallbacks) + (num(p.fallbacks) > 0 ? 1 : 0),
            int(current.streamed) + (p.streamed === true ? 1 : 0),
            int(current.cache_hits) + (p.cache_hit === true ? 1 : 0),
            int(current.tool_calls) + int(p.tool_calls),
            int(current.tokens_input) + int(p.input),
            int(current.tokens_output) + int(p.output),
            int(current.tokens_reasoning) + int(p.reasoning),
            int(current.tokens_cache_read) + int(p.cache_read),
            int(current.tokens_cache_write) + int(p.cache_write),
            money(num(current.charged_usd) + num(p.charged_usd)),
            money(num(current.list_cost_usd) + num(p.list_cost_usd)),
            money(num(current.cache_saved_usd) + num(p.cache_saved_usd)),
            JSON.stringify(ttft), JSON.stringify(latency), JSON.stringify(tps), JSON.stringify(errors),
            ...key);
    return true;
}

/**
 * Rebuild one (day, task kind, system) row of report_ai_task_days from the raw calls of that day. Called after a
 * task call is inserted. The task's cost is the sum of its calls' charged_usd and its time is task_ms when any call
 * gives it, else the sum of the calls' latency_ms.
 */
async function recordTask(t, payload, day) {
    const p = payload && typeof payload === 'object' ? payload : {};
    const taskId = p.task_id == null ? '' : String(p.task_id).trim();
    if (!taskId) return false;
    const taskDay = day || dayOf(p.at || new Date().toISOString());
    const task = text(p.task, 120);
    const system = text(p.system || 'ai', 100);
    const rows = await t.prepare('SELECT COUNT(*)::bigint AS calls, SUM(charged_usd) AS cost,'
        + ' CASE WHEN MAX(task_ms) IS NOT NULL THEN MAX(task_ms) ELSE SUM(COALESCE(latency_ms, 0)) END AS time'
        + ' FROM report_ai_usage WHERE day = ?::date AND task = ? AND system = ? AND task_id IS NOT NULL AND task_id <> \'\''
        + ' GROUP BY task_id').all(taskDay, task, system);
    const costHist = zeroHist();
    const timeHist = zeroHist();
    for (const r of rows) {
        bump(costHist, num(r.cost), HISTOGRAM_BOUNDS.task_cost_usd);
        bump(timeHist, num(r.time), HISTOGRAM_BOUNDS.task_time_ms);
    }
    await t.prepare('INSERT INTO report_ai_task_days (day, task, system, tasks, cost_hist, time_hist)'
        + ' VALUES (?::date, ?, ?, ?, ?::jsonb, ?::jsonb)'
        + ' ON CONFLICT (day, task, system) DO UPDATE SET tasks = excluded.tasks, cost_hist = excluded.cost_hist,'
        + ' time_hist = excluded.time_hist, updated_at = now()')
        .run(taskDay, task, system, rows.length, JSON.stringify(costHist), JSON.stringify(timeHist));
    return true;
}

/** The day bounds of a from/to pair; missing ones are the last 30 days ending today. */
function rangeOf(from, to, now) {
    const today = dayOf(now == null ? Date.now() : now);
    const toDay = to == null || to === '' ? today : String(to).slice(0, 10);
    const fromDay = from == null || from === '' ? addDays(toDay, -(DEFAULT_RANGE_DAYS - 1)) : String(from).slice(0, 10);
    for (const [name, value] of [['from', fromDay], ['to', toDay]]) {
        const d = new Date(`${value}T00:00:00Z`);
        if (!dateRegex.test(value) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
            throw new RangeError(name + ' must be a day (YYYY-MM-DD)');
        }
    }
    if (fromDay > toDay) throw new RangeError('from must be on or before to');
    if (Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`) > MAX_RANGE_DAYS * DAY_MS) {
        throw new RangeError('the range must be at most ' + MAX_RANGE_DAYS + ' days');
    }
    return { from: fromDay, to: toDay };
}

const emptyAgg = () => ({
    calls: 0, succeeded: 0, errors: 0, fallbacks: 0, streamed: 0, cache_hits: 0, tool_calls: 0,
    tokens_input: 0, tokens_output: 0, tokens_reasoning: 0, tokens_cache_read: 0, tokens_cache_write: 0,
    charged_usd: 0, list_cost_usd: 0, cache_saved_usd: 0,
    ttft: zeroHist(), latency: zeroHist(), tps: zeroHist(), errors_by_class: {},
});

/** Add one report_ai_perf_days row into a group's aggregate. */
function addPerf(agg, r) {
    agg.calls += int(r.calls);
    agg.succeeded += int(r.succeeded);
    agg.errors += int(r.errors);
    agg.fallbacks += int(r.fallbacks);
    agg.streamed += int(r.streamed);
    agg.cache_hits += int(r.cache_hits);
    agg.tool_calls += int(r.tool_calls);
    agg.tokens_input += int(r.tokens_input);
    agg.tokens_output += int(r.tokens_output);
    agg.tokens_reasoning += int(r.tokens_reasoning);
    agg.tokens_cache_read += int(r.tokens_cache_read);
    agg.tokens_cache_write += int(r.tokens_cache_write);
    agg.charged_usd += num(r.charged_usd);
    agg.list_cost_usd += num(r.list_cost_usd);
    agg.cache_saved_usd += num(r.cache_saved_usd);
    mergeHist(agg.ttft, asHist(r.ttft_hist));
    mergeHist(agg.latency, asHist(r.latency_hist));
    mergeHist(agg.tps, asHist(r.tps_hist));
    for (const [k, v] of Object.entries(asMap(r.errors_by_class))) agg.errors_by_class[k] = (agg.errors_by_class[k] || 0) + int(v);
    return agg;
}

/** The top five error classes of an aggregate, most frequent first, the class name breaking ties. */
function topErrors(map) {
    return Object.entries(map)
        .filter(([, n]) => int(n) > 0)
        .sort(([ak, an], [bk, bn]) => (int(bn) - int(an)) || (ak < bk ? -1 : ak > bk ? 1 : 0))
        .slice(0, 5)
        .map(([error_class, count]) => ({ error_class: error_class.slice(0, 60), count: int(count) }));
}

/** One row of report.ai-performance@1: the rates, the histograms' percentiles, the tokens, the cost and the errors. */
function rowOf(group, key, agg, range) {
    const calls = int(agg.calls);
    const input = int(agg.tokens_input);
    const output = int(agg.tokens_output);
    const cacheRead = int(agg.tokens_cache_read);
    const cacheWrite = int(agg.tokens_cache_write);
    const prompt = input + cacheRead + cacheWrite;
    const charged = money(agg.charged_usd);
    const row = {
        group,
        key: String(key == null ? '' : key).slice(0, 200),
        range: { from: range.from, to: range.to },
        calls,
        succeeded: int(agg.succeeded),
        errors: int(agg.errors),
        success_rate: calls ? round(int(agg.succeeded) / calls) : null,
        fallback_rate: calls ? round(int(agg.fallbacks) / calls) : null,
        streamed_share: calls ? round(int(agg.streamed) / calls) : null,
        cache_hit_rate: calls ? round(int(agg.cache_hits) / calls) : null,
        cache_read_share: prompt ? round(cacheRead / prompt) : null,
        ttft_ms: summary(agg.ttft, HISTOGRAM_BOUNDS.ttft),
        latency_ms: summary(agg.latency, HISTOGRAM_BOUNDS.latency),
        tps: summary(agg.tps, HISTOGRAM_BOUNDS.tps),
        tokens: { input, output, reasoning: int(agg.tokens_reasoning), cache_read: cacheRead, cache_write: cacheWrite },
        cost: {
            charged_usd: charged,
            list_usd: money(agg.list_cost_usd),
            cache_saved_usd: money(agg.cache_saved_usd),
            per_call_usd: calls ? money(agg.charged_usd / calls) : null,
            per_million_output_usd: output > 0 ? money((agg.charged_usd / output) * 1e6) : null,
        },
        top_errors: topErrors(agg.errors_by_class),
    };
    if (group === 'provider') row.provider = row.key ? row.key.slice(0, 120) : null;
    return row;
}

/** The task roll-up rows of a group (task or system), merged across days. */
async function taskAggregates(store, { group, range, filters }) {
    const column = GROUPS[group];
    const where = ['day >= ?::date', 'day <= ?::date'];
    const args = [range.from, range.to];
    if (filters && filters.system != null && filters.system !== '') { where.push('system = ?'); args.push(String(filters.system)); }
    if (filters && filters.task != null && filters.task !== '') { where.push('task = ?'); args.push(String(filters.task)); }
    const rows = await store.db.prepare('SELECT ' + column + ' AS bucket, tasks, cost_hist, time_hist FROM report_ai_task_days'
        + ' WHERE ' + where.join(' AND ')).all(...args);
    const map = new Map();
    for (const r of rows) {
        const key = String(r.bucket == null ? '' : r.bucket).slice(0, 200);
        let agg = map.get(key);
        if (!agg) { agg = { count: 0, cost: zeroHist(), time: zeroHist() }; map.set(key, agg); }
        agg.count += int(r.tasks);
        mergeHist(agg.cost, asHist(r.cost_hist));
        mergeHist(agg.time, asHist(r.time_hist));
    }
    return map;
}

/** One task aggregate as report.ai-performance@1's tasks object. */
function tasksOf(agg) {
    return {
        count: int(agg && agg.count),
        cost_per_task_usd: summary(agg ? agg.cost : zeroHist(), HISTOGRAM_BOUNDS.task_cost_usd),
        time_per_task_ms: summary(agg ? agg.time : zeroHist(), HISTOGRAM_BOUNDS.task_time_ms),
    };
}

/**
 * The performance rows of one group. `filters` is an object of group columns to exact values (the route allows the
 * public three for anyone and all of them for staff). `minCalls` drops a group below the floor (the public route
 * passes 20). Rows come biggest first. Task cost/time is added when the group is task or system and no filter
 * reaches a column the task table does not keep.
 */
async function performance(store, { group = 'model', from = null, to = null, filters = {}, minCalls = 0, now } = {}) {
    const column = GROUPS[group];
    if (!column) throw new RangeError('group must be one of ' + PERFORMANCE_GROUPS.join(', '));
    const range = rangeOf(from, to, now);
    const where = ['day >= ?::date', 'day <= ?::date'];
    const args = [range.from, range.to];
    for (const [key, raw] of Object.entries(filters || {})) {
        if (!FILTERS.includes(key)) throw new RangeError('filter must be one of ' + FILTERS.join(', '));
        if (raw == null || raw === '') continue;
        const value = String(raw);
        if (value.length > 200) throw new RangeError('a filter is too long');
        where.push(key + ' = ?');
        args.push(value);
    }
    const rows = await store.db.prepare('SELECT ' + column + ' AS bucket, calls, succeeded, errors, fallbacks, streamed,'
        + ' cache_hits, tool_calls, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,'
        + ' charged_usd, list_cost_usd, cache_saved_usd, ttft_hist, latency_hist, tps_hist, errors_by_class'
        + ' FROM report_ai_perf_days WHERE ' + where.join(' AND ')).all(...args);
    const aggregates = new Map();
    for (const r of rows) {
        const key = String(r.bucket == null ? '' : r.bucket).slice(0, 200);
        let agg = aggregates.get(key);
        if (!agg) { agg = emptyAgg(); aggregates.set(key, agg); }
        addPerf(agg, r);
    }
    const taskGroups = (group === 'task' || group === 'system')
        && Object.keys(filters || {}).every((k) => k === 'system' || k === 'task')
        ? await taskAggregates(store, { group, range, filters: filters || {} })
        : null;
    const out = [];
    for (const [key, agg] of aggregates) {
        if (int(agg.calls) < Math.max(0, int(minCalls))) continue;
        const row = rowOf(group, key, agg, range);
        if (taskGroups) row.tasks = tasksOf(taskGroups.get(key));
        out.push(row);
    }
    out.sort((a, b) => (b.calls - a.calls) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return out;
}

module.exports = {
    BUCKET_COUNT, HISTOGRAM_BOUNDS, PUBLIC_CALL_FLOOR, GROUPS, PERFORMANCE_GROUPS, PUBLIC_GROUPS, STAFF_GROUPS,
    FILTERS, PUBLIC_FILTERS, logBounds, bucketOf, zeroHist, bump, asHist, mergeHist, asMap, percentile, summary,
    recordPerformance, recordTask, performance, rangeOf, rowOf, tasksOf,
};
