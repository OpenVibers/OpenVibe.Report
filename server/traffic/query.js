'use strict';
/**
 * What the traffic pages and /api/v1/traffic read (plan AD.40): sums over report_traffic_days for a window of days.
 *
 *   summary(store, { days })            the network: people and bots by day, every bot, the machine files, every site
 *   site(store, host, { days })         one site: the same, and its files with who read them and when
 *   bot(store, agent, { days })         one bot: its sites, what it reads, its answers, verified or not
 *
 * Every answer is counts: no address, no person.
 */
const { WHO } = require('./agents');

const DAYS = [1, 7, 30, 90];
const normaliseDays = (v) => (DAYS.includes(Number(v)) ? Number(v) : 7);
const num = (v) => (v == null ? 0 : Number(v));
const iso = (v) => (v == null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString());
// The window: today and the days before it, in UTC.
const SINCE = "day >= (CURRENT_DATE - (?::int - 1))";

const sumCols = 'SUM(requests) AS requests, SUM(ok) AS ok, SUM(redirects) AS redirects, SUM(missing) AS missing, SUM(refused) AS refused, SUM(errors) AS errors, SUM(bytes) AS bytes, SUM(ms) AS ms, MAX(last_at) AS last_at';
function counts(r) {
    const requests = num(r.requests);
    return {
        requests, ok: num(r.ok), redirects: num(r.redirects), missing: num(r.missing), refused: num(r.refused), errors: num(r.errors),
        bytes: num(r.bytes), avg_ms: requests ? Math.round(num(r.ms) / requests) : null, last_at: iso(r.last_at),
    };
}

/** Requests by day and by who, as [{ day, person, search, ai_crawler, … }]. */
function byDay(rows, days) {
    const map = new Map();
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    for (let i = days - 1; i >= 0; i--) {
        const d = new Date(today.getTime() - i * 86400000).toISOString().slice(0, 10);
        map.set(d, { day: d, ...Object.fromEntries(Object.keys(WHO).map((w) => [w, 0])) });
    }
    for (const r of rows) {
        const d = iso(r.day).slice(0, 10);
        if (map.has(d) && Object.prototype.hasOwnProperty.call(WHO, r.who)) map.get(d)[r.who] += num(r.requests);
    }
    return [...map.values()];
}

function whoTotals(rows) {
    const out = Object.fromEntries(Object.keys(WHO).map((w) => [w, 0]));
    for (const r of rows) if (Object.prototype.hasOwnProperty.call(out, r.who)) out[r.who] += num(r.requests);
    const total = Object.values(out).reduce((a, b) => a + b, 0);
    return { by_who: out, total, people: out.person, bots: total - out.person };
}

/** Today in hours (UTC), as [{ day: hour ISO, label: '14:00', person, search, … }]. */
function byHour(rows) {
    const start = new Date(); start.setUTCHours(0, 0, 0, 0);
    const now = Date.now();
    const out = [];
    for (let h = 0; h < 24; h++) {
        const t = start.getTime() + h * 3600000;
        if (t > now) break;
        out.push({ day: new Date(t).toISOString(), label: `${String(h).padStart(2, '0')}:00`, ...Object.fromEntries(Object.keys(WHO).map((w) => [w, 0])) });
    }
    const at = new Map(out.map((x) => [x.day, x]));
    for (const r of rows) {
        const x = at.get(iso(r.hour));
        if (x && Object.prototype.hasOwnProperty.call(WHO, r.who)) x[r.who] += num(r.requests);
    }
    return out;
}

/** Where people came from, countries and (for today) hours: the v2 parts both the network and a site show. */
async function extras(store, D, host = null) {
    const q = (sql, ...args) => store.db.prepare(sql).all(...args);
    const onHost = host ? ' AND host = ?' : '';
    const hostArg = host ? [host] : [];
    const [sources, countries, hours] = await Promise.all([
        q(`SELECT source, SUM(requests) AS requests FROM report_traffic_sources WHERE ${SINCE}${onHost} GROUP BY source ORDER BY SUM(requests) DESC LIMIT 60`, D, ...hostArg),
        q(`SELECT country, SUM(CASE WHEN people THEN requests ELSE 0 END) AS people, SUM(CASE WHEN people THEN 0 ELSE requests END) AS bots
           FROM report_traffic_countries WHERE ${SINCE}${onHost} GROUP BY country ORDER BY SUM(CASE WHEN people THEN requests ELSE 0 END) DESC, SUM(requests) DESC LIMIT 80`, D, ...hostArg),
        D === 1 ? q(`SELECT hour, who, SUM(requests) AS requests FROM report_traffic_hours WHERE hour >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'${onHost} GROUP BY hour, who`, ...hostArg) : Promise.resolve(null),
    ]);
    return {
        sources: sources.map((x) => ({ source: x.source, requests: num(x.requests) })),
        countries: countries.map((x) => ({ country: x.country, people: num(x.people), bots: num(x.bots) })),
        ...(hours ? { hourly: byHour(hours) } : {}),
    };
}

