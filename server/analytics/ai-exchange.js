'use strict';
/**
 * AI Exchange analytics (plan G-P9): the settlements OpenVibe.Billing posts, summed by UTC day, resolved exact model
 * id and provider access.
 *
 * Report reads the authorities and keeps only aggregates: requests, the four token counts, the retail charge, the
 * supply cost and the margin (retail minus supply). A settlement is counted once by its settlement id, so a
 * redelivered event — even under a new event id — changes nothing. No person, no project, no prompt and no answer is
 * written here, and Report never sets a rate, a price or a balance.
 *
 * The payload is `billing.credit-settlement@1` (Contracts v0.284.0). That contract does not carry the resolved model
 * id, so this consumer reads `resolved_model` (or `model`) when the event adds it and otherwise counts the aggregate
 * under `unknown`; `provider_access` comes from the settlement's `attempts` (the last attempt that names one) or the
 * top-level field when present.
 */

const TOPICS = Object.freeze(['billing.credit.settled', 'billing.credit.settlement', 'billing.credit-settlement']);
const ACCESS = new Set(['OWN_DEPLOYMENT', 'AUTHORIZED_WHOLESALE', 'CUSTOMER_BYOK', 'RESTRICTED', 'UNVERIFIED']);
const NANO = /^[0-9]{1,19}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;
const DEFAULT_RANGE_DAYS = 30;
const MAX_RANGE_DAYS = 400;

const isSettlementTopic = (topic) => TOPICS.includes(String(topic || ''));

