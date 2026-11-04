'use strict';
/**
 * AI Exchange analytics (plan G-P9): the settlements OpenVibe.Billing posts, summed by UTC day, resolved exact model
 * id and provider access.
 *
 * The event is `billing.credit.settled` (OpenVibe.Contracts v0.287.0, payload `billing.credit.settled@1`). Report
 * reads the authorities and keeps only aggregates: requests, sandbox requests, the four token counts, the retail
 * charge, the shortfall, the supply cost and the margin (retail minus supply). A settlement is counted once by its
 * settlement id, so a redelivered event — even under a new event id — changes nothing. No person, no project, no
 * prompt and no answer is written here, and Report never sets a rate, a price or a balance.
 *
 * The payload is validated against the contract before it is counted: an invalid one is counted as rejected and never
 * aggregated. Sandbox settlements (`sandbox: true`) are not money: they only increment `sandbox_requests`.
 */

const contracts = require('openvibe-contracts');

const TOPIC = 'billing.credit.settled';
const CONTRACT = 'billing.credit.settled@1';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;
const DEFAULT_RANGE_DAYS = 30;
const MAX_RANGE_DAYS = 400;

const isSettlementTopic = (topic) => String(topic || '') === TOPIC;

/** The UTC day of an ISO timestamp, or null. */
function dayOf(value) {
    if (value == null || value === '') return null;
    if (typeof value === 'string' && DAY.test(value)) return value;
    const t = value instanceof Date ? value.getTime() : (typeof value === 'number' ? value : Date.parse(String(value)));
    return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

/** A DB bigint (BigInt in PGlite, a string in node-postgres) as a decimal string; money never passes through Number. */
const big = (v) => {
    if (v == null) return null;
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'string' && /^-?[0-9]+$/.test(v)) return v;
    if (Number.isSafeInteger(v)) return String(v);
    throw new TypeError('a bigint column did not arrive as an exact integer');
};
const whole = (v) => Number(v || 0);

/** Does this payload match `billing.credit.settled@1`? Unknown ids and malformed values are invalid, never thrown. */
function validSettlement(payload) {
    try {
        const r = contracts.validate(CONTRACT, payload);
        return Boolean(r && r.valid === true);
    } catch { return false; }
}

/**
 * The model is the part of `deployment_id` after the first ":" ("own:qwen/qwen3-4b:q4_k_m@3f2a1c9" →
 * "qwen/qwen3-4b:q4_k_m@3f2a1c9"). A null deployment id is unknown; so is a value with no model part.
 */
function modelOf(deploymentId) {
    if (deploymentId == null) return 'unknown';
    const s = String(deploymentId);
    const i = s.indexOf(':');
    const model = i >= 0 ? s.slice(i + 1).trim() : '';
    return model ? model.slice(0, 256) : 'unknown';
}

const changed = (r) => Number(r && (r.changes != null ? r.changes : r.rowCount)) || 0;

/** Count an invalid settlement by the day it claims, so it is visible and still never aggregated. */
async function reject(t, day, reason = 'invalid') {
    await t.prepare(`INSERT INTO report_ai_exchange_rejected (day, reason, events) VALUES (?::date, ?, 1)
        ON CONFLICT (day, reason) DO UPDATE SET events = report_ai_exchange_rejected.events + 1, updated_at = now()`)
        .run(day, reason);
}

/**
 * Count one settlement inside the delivery's own transaction. Validation comes first: an invalid payload is counted
 * as rejected and nothing else is written. Then the settlement id is claimed; a replay returns
 * `settlement:duplicate`. A sandbox settlement only increments `sandbox_requests`.
 */