async function summary(store, { days = 7 } = {}) {
    const D = normaliseDays(days);
    const q = (sql, ...args) => store.db.prepare(sql).all(...args);
    const [daily, bots, files, sites, kinds, readers] = await Promise.all([
        q(`SELECT day, who, SUM(requests) AS requests FROM report_traffic_days WHERE ${SINCE} GROUP BY day, who`, D),
        q(`SELECT agent, who, ${sumCols}, COUNT(DISTINCT host) AS sites, SUM(CASE WHEN verified = 'yes' THEN requests ELSE 0 END) AS verified_yes,
             SUM(CASE WHEN verified = 'no' THEN requests ELSE 0 END) AS verified_no, SUM(CASE WHEN kind = 'file' THEN requests ELSE 0 END) AS files
           FROM report_traffic_days WHERE ${SINCE} AND who <> 'person' GROUP BY agent, who ORDER BY SUM(requests) DESC LIMIT 100`, D),
        q(`SELECT path, ${sumCols}, COUNT(DISTINCT host) AS sites, SUM(CASE WHEN who = 'person' THEN requests ELSE 0 END) AS people
           FROM report_traffic_days WHERE ${SINCE} AND kind = 'file' GROUP BY path ORDER BY SUM(requests) DESC LIMIT 60`, D),
        q(`SELECT host, SUM(requests) AS requests, SUM(CASE WHEN who = 'person' THEN requests ELSE 0 END) AS people,
             SUM(CASE WHEN who IN ('ai_crawler','ai_assistant') THEN requests ELSE 0 END) AS ai, SUM(CASE WHEN kind = 'file' THEN requests ELSE 0 END) AS files,
             SUM(CASE WHEN kind = 'page' AND who = 'person' THEN requests ELSE 0 END) AS people_pages
           FROM report_traffic_days WHERE ${SINCE} GROUP BY host ORDER BY SUM(requests) DESC LIMIT 200`, D),
        q(`SELECT kind, SUM(requests) AS requests, SUM(CASE WHEN who = 'person' THEN requests ELSE 0 END) AS people FROM report_traffic_days WHERE ${SINCE} GROUP BY kind`, D),
        q(`SELECT path, agent, who, SUM(requests) AS requests FROM report_traffic_days WHERE ${SINCE} AND kind = 'file' AND who <> 'person'
           GROUP BY path, agent, who ORDER BY SUM(requests) DESC LIMIT 600`, D),
    ]);
    const W = whoTotals(daily);
    const topReaders = new Map();
    for (const r of readers) {
        const list = topReaders.get(r.path) || [];
        if (list.length < 4) list.push({ agent: r.agent, who: r.who, requests: num(r.requests) });
        topReaders.set(r.path, list);
    }
    return {
        days: D,
        totals: { ...W, ai: W.by_who.ai_crawler + W.by_who.ai_assistant, bot_share: W.total ? W.bots / W.total : null },
        daily: byDay(daily, D),
        ...(await extras(store, D)),
        kinds: kinds.map((k) => ({ kind: k.kind, requests: num(k.requests), people: num(k.people) })).sort((a, b) => b.requests - a.requests),
        bots: bots.map((b) => ({ agent: b.agent, who: b.who, sites: num(b.sites), files: num(b.files), verified_yes: num(b.verified_yes), verified_no: num(b.verified_no), ...counts(b) })),
        files: files.map((f) => ({ path: f.path, sites: num(f.sites), people: num(f.people), readers: topReaders.get(f.path) || [], ...counts(f) })),
        sites: sites.map((s) => ({ host: s.host, requests: num(s.requests), people: num(s.people), people_pages: num(s.people_pages), bots: num(s.requests) - num(s.people), ai: num(s.ai), files: num(s.files) })),
    };
}

