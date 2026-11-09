'use strict';

/**
 * What people do now, for the front door and a person's "Try next" (plan L43, 2026-11-09).
 *
 *   popular()   the ranked destinations (sites and tools) from Report's own numbers: opens today and over seven
 *               days, the seven before that for growth, and the distinct signed-in people Network counted. The
 *               answer never names a person: it is counts and public labels only.
 *   coUsage()   which sites appear together in the site lists people chose to publish (report_me_stats.published
 *               sites is the opt-in; a row whose switch is false is never read). Aggregate pair counts only, and a
 *               pair is left out below MIN_PEOPLE so a small group cannot be traced back to a person.
 *
 * Both are held for five minutes: the numbers change when Network's five-minute stats cache changes, not sooner.
 * A table that has no rows is an empty answer, never a made-up zero; the caller falls back to its own fixed list.
 */
const { reportStats } = require('./analytics/query');

const TTL_MS = 5 * 60 * 1000;
const MIN_PEOPLE = 3;
const MAX_PAIRS = 500;
const MAX_LIMIT = 20;

const n = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const clampLimit = (v, fallback = 5) => Math.min(MAX_LIMIT, Math.max(1, parseInt(v, 10) || fallback));
const change = (now, before) => (before > 0 && now != null ? Math.round(((now - before) / before) * 100) : null);
const words = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
const httpsUrl = (v) => {
    try { const u = new URL(String(v || '')); return u.protocol === 'https:' ? u.href : null; } catch { return null; }
};
const idOf = (v) => (/^[a-z0-9][a-z0-9-]{0,39}$/.test(String(v || '')) ? String(v) : null);

function lastDaily(daily) {
    return Array.isArray(daily) && daily.length ? n(daily[daily.length - 1].n) : null;
}

/** One destination in the shape both lists use: a label, a URL, an icon id, a reason, and the numbers behind them. */
function destination(kind, row) {
    const id = idOf(row && row.id);
    const url = httpsUrl(row && (row.url || (row.host ? `https://${row.host}/` : null)));
    const name = words(row && (row.name || row.short || row.id), 80);
    if (!id || !url || !name) return null;
    const opens24 = n(row.opens_24h) ?? lastDaily(row.daily);
    const opens7 = n(row.opens_7d) ?? n(row.pageviews);
    const opensPrev7 = n(row.opens_prev_7d) ?? n(row.pageviews_prev);
    const uses24 = n(row.uses_24h);
    const uses7 = n(row.uses_7d);
    const growth = n(row.growth_7d_pct) ?? n(row.change_pct) ?? change(opens7, opensPrev7);
    // Page views lead; a person is worth five opens, so a small, clearly-used tool is not buried under one huge site.
    const score = (opens7 || 0) + (uses7 || 0) * 5;
    if (score <= 0) return null;
    return {
        id, kind, name, url,
        icon: idOf(row.icon) || id,
        score: Math.round(score),
        opens_24h: opens24, opens_7d: opens7, opens_prev_7d: opensPrev7,
        growth_7d_pct: growth, uses_24h: uses24, uses_7d: uses7,
    };
}

function reasonOf(item, topToday) {
    if (item.opens_24h != null && item.opens_24h > 0 && item.opens_24h === topToday) return 'Most used today';
    if (item.growth_7d_pct != null && item.growth_7d_pct >= 10 && (item.opens_7d || 0) > 0) return 'Rising this week';
    return 'Popular this week';
}