async function recordSettlement(t, payload, { occurredAt = null, now = Date.now() } = {}) {
    const p = payload && typeof payload === 'object' ? payload : {};
    const at = dayOf(p.settled_at) || dayOf(occurredAt) || dayOf(now) || new Date(now).toISOString().slice(0, 10);
    if (!validSettlement(p)) {
        await reject(t, at);
        return 'settlement:rejected';
    }
    const claim = await t.prepare('INSERT INTO report_ai_exchange_seen (settlement_id, day) VALUES (?, ?::date) ON CONFLICT (settlement_id) DO NOTHING')
        .run(p.settlement_id, at);
    if (!changed(claim)) return 'settlement:duplicate';
    const model = modelOf(p.deployment_id);
    const access = p.provider_access || 'unknown';
    if (p.sandbox === true) {
        await t.prepare(`INSERT INTO report_ai_exchange_days (day, model, provider_access, sandbox_requests)
            VALUES (?::date, ?, ?, 1)
            ON CONFLICT (day, model, provider_access) DO UPDATE SET
                sandbox_requests = report_ai_exchange_days.sandbox_requests + 1,
                updated_at = now()`)
            .run(at, model, access);
        return 'settlement:recorded';
    }
    await t.prepare(`INSERT INTO report_ai_exchange_days
        (day, model, provider_access, requests, tokens_input, tokens_cached_read, tokens_cache_write, tokens_output,
         retail_nano_usd, shortfall_nano_usd, supply_nano_usd)
        VALUES (?::date, ?, ?, 1, ?::bigint, ?::bigint, ?::bigint, ?::bigint, ?::bigint, ?::bigint, ?::bigint)
        ON CONFLICT (day, model, provider_access) DO UPDATE SET
            requests = report_ai_exchange_days.requests + 1,
            tokens_input = report_ai_exchange_days.tokens_input + excluded.tokens_input,
            tokens_cached_read = report_ai_exchange_days.tokens_cached_read + excluded.tokens_cached_read,
            tokens_cache_write = report_ai_exchange_days.tokens_cache_write + excluded.tokens_cache_write,
            tokens_output = report_ai_exchange_days.tokens_output + excluded.tokens_output,
            retail_nano_usd = report_ai_exchange_days.retail_nano_usd + excluded.retail_nano_usd,
            shortfall_nano_usd = report_ai_exchange_days.shortfall_nano_usd + excluded.shortfall_nano_usd,
            supply_nano_usd = report_ai_exchange_days.supply_nano_usd + excluded.supply_nano_usd,
            updated_at = now()`)
        .run(at, model, access, String(p.usage.input_tokens), String(p.usage.cached_read_tokens),
            String(p.usage.cache_write_tokens), String(p.usage.output_tokens), p.charge_nano_usd,
            p.shortfall_nano_usd, p.supply_cost_nano_usd);
    return 'settlement:recorded';
}

/** A day range for an answer: the last 30 days by default, 400 at most. An impossible pair throws a RangeError. */
function range({ from = null, to = null, now = Date.now() } = {}) {
    const today = dayOf(now);
    const toDay = to == null || to === '' ? today : dayOf(String(to).slice(0, 10));
    if (!toDay) throw new RangeError('to must be a day (YYYY-MM-DD)');
    let fromDay = from == null || from === '' ? addDays(toDay, -(DEFAULT_RANGE_DAYS - 1)) : dayOf(String(from).slice(0, 10));
    if (!fromDay) throw new RangeError('from must be a day (YYYY-MM-DD)');
    if (fromDay > toDay) throw new RangeError('from must be on or before to');
    const earliest = addDays(toDay, -(MAX_RANGE_DAYS - 1));
    if (fromDay < earliest) fromDay = earliest;
    return { from: fromDay, to: toDay, days: daysBetween(fromDay, toDay) + 1 };
}

/** The rows of a range, exact. Money leaves as decimal strings; counts as numbers. */
async function rows(store, { from, to }) {
    // Every bigint is selected as text: the SDK's int8 parser refuses a value beyond 2^53 rather than rounding it,
    // and money must never pass through a float.
    const out = await store.db.prepare(`SELECT day::text AS day, model, provider_access, requests::text AS requests,
        sandbox_requests::text AS sandbox_requests,
        tokens_input::text AS tokens_input, tokens_cached_read::text AS tokens_cached_read,
        tokens_cache_write::text AS tokens_cache_write, tokens_output::text AS tokens_output,
        retail_nano_usd::text AS retail_nano_usd, shortfall_nano_usd::text AS shortfall_nano_usd,
        supply_nano_usd::text AS supply_nano_usd, margin_nano_usd::text AS margin_nano_usd
        FROM report_ai_exchange_days WHERE day >= ?::date AND day <= ?::date
        ORDER BY day, model, provider_access`).all(from, to);
    return out.map((r) => ({
        day: String(r.day).slice(0, 10),
        model: String(r.model || 'unknown'),
        provider_access: String(r.provider_access || 'unknown'),
        requests: whole(r.requests),
        sandbox_requests: whole(r.sandbox_requests),
        tokens: {
            input: whole(r.tokens_input),
            cached_read: whole(r.tokens_cached_read),
            cache_write: whole(r.tokens_cache_write),
            output: whole(r.tokens_output),
        },
        retail_nano_usd: big(r.retail_nano_usd),
        shortfall_nano_usd: big(r.shortfall_nano_usd),
        supply_nano_usd: big(r.supply_nano_usd),
        margin_nano_usd: big(r.margin_nano_usd),
    }));
}