/** A decimal string of integer nano-USD (D1), or null. Numbers are refused: they are floats, never money. */
const nano = (v) => (typeof v === 'string' && NANO.test(v) ? v : null);
/** A non-negative safe token count, or null. */
const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
/** A non-empty trimmed text value, or null. */
const text = (v, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
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

/** The provider access of a settlement: the top-level value, else the last attempt that names one, else BYOK/unknown. */
function accessOf(p) {
    if (ACCESS.has(p.provider_access)) return p.provider_access;
    const attempts = Array.isArray(p.attempts) ? p.attempts : [];
    for (let i = attempts.length - 1; i >= 0; i -= 1) {
        const a = attempts[i];
        if (a && ACCESS.has(a.provider_access)) return a.provider_access;
    }
    return p.byok === true ? 'CUSTOMER_BYOK' : 'UNKNOWN';
}

/** The resolved exact model id: the event's own value when it carries one, else unknown (Report never guesses). */
function modelOf(p) {
    const direct = text(p.resolved_model) || text(p.model);
    if (direct) return direct;
    const attempts = Array.isArray(p.attempts) ? p.attempts : [];
    for (let i = attempts.length - 1; i >= 0; i -= 1) {
        const m = text(attempts[i] && (attempts[i].resolved_model || attempts[i].model));
        if (m) return m;
    }
    return 'unknown';
}

/**
 * One settlement's aggregate contribution, or null when the payload cannot be counted (no settlement id or no
 * exact retail amount). Missing supply is carried as null, never as zero.
 */
function settlementOf(payload, { occurredAt = null, now = Date.now() } = {}) {
    const p = payload && typeof payload === 'object' ? payload : {};
    const settlementId = text(p.settlement_id, 100);
    const retail = nano(p.charge_nano_usd);
    if (!settlementId || retail == null) return null;
    let supply = null;
    if (p.supply_cost_nano_usd != null) {
        supply = nano(p.supply_cost_nano_usd);
        if (supply == null) return null;   // a malformed amount must not be summed as zero
    }
    const u = p.usage && typeof p.usage === 'object' ? p.usage : {};
    const tokens = {
        input: u.input_tokens == null ? 0 : count(u.input_tokens),
        cached_read: u.cached_read_tokens == null ? 0 : count(u.cached_read_tokens),
        cache_write: u.cache_write_tokens == null ? 0 : count(u.cache_write_tokens),
        output: u.output_tokens == null ? 0 : count(u.output_tokens),
    };
    if (Object.values(tokens).some((v) => v == null)) return null;
    const day = dayOf(p.created_at) || dayOf(occurredAt) || dayOf(now) || new Date(now).toISOString().slice(0, 10);
    return { settlement_id: settlementId, day, model: modelOf(p), provider_access: accessOf(p), tokens, retail, supply };
}

const changed = (r) => Number(r && (r.changes != null ? r.changes : r.rowCount)) || 0;

/**
 * Count one settlement inside the delivery's own transaction. The settlement id is claimed first; a replay returns
 * `settlement:duplicate` and writes nothing. A malformed payload is `ignored:payload`, never a zero.
 */
async function recordSettlement(t, payload, { occurredAt = null, now = Date.now() } = {}) {
    const s = settlementOf(payload, { occurredAt, now });
    if (!s) return 'ignored:payload';
    const claim = await t.prepare('INSERT INTO report_ai_exchange_seen (settlement_id, day) VALUES (?, ?::date) ON CONFLICT (settlement_id) DO NOTHING')
        .run(s.settlement_id, s.day);
    if (!changed(claim)) return 'settlement:duplicate';
    await t.prepare(`INSERT INTO report_ai_exchange_days
        (day, model, provider_access, requests, tokens_input, tokens_cached_read, tokens_cache_write, tokens_output,
         retail_nano_usd, supply_nano_usd)
        VALUES (?::date, ?, ?, 1, ?::bigint, ?::bigint, ?::bigint, ?::bigint, ?::bigint, ?::bigint)
        ON CONFLICT (day, model, provider_access) DO UPDATE SET
            requests = report_ai_exchange_days.requests + 1,
            tokens_input = report_ai_exchange_days.tokens_input + excluded.tokens_input,
            tokens_cached_read = report_ai_exchange_days.tokens_cached_read + excluded.tokens_cached_read,
            tokens_cache_write = report_ai_exchange_days.tokens_cache_write + excluded.tokens_cache_write,
            tokens_output = report_ai_exchange_days.tokens_output + excluded.tokens_output,
            retail_nano_usd = report_ai_exchange_days.retail_nano_usd + excluded.retail_nano_usd,
            supply_nano_usd = CASE
                WHEN report_ai_exchange_days.supply_nano_usd IS NULL OR excluded.supply_nano_usd IS NULL THEN NULL
                ELSE report_ai_exchange_days.supply_nano_usd + excluded.supply_nano_usd END,
            updated_at = now()`)
        .run(s.day, s.model, s.provider_access, String(s.tokens.input), String(s.tokens.cached_read),
            String(s.tokens.cache_write), String(s.tokens.output), s.retail, s.supply);
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

const money = (v) => big(v);

/** The rows of a range, exact. Money leaves as decimal strings; counts as numbers. */
async function rows(store, { from, to }) {
    // Every bigint is selected as text: the SDK's int8 parser refuses a value beyond 2^53 rather than rounding it,
    // and money must never pass through a float.
    const out = await store.db.prepare(`SELECT day::text AS day, model, provider_access, requests::text AS requests,
        tokens_input::text AS tokens_input, tokens_cached_read::text AS tokens_cached_read,
        tokens_cache_write::text AS tokens_cache_write, tokens_output::text AS tokens_output,
        retail_nano_usd::text AS retail_nano_usd, supply_nano_usd::text AS supply_nano_usd,
        margin_nano_usd::text AS margin_nano_usd
        FROM report_ai_exchange_days WHERE day >= ?::date AND day <= ?::date
        ORDER BY day, model, provider_access`).all(from, to);
    return out.map((r) => ({
        day: String(r.day).slice(0, 10),
        model: String(r.model || 'unknown'),
        provider_access: String(r.provider_access || 'UNKNOWN'),
        requests: whole(r.requests),
        tokens: {
            input: whole(r.tokens_input),
            cached_read: whole(r.tokens_cached_read),
            cache_write: whole(r.tokens_cache_write),
            output: whole(r.tokens_output),
        },
        retail_nano_usd: money(r.retail_nano_usd),
        supply_nano_usd: r.supply_nano_usd == null ? null : money(r.supply_nano_usd),
        margin_nano_usd: r.margin_nano_usd == null ? null : money(r.margin_nano_usd),
    }));
}

/** Add rows into one total, using BigInt for money; supply is complete only when every row carried it. */
function totalOf(list) {
    const t = { requests: 0, tokens: { input: 0, cached_read: 0, cache_write: 0, output: 0 }, retail: 0n, supply: 0n, supply_complete: true };
    for (const r of list) {
        t.requests += r.requests;
        for (const k of Object.keys(t.tokens)) t.tokens[k] += r.tokens[k];
        t.retail += BigInt(r.retail_nano_usd);
        if (r.supply_nano_usd == null) t.supply_complete = false;
        else t.supply += BigInt(r.supply_nano_usd);
    }
    return {
        requests: t.requests,
        tokens: { ...t.tokens },
        retail_nano_usd: t.retail.toString(),
        supply_nano_usd: t.supply_complete ? t.supply.toString() : null,
        margin_nano_usd: t.supply_complete ? (t.retail - t.supply).toString() : null,
        supply_complete: t.supply_complete,
    };
}

/** The day totals for the chart, from the same rows. */
function dailyOf(list) {
    const map = new Map();
    for (const r of list) {
        let d = map.get(r.day);
        if (!d) { d = { day: r.day, requests: 0, retail: 0n, supply: 0n, supply_complete: true }; map.set(r.day, d); }
        d.requests += r.requests;
        d.retail += BigInt(r.retail_nano_usd);
        if (r.supply_nano_usd == null) d.supply_complete = false;
        else d.supply += BigInt(r.supply_nano_usd);
    }
    return [...map.values()].sort((a, b) => (a.day < b.day ? -1 : 1)).map((d) => ({
        day: d.day,
        requests: d.requests,
        retail_nano_usd: d.retail.toString(),
        supply_nano_usd: d.supply_complete ? d.supply.toString() : null,
        margin_nano_usd: d.supply_complete ? (d.retail - d.supply).toString() : null,
    }));
}

/** One answer: the range, the rows, the day totals and the totals. */
async function analytics(store, opts = {}) {
    const r = range(opts);
    const list = await rows(store, r);
    return { range: r, rows: list, daily: dailyOf(list), totals: totalOf(list) };
}

/** The Exchange ledger as one object: the event consumer and the read routes share it. */
function createAiExchange({ store, now = () => Date.now(), log = console } = {}) {
    if (!store) return null;
    return {
        store,
        topics: TOPICS,
        record: (t, payload, opts = {}) => recordSettlement(t, payload, { now: now(), ...opts }),
        analytics: (opts = {}) => analytics(store, { now: now(), ...opts }),
        log,
    };
}

module.exports = {
    TOPICS, isSettlementTopic, settlementOf, recordSettlement, range, rows, totalOf, dailyOf, analytics,
    createAiExchange,
};