async function site(store, host, { days = 7 } = {}) {
    const D = normaliseDays(days);
    const h = String(host || '').toLowerCase();
    const q = (sql, ...args) => store.db.prepare(sql).all(...args);
    const [daily, bots, files, pages] = await Promise.all([
        q(`SELECT day, who, SUM(requests) AS requests FROM report_traffic_days WHERE ${SINCE} AND host = ? GROUP BY day, who`, D, h),
        q(`SELECT agent, who, ${sumCols}, SUM(CASE WHEN verified = 'yes' THEN requests ELSE 0 END) AS verified_yes, SUM(CASE WHEN verified = 'no' THEN requests ELSE 0 END) AS verified_no
           FROM report_traffic_days WHERE ${SINCE} AND host = ? AND who <> 'person' GROUP BY agent, who ORDER BY SUM(requests) DESC LIMIT 60`, D, h),
        q(`SELECT path, agent, who, ${sumCols} FROM report_traffic_days WHERE ${SINCE} AND host = ? AND kind = 'file' GROUP BY path, agent, who ORDER BY path, SUM(requests) DESC`, D, h),
        q(`SELECT path, SUM(CASE WHEN who = 'person' THEN requests ELSE 0 END) AS people, SUM(CASE WHEN who <> 'person' THEN requests ELSE 0 END) AS bots, SUM(missing) AS missing
           FROM report_traffic_days WHERE ${SINCE} AND host = ? AND kind = 'page' GROUP BY path ORDER BY SUM(requests) DESC LIMIT 40`, D, h),
    ]);
    if (!daily.length) return null;
    const W = whoTotals(daily);
    const byFile = new Map();
    for (const r of files) {
        const f = byFile.get(r.path) || { path: r.path, requests: 0, people: 0, missing: 0, last_at: null, readers: [] };
        const c = counts(r);
        f.requests += c.requests; f.missing += c.missing;
        if (r.who === 'person') f.people += c.requests; else f.readers.push({ agent: r.agent, who: r.who, requests: c.requests, last_at: c.last_at });
        if (c.last_at && (!f.last_at || c.last_at > f.last_at)) f.last_at = c.last_at;
        byFile.set(r.path, f);
    }
    return {
        host: h, days: D,
        totals: { ...W, ai: W.by_who.ai_crawler + W.by_who.ai_assistant, bot_share: W.total ? W.bots / W.total : null },
        daily: byDay(daily, D),
        ...(await extras(store, D, h)),
        bots: bots.map((b) => ({ agent: b.agent, who: b.who, verified_yes: num(b.verified_yes), verified_no: num(b.verified_no), ...counts(b) })),
        files: [...byFile.values()].sort((a, b) => b.requests - a.requests),
        pages: pages.map((p) => ({ path: p.path, people: num(p.people), bots: num(p.bots), missing: num(p.missing) })),
    };
}

async function bot(store, agent, { days = 7 } = {}) {
    const D = normaliseDays(days);
    const name = String(agent || '');
    const q = (sql, ...args) => store.db.prepare(sql).all(...args);
    const [daily, sites, reads, totals] = await Promise.all([
        q(`SELECT day, who, SUM(requests) AS requests FROM report_traffic_days WHERE ${SINCE} AND agent = ? AND who <> 'person' GROUP BY day, who`, D, name),
        q(`SELECT host, ${sumCols} FROM report_traffic_days WHERE ${SINCE} AND agent = ? AND who <> 'person' GROUP BY host ORDER BY SUM(requests) DESC LIMIT 100`, D, name),
        q(`SELECT kind, path, ${sumCols} FROM report_traffic_days WHERE ${SINCE} AND agent = ? AND who <> 'person' AND (kind IN ('file', 'feed') OR kind = 'page')
           GROUP BY kind, path ORDER BY SUM(requests) DESC LIMIT 40`, D, name),
        q(`SELECT who, ${sumCols}, SUM(CASE WHEN verified = 'yes' THEN requests ELSE 0 END) AS verified_yes, SUM(CASE WHEN verified = 'no' THEN requests ELSE 0 END) AS verified_no
           FROM report_traffic_days WHERE ${SINCE} AND agent = ? AND who <> 'person' GROUP BY who ORDER BY SUM(requests) DESC`, D, name),
    ]);
    if (!totals.length) return null;
    const t = totals[0];
    return {
        agent: name, who: t.who, days: D,
        totals: { ...counts(t), verified_yes: num(t.verified_yes), verified_no: num(t.verified_no), sites: sites.length },
        daily: byDay(daily, D).map((d) => ({ day: d.day, requests: Object.keys(WHO).reduce((a, w) => a + d[w], 0) })),
        sites: sites.map((s) => ({ host: s.host, ...counts(s) })),
        reads: reads.map((r) => ({ kind: r.kind, path: r.path, ...counts(r) })),
    };
}

module.exports = { summary, site, bot, normaliseDays, DAYS };