/** The invalid settlements of the range, by day. */
async function rejectedOf(store, { from, to }) {
    const list = await store.db.prepare(`SELECT day::text AS day, SUM(events)::text AS events
        FROM report_ai_exchange_rejected WHERE day >= ?::date AND day <= ?::date
        GROUP BY day ORDER BY day`).all(from, to);
    const by_day = list.map((r) => ({ day: String(r.day).slice(0, 10), events: whole(r.events) }));
    return { count: by_day.reduce((n, r) => n + r.events, 0), by_day };
}

/** Add rows into one total, using BigInt for money. */
function totalOf(list) {
    const t = { requests: 0, sandbox_requests: 0, tokens: { input: 0, cached_read: 0, cache_write: 0, output: 0 }, retail: 0n, shortfall: 0n, supply: 0n };
    for (const r of list) {
        t.requests += r.requests;
        t.sandbox_requests += r.sandbox_requests;
        for (const k of Object.keys(t.tokens)) t.tokens[k] += r.tokens[k];
        t.retail += BigInt(r.retail_nano_usd);
        t.shortfall += BigInt(r.shortfall_nano_usd);
        t.supply += BigInt(r.supply_nano_usd);
    }
    return {
        requests: t.requests,
        sandbox_requests: t.sandbox_requests,
        tokens: { ...t.tokens },
        retail_nano_usd: t.retail.toString(),
        shortfall_nano_usd: t.shortfall.toString(),
        supply_nano_usd: t.supply.toString(),
        margin_nano_usd: (t.retail - t.supply).toString(),
    };
}

/** The day totals for the chart, from the same rows. */
function dailyOf(list) {
    const map = new Map();
    for (const r of list) {
        let d = map.get(r.day);
        if (!d) { d = { day: r.day, requests: 0, sandbox_requests: 0, retail: 0n, shortfall: 0n, supply: 0n }; map.set(r.day, d); }
        d.requests += r.requests;
        d.sandbox_requests += r.sandbox_requests;
        d.retail += BigInt(r.retail_nano_usd);
        d.shortfall += BigInt(r.shortfall_nano_usd);
        d.supply += BigInt(r.supply_nano_usd);
    }
    return [...map.values()].sort((a, b) => (a.day < b.day ? -1 : 1)).map((d) => ({
        day: d.day,
        requests: d.requests,
        sandbox_requests: d.sandbox_requests,
        retail_nano_usd: d.retail.toString(),
        shortfall_nano_usd: d.shortfall.toString(),
        supply_nano_usd: d.supply.toString(),
        margin_nano_usd: (d.retail - d.supply).toString(),
    }));
}

/** One answer: the range, the rows, the day totals, the totals and the rejected count. */
async function analytics(store, opts = {}) {
    const r = range(opts);
    const list = await rows(store, r);
    return { range: r, rows: list, daily: dailyOf(list), totals: totalOf(list), rejected: await rejectedOf(store, r) };
}

/** The Exchange ledger as one object: the event consumer and the read routes share it. */
function createAiExchange({ store, now = () => Date.now(), log = console } = {}) {
    if (!store) return null;
    return {
        store,
        topic: TOPIC,
        record: (t, payload, opts = {}) => recordSettlement(t, payload, { now: now(), ...opts }),
        analytics: (opts = {}) => analytics(store, { now: now(), ...opts }),
        log,
    };
}

module.exports = {
    TOPIC, CONTRACT, isSettlementTopic, validSettlement, modelOf, recordSettlement, range, rows, rejectedOf,
    totalOf, dailyOf, analytics, createAiExchange,
};
