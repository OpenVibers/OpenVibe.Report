'use strict';

/**
 * Report's read side: the same numbers Network answers, computed from Report's own tables.
 *
 *   reportStats(days)     GET /api/v1/stats' shape: network totals, sites, accounts, OpenCoins, Live and day series
 *   channelStats(channel) creator analytics from the live.stream.ended events, plus Billing's revenue read
 *   metrics(scope,id)     the flat report.metric@1 rows the shadow job and operators inspect
 *
 * Window totals come from the source's own window answer when it published one (report_metric_windows); a day
 * series is summed from report_metric_days; a channel is aggregated from report_streams. A number that is not
 * present is null / left out, never a made-up zero.
 */
const { normaliseDays } = require('../data/source');

const DAY = 86_400_000;
const NOTE = 'Counts only, never about a person. Page views come from the shared navbar\'s anonymous counter (day and site) and OpenVibe.Live\'s own analytics; traffic is over 24 hours.';
const SCOPES = new Set(['network', 'site', 'channel', 'stream']);

const n = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const round1 = (v) => Math.round(v * 10) / 10;
const change = (now, before) => (before > 0 && now != null ? Math.round(((now - before) / before) * 100) : null);
const sumOrNull = (values) => { let any = false; let total = 0; for (const v of values) if (v != null) { any = true; total += v; } return any ? total : null; };

function windowOf(nowMs, days) {
    return {
        currentStart: dayOf(nowMs - (days - 1) * DAY),
        currentEnd: dayOf(nowMs),
        prevStart: dayOf(nowMs - (2 * days - 1) * DAY),
        prevEnd: dayOf(nowMs - days * DAY),
        days: Array.from({ length: days }, (_, i) => dayOf(nowMs - (days - 1 - i) * DAY)),
    };
}

function indexRows(rows, winRows, jsonRows) {
    const day = new Map();
    for (const r of rows) {
        const key = `${r.scope}|${r.scope_id}|${r.metric}`;
        let m = day.get(key);
        if (!m) { m = new Map(); day.set(key, m); }
        m.set(r.day, { value: n(r.value), unit: r.unit, source: r.source });
    }
    const win = new Map();
    for (const r of winRows) win.set(`${r.scope}|${r.scope_id}|${r.metric}`, { value: n(r.value), unit: r.unit, source: r.source });
    const json = new Map();
    for (const r of jsonRows) json.set(`${r.scope}|${r.scope_id}|${r.metric}`, r.value);
    return { day, win, json };
}

async function loadIndex(store, days, nowMs) {
    const w = windowOf(nowMs, days);
    const rows = await store.db.many(`SELECT metric, scope, scope_id, day::text AS day, value, unit, source FROM report_metric_days WHERE day >= $1`, [w.prevStart]);
    const winRows = await store.db.many(`SELECT metric, scope, scope_id, window_days, value, unit, source FROM report_metric_windows WHERE window_days = $1`, [days]);
    const jsonRows = await store.db.many(`SELECT metric, scope, scope_id, window_days, value, source FROM report_metric_json WHERE window_days = $1`, [days]);
    const dims = await store.db.many(`SELECT kind, id, doc FROM report_dimensions`);
    return { rows, winRows, jsonRows, dims, w, ...indexRows(rows, winRows, jsonRows) };
}

function dayGet(idx, metric, scope, id, day) {
    const m = idx.day.get(`${scope}|${id}|${metric}`);
    return m && m.get(day) ? m.get(day).value : null;
}
function dayHas(idx, metric, scope, id) {
    const m = idx.day.get(`${scope}|${id}|${metric}`);
    return !!m && m.size > 0;
}
function daySum(idx, metric, scope, id, from, to) {
    const m = idx.day.get(`${scope}|${id}|${metric}`);
    if (!m) return null;
    let total = 0;
    let seen = false;
    for (const [day, v] of m) {
        if (day >= from && day <= to) { total += v.value || 0; seen = true; }
    }
    return seen ? total : null;
}
function daySeries(idx, metric, scope, id, days) {
    return days.map((day) => ({ day, n: dayGet(idx, metric, scope, id, day) || 0 }));
}
function winGet(idx, metric, scope, id) {
    const r = idx.win.get(`${scope}|${id}|${metric}`);
    return r ? r.value : null;
}
function winHas(idx, scope, id) {
    for (const key of idx.win.keys()) if (key.startsWith(`${scope}|${id}|`)) return true;
    return false;
}

