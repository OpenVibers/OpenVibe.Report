'use strict';

/**
 * A person's own numbers (the owner, 2026-11-09): "a section for most used, your most used platforms across all of
 * them, with OpenVibe.Report analysis for you… show your stats… you can make them public if you want, but private by
 * default… full stats and graphs… and it shows most used in here."
 *
 * The sections, each read from the source that owns the number:
 *   sites     Network's cross-site history (GET /api/history with the person's own session token): the sites they
 *             opened this week and this month, most visited first, and the top eight for the menu.
 *   activity  the same history as days: twelve weeks, the days they were around, and the streak.
 *   made      Report's own Live analytics (streams and hours) and the person's session reports.
 *   ai        Report's AI meter (report.ai-usage-me-result@2): calls, tokens and what the meter says they cost.
 *   money     Billing's read API, through the analytics client: the Vibes that reached the person.
 *
 * A source that does not answer leaves its section out; it is never turned into a zero. The document is stored as a
 * snapshot at /me: the public /u/<name> page and GET /api/v1/u/:name/stats serve that snapshot with only the sections
 * the person published. Nothing unpublished is ever put in a public answer.
 *
 * Network's history counts visits, not durations: the same page opened twice within ten minutes is one visit, and
 * there is no minutes field to invent. The contract says so too (report.me-stats@1).
 */
const DAY = 86_400_000;
const SECTIONS = ['sites', 'activity', 'made', 'ai', 'money'];
const USERNAME_RE = /^[A-Za-z0-9_]{1,32}$/;
const SERVICE_RE = /^[a-z0-9-]{1,32}$/;
const HEAT_WEEKS = 12;
const TOP_SITES = 8;
const HISTORY_LIMIT = 200;

const n = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const int = (v) => { const x = n(v); return x == null ? null : Math.max(0, Math.round(x)); };
const iso = (ms) => new Date(ms).toISOString();
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const startOfDay = (ms) => Date.UTC(new Date(ms).getUTCFullYear(), new Date(ms).getUTCMonth(), new Date(ms).getUTCDate());

/** A history timestamp, which Network may send as SQLite's "YYYY-MM-DD HH:MM:SS" (UTC) or as ISO. */
function timeOf(value) {
    if (value == null) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const s = String(value);
    const withZone = /[TZ]/.test(s) || !s.includes(' ') ? s : `${s.replace(' ', 'T')}Z`;
    const t = Date.parse(withZone);
    return Number.isFinite(t) ? t : null;
}

function emptyPublished() {
    return { sites: false, activity: false, made: false, ai: false, money: false };
}

/** The switches, always all five and always booleans. */
function publishedOf(value) {
    const out = emptyPublished();
    if (!value || typeof value !== 'object') return out;
    for (const k of SECTIONS) out[k] = value[k] === true || value[k] === 'true';
    return out;
}

const anyPublished = (p) => SECTIONS.some((k) => p[k] === true);

function jsonOf(value) {
    if (value == null) return null;
    if (typeof value === 'object') return value;
    try { return JSON.parse(String(value)); } catch { return null; }
}

/** A public http(s) URL, or null. */
function urlOf(value) {
    try {
        const u = new URL(String(value));
        return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
    } catch { return null; }
}

function personOf(user) {
    const username = String((user && user.username) || '').trim();
    if (!USERNAME_RE.test(username)) return null;
    const person = { username, display_name: String((user && (user.display_name || user.username)) || username).slice(0, 80) };
    const avatar = urlOf(user && user.avatar_url);
    if (avatar) person.avatar_url = avatar;
    return person;
}

function usernameOf(user) {
    const u = String((user && user.username) || '').trim();
    return USERNAME_RE.test(u) ? u : null;
}

/**
 * The sites and the days from Network's history rows. Answers null when the history is unavailable, so the caller
 * leaves both sections out rather than claiming nothing happened.
 */