function createPopularity({ store = null, now = () => Date.now(), ttlMs = TTL_MS, minPeople = MIN_PEOPLE, statsOf = null, coRowsOf = null, log = console } = {}) {
    const db = store && store.db ? store.db : null;
    const clock = typeof now === 'function' ? now : () => Date.now();
    const stats = statsOf || ((days) => reportStats(store, days, { now: clock }));
    const coRows = coRowsOf || (async () => {
        if (!db) return null;
        return db.many(`SELECT snapshot FROM report_me_stats
            WHERE COALESCE(published->>'sites', 'false') = 'true' AND snapshot IS NOT NULL
            ORDER BY updated_at DESC LIMIT 5000`);
    });
    const cache = new Map();
    const inflight = new Map();

    function warn(what, err) {
        try { (log.warn || log.error || console.warn).call(log, `[OpenVibe.Report] ${what} failed: ${String((err && err.message) || err).replace(/\s+/g, ' ').slice(0, 200)}`); } catch { /* logging never fails an answer */ }
    }

    /** Five-minute memo: a promise is shared while it runs; a failure is not cached. */
    function memo(key, fn) {
        const hit = cache.get(key);
        if (hit && clock() - hit.at < ttlMs) return Promise.resolve(hit.value);
        if (inflight.has(key)) return inflight.get(key);
        const p = Promise.resolve().then(fn).then((value) => {
            cache.set(key, { at: clock(), value });
            return value;
        }).finally(() => inflight.delete(key));
        inflight.set(key, p);
        return p;
    }

    async function buildPopular() {
        if (!db && !statsOf) return null;
        let body;
        try { body = await stats(7); } catch (err) { warn('popular stats', err); return null; }
        if (!body || typeof body !== 'object') return null;
        const candidates = [];
        for (const site of Array.isArray(body.sites) ? body.sites : []) {
            if (!site || site.id === 'network') continue;   // the account desk is not a destination
            const item = destination('site', site);
            if (item) candidates.push(item);
        }
        for (const tool of Array.isArray(body.tools) ? body.tools : []) {
            const item = destination('tool', tool);
            if (item) candidates.push(item);
        }
        candidates.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
        const top = candidates.slice(0, 50);
        const topToday = top.reduce((best, item) => (item.opens_24h != null && item.opens_24h > best ? item.opens_24h : best), 0);
        const generatedAt = body.generated_at || new Date(clock()).toISOString();
        return {
            source: 'report',
            generated_at: generatedAt,
            window: {
                days: 7,
                today: new Date(clock()).toISOString().slice(0, 10),
                opens_24h: 'page views counted since 00:00 UTC today',
                uses_24h: 'distinct signed-in people in the last 24 hours',
                opens_7d: 'page views over the last seven days',
            },
            items: top.map((item) => ({ ...item, reason: reasonOf(item, topToday) })),
        };
    }

    async function popular({ limit = 5 } = {}) {
        const full = await memo('popular', buildPopular);
        if (!full) return null;
        return { ...full, items: full.items.slice(0, clampLimit(limit)) };
    }

    async function buildCoUsage() {
        if (!db && !coRowsOf) return null;
        const rows = await coRows();
        if (rows == null) return null;
        const counts = new Map();
        let sample = 0;
        for (const row of rows) {
            let snapshot = row && row.snapshot;
            if (typeof snapshot === 'string') { try { snapshot = JSON.parse(snapshot); } catch { snapshot = null; } }
            const month = snapshot && snapshot.sites && Array.isArray(snapshot.sites.month) ? snapshot.sites.month : [];
            const services = new Set();
            for (const entry of month) {
                const service = String((entry && entry.service) || '').trim().toLowerCase();
                if (/^[a-z0-9-]{1,32}$/.test(service) && service !== 'network') services.add(service);
            }
            if (services.size < 2) continue;
            sample += 1;
            const list = [...services].sort();
            for (let i = 0; i < list.length; i++) {
                for (let j = i + 1; j < list.length; j++) {
                    const key = `${list[i]}|${list[j]}`;
                    counts.set(key, (counts.get(key) || 0) + 1);
                }
            }
        }
        const pairs = [...counts.entries()]
            .map(([key, people]) => { const [a, b] = key.split('|'); return { a, b, people }; })
            .filter((p) => p.people >= minPeople)
            .sort((a, b) => b.people - a.people || a.a.localeCompare(b.a) || a.b.localeCompare(b.b))
            .slice(0, MAX_PAIRS);
        return {
            source: 'report',
            generated_at: new Date(clock()).toISOString(),
            sample_people: sample,
            min_people: minPeople,
            pairs,
        };
    }

    function coUsage() { return memo('co-usage', buildCoUsage); }

    return { popular, coUsage, ttlMs, minPeople, _clear() { cache.clear(); } };
}

module.exports = { createPopularity, TTL_MS, MIN_PEOPLE, destination, reasonOf };