/** GET /api/v1/stats' shape, from Report's tables. Null when no number exists for the window. */
async function reportStats(store, days = 30, { now = () => Date.now() } = {}) {
    if (!store || !store.db) return null;
    const windowDays = normaliseDays(days);
    const nowMs = now();
    const idx = await loadIndex(store, windowDays, nowMs);
    const w = idx.w;
    const anyCurrentDay = idx.rows.some((r) => r.day >= w.currentStart && r.day <= w.currentEnd);
    if (!anyCurrentDay && !idx.winRows.length && !idx.jsonRows.length) return null;

    const dimOf = (kind, id) => {
        const d = idx.dims.find((x) => x.kind === kind && x.id === id);
        return d && d.doc ? d.doc : null;
    };
    const siteIds = new Set();
    for (const r of idx.rows) if (r.scope === 'site' && r.day >= w.currentStart) siteIds.add(r.scope_id);
    for (const r of idx.winRows) if (r.scope === 'site') siteIds.add(r.scope_id);
    for (const d of idx.dims) if (d.kind === 'site') siteIds.add(d.id);

    const sites = [];
    for (const id of siteIds) {
        const meta = dimOf('site', id) || { id, name: id, short: id };
        const hasDaily = dayHas(idx, 'pageviews', 'site', id);
        const hasAny = hasDaily || winHas(idx, 'site', id);
        if (!hasAny) continue;
        const pageviews = winGet(idx, 'pageviews', 'site', id) ?? daySum(idx, 'pageviews', 'site', id, w.currentStart, w.currentEnd);
        const prev = winGet(idx, 'pageviews_prev', 'site', id) ?? daySum(idx, 'pageviews', 'site', id, w.prevStart, w.prevEnd);
        const pct = winGet(idx, 'change_pct', 'site', id) ?? change(pageviews, prev);
        const traffic = (winGet(idx, 'traffic_requests', 'site', id) != null || winGet(idx, 'traffic_p95_ms', 'site', id) != null)
            ? {
                requests: winGet(idx, 'traffic_requests', 'site', id),
                server_errors: winGet(idx, 'traffic_server_errors', 'site', id),
                p95_ms: winGet(idx, 'traffic_p95_ms', 'site', id),
            } : null;
        sites.push({
            ...meta,
            pageviews: pageviews == null ? null : pageviews,
            pageviews_prev: prev == null ? null : prev,
            change_pct: pct,
            daily: hasDaily ? daySeries(idx, 'pageviews', 'site', id, w.days) : null,
            ...(winGet(idx, 'unique_visitors', 'site', id) != null ? { unique_visitors: winGet(idx, 'unique_visitors', 'site', id) } : {}),
            ...(winGet(idx, 'signed_in_people', 'site', id) != null ? { signed_in_people: winGet(idx, 'signed_in_people', 'site', id) } : {}),
            traffic_24h: traffic,
        });
    }
    sites.sort((a, b) => (b.pageviews || 0) - (a.pageviews || 0) || String(a.name).localeCompare(String(b.name)));

    const networkHasDaily = dayHas(idx, 'pageviews', 'network', 'network');
    let pageviews = winGet(idx, 'pageviews', 'network', 'network') ?? daySum(idx, 'pageviews', 'network', 'network', w.currentStart, w.currentEnd);
    if (pageviews == null) pageviews = sumOrNull(sites.map((s) => s.pageviews));
    let prev = winGet(idx, 'pageviews_prev', 'network', 'network') ?? daySum(idx, 'pageviews', 'network', 'network', w.prevStart, w.prevEnd);
    if (prev == null) prev = sumOrNull(sites.map((s) => s.pageviews_prev));
    const pct = winGet(idx, 'change_pct', 'network', 'network') ?? change(pageviews, prev);

    let pageviewsDaily = null;
    if (networkHasDaily) pageviewsDaily = daySeries(idx, 'pageviews', 'network', 'network', w.days);
    else if (sites.some((s) => s.daily)) {
        pageviewsDaily = w.days.map((d) => ({ day: d, n: sites.reduce((a, s) => a + ((s.daily && s.daily.find((x) => x.day === d)) || {}).n || 0, 0) }));
    }

    const accountsTotal = winGet(idx, 'accounts_total', 'network', 'network');
    const accountsNew = winGet(idx, 'accounts_new', 'network', 'network') ?? daySum(idx, 'accounts_new', 'network', 'network', w.currentStart, w.currentEnd);
    const accountsPrev = winGet(idx, 'accounts_prev', 'network', 'network') ?? daySum(idx, 'accounts_new', 'network', 'network', w.prevStart, w.prevEnd);
    const accounts = (accountsTotal != null || accountsNew != null || dayHas(idx, 'accounts_new', 'network', 'network'))
        ? { total: accountsTotal, new: accountsNew, prev: accountsPrev, daily: dayHas(idx, 'accounts_new', 'network', 'network') ? daySeries(idx, 'accounts_new', 'network', 'network', w.days) : [] }
        : null;

    // coins.earned is all time, so it is only ever the source's own window figure, never a sum of recent days.
    const coinsEarned = winGet(idx, 'coins_earned', 'network', 'network');
    const coins = (coinsEarned != null || winGet(idx, 'coins_spent', 'network', 'network') != null)
        ? {
            earned: coinsEarned,
            spent: winGet(idx, 'coins_spent', 'network', 'network'),
            holders: winGet(idx, 'coins_holders', 'network', 'network'),
            transactions: winGet(idx, 'coins_transactions', 'network', 'network'),
            earned_window: winGet(idx, 'coins_earned_window', 'network', 'network') ?? daySum(idx, 'coins_earned', 'network', 'network', w.currentStart, w.currentEnd),
            earned_prev: winGet(idx, 'coins_earned_prev', 'network', 'network') ?? daySum(idx, 'coins_earned', 'network', 'network', w.prevStart, w.prevEnd),
            daily: dayHas(idx, 'coins_earned', 'network', 'network') ? daySeries(idx, 'coins_earned', 'network', 'network', w.days) : [],
        } : null;

    const liveKeys = ['live_now', 'watching', 'streamers', 'streams', 'accounts', 'visitors', 'messages', 'chatted_7d',
        'vods', 'clips', 'hours_watched', 'hours_archived', 'ai_moments', 'pastes', 'follows'];
    const live = {};
    for (const k of liveKeys) { const v = winGet(idx, k, 'network', 'network'); if (v != null) live[k] = v; }
    const hasLive = Object.keys(live).length > 0;

    const servicesUp = winGet(idx, 'services_up', 'network', 'network');
    const servicesChecked = winGet(idx, 'services_checked', 'network', 'network');
    const noteDoc = dimOf('network', 'network');

    return {
        generated_at: new Date(nowMs).toISOString(),
        window_days: windowDays,
        note: (noteDoc && noteDoc.note) || NOTE,
        totals: {
            pageviews: pageviews == null ? null : pageviews,
            pageviews_prev: prev == null ? null : prev,
            change_pct: pct,
            sites_open: winGet(idx, 'sites_open', 'network', 'network') ?? sites.length,
            services: servicesChecked != null ? { up: servicesUp == null ? 0 : servicesUp, checked: servicesChecked } : null,
            accounts: accounts ? accounts.total : null,
            requests_24h: winGet(idx, 'requests_24h', 'network', 'network'),
        },
        pageviews_daily: pageviewsDaily,
        accounts, coins,
        ...(hasLive ? { live } : {}),
        busiest_pages_24h: idx.json.get('network|network|busiest_pages') || null,
        sites,
    };
}