function fromHistory(items, now, days) {
    if (!Array.isArray(items)) return null;
    const today = startOfDay(now);
    const from = today - (Math.max(1, days) - 1) * DAY;
    const weekStart = today - 6 * DAY;
    const monthStart = today - 29 * DAY;
    const heatStart = today - (HEAT_WEEKS * 7 - 1) * DAY;
    const countFrom = Math.min(heatStart, from);

    const sites = new Map();
    const byDay = new Map();
    for (const item of items) {
        const at = timeOf(item && (item.updated_at || item.created_at));
        if (at == null) continue;
        const service = String((item && item.service) || '').trim().toLowerCase();
        if (!SERVICE_RE.test(service)) continue;
        const url = urlOf(item && item.url);
        let origin = url ? new URL(url).origin + '/' : null;
        if (!origin) continue;
        if (at >= countFrom) {
            const day = dayOf(at);
            byDay.set(day, (byDay.get(day) || 0) + 1);
        }
        if (at < monthStart) continue;
        const hit = sites.get(service) || { service, label: '', url: origin, week: 0, month: 0, last: 0 };
        hit.month += 1;
        if (at >= weekStart) hit.week += 1;
        if (at >= hit.last) {
            hit.last = at;
            hit.url = origin;
            const label = String((item && item.service_label) || service);
            hit.label = label.length > 60 ? label.slice(0, 60) : label;
        }
        sites.set(service, hit);
    }

    const all = [...sites.values()].sort((a, b) => b.month - a.month || a.service.localeCompare(b.service));
    const week = all.filter((s) => s.week > 0).sort((a, b) => b.week - a.week || a.service.localeCompare(b.service)).map((s) => ({ service: s.service, label: s.label || s.service, url: s.url, visits: s.week }));
    const month = all.map((s) => ({ service: s.service, label: s.label || s.service, url: s.url, visits: s.month }));
    const top = month.slice(0, TOP_SITES);

    // Twelve weeks, oldest first; each starts on its Monday (UTC).
    const monday = today - ((new Date(today).getUTCDay() + 6) % 7) * DAY;
    const weeks = [];
    for (let w = HEAT_WEEKS - 1; w >= 0; w--) {
        const start = monday - w * 7 * DAY;
        const weekDays = [];
        for (let d = 0; d < 7; d++) weekDays.push(byDay.get(dayOf(start + d * DAY)) || 0);
        weeks.push({ week_start: dayOf(start), days: weekDays });
    }
    let activeDays = 0;
    for (let t = from; t <= today; t += DAY) if (byDay.get(dayOf(t))) activeDays += 1;
    let streak = 0;
    for (let t = today; t >= from; t -= DAY) {
        if (!byDay.get(dayOf(t))) break;
        streak += 1;
    }
    return {
        sites: { week, month, top },
        activity: { weeks, active_days: activeDays, streak_days: streak },
    };
}

/** One session report's creation time, or null. */
function reportAt(report) {
    return timeOf(report && (report.created_at || report.createdAt));
}

/**
 * The client. `store` may be null (a network-only Report): /me still computes, but nothing is published and /u
 * cannot answer. The network client, analytics, AI meter and session reports are the app's own.
 */