/** A creator's streaming analytics from report_streams, plus Billing's revenue read (never a computed amount). */
async function channelStats(store, channel, days = 30, { now = () => Date.now(), billing = null } = {}) {
    if (!store || !store.db) return null;
    const d = Math.min(Math.max(parseInt(days, 10) || 30, 1), 365);
    const nowMs = now();
    const since = new Date(nowMs - d * DAY).toISOString();
    const rows = await store.db.many(`SELECT * FROM report_streams WHERE (lower(channel) = lower($1) OR creator_subject = $2) AND started_at >= $3 ORDER BY started_at DESC`, [String(channel || ''), String(channel || ''), since]);
    let creator = null;
    for (const r of rows) if (r.creator_subject) { creator = r.creator_subject; break; }
    const revenue = creator && billing && typeof billing.revenue === 'function'
        ? await billing.revenue({ subject: creator, days: d, now: nowMs }).catch(() => null)
        : null;
    if (!rows.length && !revenue) return null;

    const blank = () => ({ streams: 0, stream_seconds: 0, peak_viewers: 0, unique_chatters: 0, messages: 0, watch_minutes: 0, _avgWeighted: 0 });
    const add = (acc, r) => {
        acc.streams += 1;
        acc.stream_seconds += r.duration_seconds || 0;
        acc.peak_viewers = Math.max(acc.peak_viewers, r.peak_viewers || 0);
        acc.unique_chatters += r.unique_chatters || 0;
        acc.messages += r.messages || 0;
        acc.watch_minutes += r.watch_minutes || 0;
        acc._avgWeighted += (Number(r.avg_viewers) || 0) * (r.duration_seconds || 0);
        return acc;
    };
    const finish = (acc) => {
        acc.avg_viewers = acc.stream_seconds ? round1(acc._avgWeighted / acc.stream_seconds) : 0;
        delete acc._avgWeighted;
        return acc;
    };
    const totals = finish(rows.reduce(add, blank()));
    const byDay = new Map();
    for (const r of rows) {
        const day = String(r.started_at || '').slice(0, 10);
        if (!day) continue;
        byDay.set(day, add(byDay.get(day) || blank(), r));
    }
    const daily = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, acc]) => ({ day, ...finish(acc) }));
    const streams = rows.slice(0, 100).map((r) => {
        const out = { stream_id: r.stream_id, title: r.title, category: r.category, started_at: r.started_at, ended_at: r.ended_at, duration_seconds: r.duration_seconds };
        for (const k of ['peak_viewers', 'avg_viewers', 'unique_chatters', 'messages', 'watch_minutes']) if (r[k] != null) out[k] = Number(r[k]);
        return out;
    });
    return { creator, channel: rows[0] ? rows[0].channel : String(channel), days: d, full: true, totals, daily, streams, revenue };
}