function createMeStats({ store = null, network = null, analytics = null, aiUsage = null, sessionReports = null, config = {}, now = () => Date.now(), log = console } = {}) {
    const db = store && store.db ? store.db : null;
    const clock = typeof now === 'function' ? now : () => Date.now();
    const liveBase = String((config && config.livePublicUrl) || 'https://openvibe.live').replace(/\/+$/, '');
    const base = String((config && config.baseUrl) || 'https://openvibe.report').replace(/\/+$/, '');

    async function rowFor(subject) {
        if (!db || !subject) return null;
        try { return await db.prepare('SELECT * FROM report_me_stats WHERE subject = ?').get(String(subject)); } catch { return null; }
    }

    async function switchesFor(subject) {
        const row = await rowFor(subject);
        return publishedOf(row && jsonOf(row.published));
    }

    async function save({ subject, person, published, document }) {
        if (!db || !subject) return;
        await db.prepare(`INSERT INTO report_me_stats (subject, username, display_name, avatar_url, published, snapshot, snapshot_at, updated_at)
            VALUES (?, ?, ?, ?, ?::jsonb, ?::jsonb, now(), now())
            ON CONFLICT (subject) DO UPDATE SET
                username = excluded.username, display_name = excluded.display_name, avatar_url = excluded.avatar_url,
                published = excluded.published, snapshot = excluded.snapshot, snapshot_at = excluded.snapshot_at,
                updated_at = now()`)
            .run(String(subject), person.username, person.display_name, person.avatar_url || null, JSON.stringify(published), JSON.stringify(document));
    }

    /** Compute one person's document. `token` is their own Network session, forwarded only to Network's history. */
    async function compute({ user, token = null, days = 30 } = {}) {
        const person = personOf(user);
        const subject = user && typeof user.subject_id === 'string' ? user.subject_id.trim() : '';
        if (!person || !subject) throw new Error('me-stats: a signed-in person is required');
        const windowDays = [7, 30, 90].includes(Number(days)) ? Number(days) : 30;
        const at = clock();
        const from = dayOf(at - (windowDays - 1) * DAY);
        const published = await switchesFor(subject);

        const notes = [];
        const [history, stats, ai, reports] = await Promise.all([
            network && typeof network.history === 'function' && token ? network.history(token, { limit: HISTORY_LIMIT }).catch(() => null) : Promise.resolve(null),
            analytics && typeof analytics.channel === 'function' ? analytics.channel(person.username, windowDays).catch(() => null) : Promise.resolve(null),
            aiUsage && typeof aiUsage.forPerson === 'function' ? aiUsage.forPerson({ subject, from, group: 'day' }).catch(() => null) : Promise.resolve(null),
            sessionReports && typeof sessionReports.listForOwner === 'function' ? sessionReports.listForOwner(subject, { limit: 200 }).catch(() => null) : Promise.resolve(null),
        ]);
        if (network && typeof network.history === 'function' && token && history == null) notes.push('Your places and activity are not in this snapshot: OpenVibe.Network did not answer with your history.');
        if (Array.isArray(history) && history.length >= HISTORY_LIMIT) notes.push('Your places and activity count the latest 200 pages in Network’s history.');
        if (analytics && stats == null) notes.push('Your streams and Vibes are not in this snapshot: Report’s analytics did not answer.');

        const sections = {};
        const hist = fromHistory(history, at, windowDays);
        if (hist) {
            sections.sites = hist.sites;
            sections.activity = hist.activity;
        }

        const totals = stats && stats.totals && typeof stats.totals === 'object' ? stats.totals : null;
        const made = [];
        if (totals) {
            const streams = int(totals.streams);
            const seconds = n(totals.stream_seconds);
            if (streams > 0) made.push({ key: 'streams', label: 'Streams', count: streams, unit: 'streams', href: `${liveBase}/@${encodeURIComponent(person.username)}` });
            if (seconds > 0) made.push({ key: 'stream_hours', label: 'Hours streamed', count: Math.round((seconds / 3600) * 10) / 10, unit: 'hours' });
        }
        if (Array.isArray(reports)) {
            const fromAt = at - (windowDays - 1) * DAY;
            const count = reports.filter((r) => { const t = reportAt(r); return t != null && t >= fromAt; }).length;
            if (count > 0) made.push({ key: 'agent_reports', label: 'Agent reports', count, unit: 'reports', href: `${base}/you#rp-you-sr` });
        }
        if (made.length) sections.made = { items: made };

        const aiTotals = ai && ai.totals && typeof ai.totals === 'object' ? ai.totals : null;
        if (aiTotals) {
            const calls = int(aiTotals.calls);
            if (calls > 0) {
                const tokens = (int(aiTotals.input_tokens) || 0) + (int(aiTotals.output_tokens) || 0);
                const daily = (Array.isArray(ai.rows) ? ai.rows : []).map((r) => ({ day: String(r && r.key || '').slice(0, 10), calls: int(r && r.calls) || 0 }))
                    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.day)).slice(-90);
                sections.ai = { calls, tokens, cost_usd: Math.max(0, n(aiTotals.cost_usd) || 0), ...(daily.length ? { daily } : {}) };
            }
        }

        const revenue = stats && stats.revenue && typeof stats.revenue === 'object' ? stats.revenue : null;
        if (revenue) {
            const transactions = int(revenue.transactions);
            const settled = int(revenue.settled_bits);
            if (transactions > 0 || settled > 0) {
                sections.money = { currency: 'vibes-bits', settled_bits: settled || 0, transactions: transactions || 0 };
            }
        }

        const document = {
            generated_at: iso(at),
            person,
            window: { days: windowDays, from, to: dayOf(at) },
            published,
            sections: sectionsFor(sections, published, true),
            ...(notes.length ? { note: notes.join(' ') } : {}),
        };
        await save({ subject, person, published, document }).catch((err) => {
            try { (log.warn || log.error || console.warn).call(log, `[OpenVibe.Report] me-stats snapshot was not stored: ${(err && err.message) || 'database error'}`); } catch { /* */ }
        });
        return document;
    }

    async function setPublished({ user, token = null, days = 30, published } = {}) {
        if (!db) throw new Error('me-stats: no database');
        const person = personOf(user);
        const subject = user && typeof user.subject_id === 'string' ? user.subject_id.trim() : '';
        if (!person || !subject) throw new Error('me-stats: a signed-in person is required');
        const switches = publishedOf(published);
        await db.prepare(`INSERT INTO report_me_stats (subject, username, display_name, avatar_url, published, updated_at)
            VALUES (?, ?, ?, ?, ?::jsonb, now())
            ON CONFLICT (subject) DO UPDATE SET username = excluded.username, display_name = excluded.display_name,
                avatar_url = excluded.avatar_url, published = excluded.published, updated_at = now()`)
            .run(subject, person.username, person.display_name, person.avatar_url || null, JSON.stringify(switches));
        // Recompute at the moment of the switch, so a section made public is current, not the last visit's.
        return compute({ user, token, days });
    }

    /** The public document: the snapshot with only the published sections. null when there is no such person/row. */
    async function publicFor(username) {
        if (!db || !USERNAME_RE.test(String(username || ''))) return null;
        let row;
        try { row = await db.prepare('SELECT * FROM report_me_stats WHERE lower(username) = lower(?)').get(String(username)); } catch { return null; }
        if (!row) return null;
        const published = publishedOf(jsonOf(row.published));
        const snapshot = jsonOf(row.snapshot);
        const person = snapshot && snapshot.person && typeof snapshot.person === 'object'
            ? snapshot.person
            : { username: row.username, display_name: row.display_name || row.username, ...(row.avatar_url ? { avatar_url: row.avatar_url } : {}) };
        const base = snapshot && typeof snapshot === 'object' ? snapshot : {};
        const sections = sectionsFor(base.sections || {}, published, false);
        return {
            generated_at: typeof base.generated_at === 'string' ? base.generated_at : iso(timeOf(row.snapshot_at) || timeOf(row.updated_at) || clock()),
            person,
            window: base.window && typeof base.window === 'object' ? base.window : { days: 30, from: dayOf(clock() - 29 * DAY), to: dayOf(clock()) },
            published,
            sections,
        };
    }

    /** The people a sitemap can list: only those who published at least one section. */
    async function listPublished({ limit = 500 } = {}) {
        if (!db) return [];
        const cap = Math.max(1, Math.min(2000, Number(limit) || 500));
        let rows;
        try { rows = await db.prepare('SELECT username, published, snapshot, snapshot_at, updated_at FROM report_me_stats ORDER BY updated_at DESC LIMIT ?').all(cap); } catch { return []; }
        return rows.filter((r) => anyPublished(publishedOf(jsonOf(r.published)))).map((r) => {
            const snapshot = jsonOf(r.snapshot);
            return {
                username: r.username,
                generated_at: snapshot && typeof snapshot.generated_at === 'string' ? snapshot.generated_at : iso(timeOf(r.snapshot_at) || timeOf(r.updated_at) || clock()),
                updated_at: iso(timeOf(r.updated_at) || clock()),
            };
        });
    }

    return { compute, setPublished, publicFor, listPublished, SECTIONS, publishedOf, anyPublished };
}

/**
 * The sections a document may carry: all of them for the owner, only the published ones for a public reader. A
 * published section whose source did not answer stays absent (there is nothing in `sections` to copy).
 */
function sectionsFor(sections, published, owner) {
    const out = {};
    for (const key of SECTIONS) {
        if (!owner && published[key] !== true) continue;
        const value = sections && sections[key];
        if (value && typeof value === 'object') out[key] = value;
    }
    return out;
}

module.exports = { createMeStats, fromHistory, publishedOf, personOf, sectionsFor, SECTIONS, HEAT_WEEKS, TOP_SITES };