/** The flat report.metric@1 view: one row per number, with its day or window. */
async function metrics(store, { scope = 'network', scopeId = null, days = 30, now = () => Date.now() } = {}) {
    if (!store || !store.db) return null;
    if (!SCOPES.has(scope)) return null;
    const id = String(scopeId || (scope === 'network' ? 'network' : ''));
    if (!id) return null;
    const windowDays = normaliseDays(days);
    const w = windowOf(now(), windowDays);
    const rows = await store.db.many(`SELECT metric, scope, scope_id, day::text AS day, value, unit, source FROM report_metric_days
        WHERE scope = $1 AND scope_id = $2 AND day >= $3 ORDER BY day, metric`, [scope, id, w.currentStart]);
    const wins = await store.db.many(`SELECT metric, scope, scope_id, window_days, value, unit, source FROM report_metric_windows
        WHERE scope = $1 AND scope_id = $2 AND window_days = $3 ORDER BY metric`, [scope, id, windowDays]);
    const docs = await store.db.many(`SELECT metric, scope, scope_id, window_days, value, source FROM report_metric_json
        WHERE scope = $1 AND scope_id = $2 AND window_days = $3 ORDER BY metric`, [scope, id, windowDays]);
    return {
        as_of: new Date(now()).toISOString(),
        window_days: windowDays,
        scope,
        scope_id: id,
        metrics: rows.map((r) => ({ metric: r.metric, scope: r.scope, scope_id: r.scope_id, day: r.day, value: n(r.value), unit: r.unit, source: r.source })),
        windows: wins.map((r) => ({ metric: r.metric, scope: r.scope, scope_id: r.scope_id, window_days: r.window_days, value: n(r.value), unit: r.unit, source: r.source })),
        documents: docs.map((r) => ({ metric: r.metric, scope: r.scope, scope_id: r.scope_id, window_days: r.window_days, value: r.value, source: r.source })),
    };
}

module.exports = { reportStats, channelStats, metrics, windowOf, loadIndex, NOTE, DAY };
