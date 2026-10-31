'use strict';

/**
 * Report's ingest: the analytics facts OpenVibe.Network records today, written to Report's own tables.
 *
 *   live.stream.ended       one report_streams row and its channel/day counts (Network's creator-analytics input)
 *   the frame beacon        report_frame_days (day, host, hits) from a daily snapshot or a single hit
 *   Network's open stats    the daily page views, accounts and OpenCoins, and the window totals, kept as numbers
 *
 * Every delivery goes through report_inbox (openvibe-sdk/events createPgInbox) in the same transaction as the
 * writes: a redelivered event id changes nothing. A stats snapshot is keyed by its own content hash, so polling
 * the same numbers again is a no-op while new numbers replace the stored ones.
 *
 * Billing events are consciously not ingested: Report reads money from Billing's API, never from an event.
 */
const crypto = require('crypto');
const { createPgInbox } = require('openvibe-sdk/events');
const { normaliseDays } = require('../data/source');

const INBOX = 'report-events';
const STATS_INBOX = 'network-stats';
const DAY = 86_400_000;
const ALLOWED_TOPICS = new Set(['live.stream.ended', 'live.stream.started', 'network.frame.hit', 'network.frame.day', 'frame.hit', 'ai.call.recorded']);

const hashOf = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const int = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : null);
const dayOf = (value) => {
    if (value == null || value === '') return null;
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const t = Date.parse(String(value));
    return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
};
const isChannel = (v) => typeof v === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(v);

function unitOf(metric) {
    if (metric.endsWith('_ms')) return 'milliseconds';
    if (metric === 'change_pct' || metric.endsWith('_pct')) return 'percent';
    if (metric === 'stream_seconds' || metric === 'duration_seconds' || metric.endsWith('_seconds')) return 'seconds';
    if (metric === 'watch_minutes' || metric.endsWith('_minutes')) return 'minutes';
    if (metric.includes('revenue') || metric.includes('refund') || metric.endsWith('_bits')) return 'bits';
    if (metric.includes('cents')) return 'cents';
    return 'count';
}

function seriesOf(value) {
    if (!Array.isArray(value)) return [];
    const out = [];
    for (const p of value) {
        if (Array.isArray(p)) { const d = dayOf(p[0]); const n = num(p[1]); if (d && n != null) out.push({ day: d, n }); continue; }
        if (!p || typeof p !== 'object') continue;
        const d = dayOf(p.day || p.date);
        const n = num(p.n != null ? p.n : p.value);
        if (d && n != null) out.push({ day: d, n });
    }
    return out;
}

/**
 * The same numbers in one flat shape, used both to write the tables and by the shadow job to compare them.
 * A row is a day number or a window number; nothing is invented for a field the source did not send.
 */
function metricRowsFromStats(stats) {
    const rows = [];
    const seen = new Map();
    function add(kind, metric, scope, scopeId, value, unit = unitOf(metric), day = null, windowDays = null) {
        const n = num(value);
        if (n == null || !scopeId) return;
        const row = { kind, metric, scope, scope_id: String(scopeId), value: n, unit, day: kind === 'day' ? day : null, window_days: kind === 'window' ? windowDays : null };
        if (kind === 'day' && !row.day) return;
        if (kind === 'window' && !row.window_days) return;
        seen.set(`${kind}|${scope}|${row.scope_id}|${metric}|${row.day || ''}|${row.window_days || ''}`, row);
    }
    const win = (metric, scope, id, value) => add('window', metric, scope, id, value, unitOf(metric), null, days);
    const day = (metric, scope, id, d, value) => add('day', metric, scope, id, value, unitOf(metric), d, null);

    const s = stats && typeof stats === 'object' ? stats : {};
    const days = normaliseDays(s.window_days);
    const T = s.totals && typeof s.totals === 'object' ? s.totals : {};
    const A = s.accounts && typeof s.accounts === 'object' ? s.accounts : null;
    const C = s.coins && typeof s.coins === 'object' ? s.coins : null;
    const L = s.live && typeof s.live === 'object' ? s.live : null;

    win('pageviews', 'network', 'network', T.pageviews);
    win('pageviews_prev', 'network', 'network', T.pageviews_prev);
    win('change_pct', 'network', 'network', T.change_pct);
    win('sites_open', 'network', 'network', T.sites_open);
    win('accounts_total', 'network', 'network', T.accounts);
    win('requests_24h', 'network', 'network', T.requests_24h);
    if (T.services && typeof T.services === 'object') {
        win('services_up', 'network', 'network', T.services.up);
        win('services_checked', 'network', 'network', T.services.checked);
    }
    for (const p of seriesOf(s.pageviews_daily)) day('pageviews', 'network', 'network', p.day, p.n);

    if (A) {
        win('accounts_total', 'network', 'network', A.total);
        win('accounts_new', 'network', 'network', A.new);
        win('accounts_prev', 'network', 'network', A.prev);
        for (const p of seriesOf(A.daily)) day('accounts_new', 'network', 'network', p.day, p.n);
    }
    if (C) {
        win('coins_earned', 'network', 'network', C.earned);
        win('coins_spent', 'network', 'network', C.spent);
        win('coins_holders', 'network', 'network', C.holders);
        win('coins_transactions', 'network', 'network', C.transactions);
        win('coins_earned_window', 'network', 'network', C.earned_window);
        win('coins_earned_prev', 'network', 'network', C.earned_prev);
        for (const p of seriesOf(C.daily)) day('coins_earned', 'network', 'network', p.day, p.n);
    }
    if (L) {
        for (const k of ['live_now', 'watching', 'streamers', 'streams', 'accounts', 'visitors', 'messages', 'chatted_7d',
            'vods', 'clips', 'hours_watched', 'hours_archived', 'ai_moments', 'pastes', 'follows']) {
            win(k, 'network', 'network', L[k]);
        }
    }

    for (const site of Array.isArray(s.sites) ? s.sites : []) {
        if (!site || typeof site !== 'object') continue;
        const id = site.id || site.host || site.short;
        if (!id) continue;
        win('pageviews', 'site', id, site.pageviews);
        win('pageviews_prev', 'site', id, site.pageviews_prev);
        win('change_pct', 'site', id, site.change_pct);
        win('unique_visitors', 'site', id, site.unique_visitors);
        win('signed_in_people', 'site', id, site.signed_in_people);
        for (const p of seriesOf(site.daily)) day('pageviews', 'site', id, p.day, p.n);
        const t = site.traffic_24h && typeof site.traffic_24h === 'object' ? site.traffic_24h : null;
        if (t) {
            win('traffic_requests', 'site', id, t.requests);
            win('traffic_server_errors', 'site', id, t.server_errors);
            win('traffic_p95_ms', 'site', id, t.p95_ms);
        }
    }
    return [...seen.values()];
}

function jsonRowsFromStats(stats) {
    const rows = [];
    const s = stats && typeof stats === 'object' ? stats : {};
    if (Array.isArray(s.busiest_pages_24h)) {
        rows.push({ metric: 'busiest_pages', scope: 'network', scope_id: 'network', window_days: normaliseDays(s.window_days), value: s.busiest_pages_24h, source: 'network' });
    }
    return rows;
}

function frameRowsFromStats(stats) {
    const rows = [];
    const s = stats && typeof stats === 'object' ? stats : {};
    for (const site of Array.isArray(s.sites) ? s.sites : []) {
        if (!site || !site.host || !Array.isArray(site.daily)) continue;
        for (const p of seriesOf(site.daily)) rows.push({ day: p.day, host: String(site.host).toLowerCase(), hits: p.n });
    }
    return rows;
}

function dimensionsFromStats(stats) {
    const docs = [];
    const s = stats && typeof stats === 'object' ? stats : {};
    if (typeof s.note === 'string' && s.note.trim()) docs.push({ kind: 'network', id: 'network', doc: { note: s.note.trim().slice(0, 600) } });
    for (const site of Array.isArray(s.sites) ? s.sites : []) {
        if (!site || typeof site !== 'object') continue;
        const id = site.id || site.host || site.short;
        if (!id) continue;
        docs.push({
            kind: 'site', id,
            doc: {
                id, name: site.name || `OpenVibe.${site.short || id}`, short: site.short || id, host: site.host || null,
                url: site.url || (site.host ? `https://${site.host}/` : null), tagline: site.tagline || '', icon: site.icon || null,
            },
        });
    }
    return docs;
}

// ── Writes ──────────────────────────────────────────────────
async function setDay(t, row, source) {
    await t.prepare(`INSERT INTO report_metric_days (metric, scope, scope_id, day, value, unit, source)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(metric, scope, scope_id, day) DO UPDATE SET value = excluded.value, unit = excluded.unit, source = excluded.source, updated_at = now()`)
        .run(row.metric, row.scope, row.scope_id, row.day, row.value, row.unit, source);
}
async function addDay(t, metric, scope, id, day, value, unit = unitOf(metric), source = 'live') {
    await t.prepare(`INSERT INTO report_metric_days (metric, scope, scope_id, day, value, unit, source)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(metric, scope, scope_id, day) DO UPDATE SET value = report_metric_days.value + excluded.value, updated_at = now()`)
        .run(metric, scope, id, day, value, unit, source);
}
async function maxDay(t, metric, scope, id, day, value, unit = unitOf(metric), source = 'live') {
    await t.prepare(`INSERT INTO report_metric_days (metric, scope, scope_id, day, value, unit, source)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(metric, scope, scope_id, day) DO UPDATE SET value = GREATEST(report_metric_days.value, excluded.value), updated_at = now()`)
        .run(metric, scope, id, day, value, unit, source);
}
async function setWindow(t, row, source) {
    await t.prepare(`INSERT INTO report_metric_windows (metric, scope, scope_id, window_days, value, unit, source)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(metric, scope, scope_id, window_days) DO UPDATE SET value = excluded.value, unit = excluded.unit, source = excluded.source, updated_at = now()`)
        .run(row.metric, row.scope, row.scope_id, row.window_days, row.value, row.unit, source);
}
async function setJson(t, row) {
    await t.prepare(`INSERT INTO report_metric_json (metric, scope, scope_id, window_days, value, source)
        VALUES (?, ?, ?, ?, ?::jsonb, ?)
        ON CONFLICT(metric, scope, scope_id, window_days) DO UPDATE SET value = excluded.value, source = excluded.source, updated_at = now()`)
        .run(row.metric, row.scope, row.scope_id, row.window_days, JSON.stringify(row.value), row.source);
}
async function setFrame(t, row) {
    await t.prepare(`INSERT INTO report_frame_days (day, host, hits, source) VALUES (?, ?, ?, 'network-stats')
        ON CONFLICT(day, host) DO UPDATE SET hits = excluded.hits, source = excluded.source, updated_at = now()`)
        .run(row.day, row.host, row.hits);
}
async function setDimension(t, row) {
    await t.prepare(`INSERT INTO report_dimensions (kind, id, doc) VALUES (?, ?, ?::jsonb)
        ON CONFLICT(kind, id) DO UPDATE SET doc = excluded.doc, updated_at = now()`)
        .run(row.kind, row.id, JSON.stringify(row.doc));
}

async function recordFrame(t, topic, payload, occurredAt, source) {
    const p = payload && typeof payload === 'object' ? payload : {};
    const day = dayOf(p.day || occurredAt);
    const host = String(p.host || p.site || '').toLowerCase();
    if (!day || !/^[a-z0-9.-]{1,253}$/.test(host)) return 'ignored:payload';
    const hits = p.hits != null ? int(p.hits) : 1;
    if (hits == null) return 'ignored:payload';
    const increment = (topic === 'network.frame.hit' || topic === 'frame.hit') && p.hits == null;
    const sql = increment
        ? `INSERT INTO report_frame_days (day, host, hits, source) VALUES (?, ?, ?, ?)
            ON CONFLICT(day, host) DO UPDATE SET hits = report_frame_days.hits + excluded.hits, source = excluded.source, updated_at = now()`
        : `INSERT INTO report_frame_days (day, host, hits, source) VALUES (?, ?, ?, ?)
            ON CONFLICT(day, host) DO UPDATE SET hits = excluded.hits, source = excluded.source, updated_at = now()`;
    await t.prepare(sql).run(day, host, hits, source || (increment ? 'frame-hit' : 'frame'));
    return 'frame:recorded';
}

async function recordStream(t, event, payload, occurredAt, source) {
    const p = payload && typeof payload === 'object' ? payload : {};
    const streamId = Number(p.stream_id);
    const channel = p.channel && typeof p.channel.username === 'string' ? p.channel.username : null;
    if (!Number.isSafeInteger(streamId) || streamId < 1 || !isChannel(channel)) return 'ignored:payload';
    const creator = p.channel && p.channel.subject && typeof p.channel.subject.id === 'string' ? p.channel.subject.id : null;
    const startedMs = Date.parse(p.started_at || occurredAt || '');
    const endedMs = Date.parse(p.ended_at || occurredAt || '');
    if (!Number.isFinite(startedMs) || !Number.isFinite(endedMs) || endedMs < startedMs) return 'ignored:times';
    const stats = p.stats && typeof p.stats === 'object' ? p.stats : {};
    const duration = int(p.duration_seconds) != null ? int(p.duration_seconds) : Math.round((endedMs - startedMs) / 1000);
    const existing = await t.prepare('SELECT stream_id FROM report_streams WHERE stream_id = ?').get(streamId);
    await t.prepare(`INSERT INTO report_streams (stream_id, creator_subject, channel, title, category, started_at, ended_at, duration_seconds,
        peak_viewers, avg_viewers, unique_chatters, messages, watch_minutes, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb)
        ON CONFLICT(stream_id) DO UPDATE SET creator_subject = excluded.creator_subject, channel = excluded.channel, title = excluded.title,
            category = excluded.category, started_at = excluded.started_at, ended_at = excluded.ended_at, duration_seconds = excluded.duration_seconds,
            peak_viewers = excluded.peak_viewers, avg_viewers = excluded.avg_viewers, unique_chatters = excluded.unique_chatters,
            messages = excluded.messages, watch_minutes = excluded.watch_minutes, payload = excluded.payload, received_at = now()`)
        .run(streamId, creator, channel, p.title == null ? null : String(p.title).slice(0, 300), p.category == null ? null : String(p.category).slice(0, 100),
            new Date(startedMs).toISOString(), new Date(endedMs).toISOString(), duration,
            int(stats.peak_viewers), num(stats.avg_viewers), int(stats.unique_chatters), int(stats.messages), int(stats.watch_minutes),
            JSON.stringify({ stream_id: streamId, channel: p.channel, title: p.title || null, category: p.category || null, started_at: p.started_at || null, ended_at: p.ended_at || null, duration_seconds: duration, stats }));
    if (existing) return 'stream:updated';   // a corrected copy: replace the facts, never count the stream twice
    const day = new Date(startedMs).toISOString().slice(0, 10);
    await addDay(t, 'streams', 'channel', channel, day, 1, 'count', source || 'live');
    await addDay(t, 'stream_seconds', 'channel', channel, day, duration, 'seconds', source || 'live');
    await addDay(t, 'unique_chatters', 'channel', channel, day, int(stats.unique_chatters) || 0, 'count', source || 'live');
    await addDay(t, 'messages', 'channel', channel, day, int(stats.messages) || 0, 'count', source || 'live');
    await addDay(t, 'watch_minutes', 'channel', channel, day, int(stats.watch_minutes) || 0, 'minutes', source || 'live');
    if (num(stats.avg_viewers) != null) await addDay(t, 'avg_viewers_weighted', 'channel', channel, day, num(stats.avg_viewers) * duration, 'count', source || 'live');
    if (int(stats.peak_viewers) != null) await maxDay(t, 'peak_viewers', 'channel', channel, day, int(stats.peak_viewers), 'count', source || 'live');
    return 'stream:recorded';
}

/** One Events envelope → the tables. Returns { duplicate, outcome }. */
async function recordEvent(store, event, { now = () => Date.now() } = {}) {
    if (!store || !store.db) throw new TypeError('recordEvent needs an open Report store');
    const e = event && typeof event === 'object' ? event : {};
    const eventId = String(e.event_id || e.id || '');
    const topic = String(e.event_type || e.topic || e.type || '');
    if (!eventId) throw new TypeError('an event_id is required');
    if (!topic) return { duplicate: false, outcome: 'ignored:topic' };
    const source = String(e.source || topic.split('.')[0] || 'events');
    const rawOccurred = e.occurred_at || e.timestamp || (e.payload && (e.payload.ended_at || e.payload.at)) || new Date(now()).toISOString();
    const occurredMs = Date.parse(String(rawOccurred));
    const occurredAt = Number.isFinite(occurredMs) ? new Date(occurredMs).toISOString() : null;
    if (!ALLOWED_TOPICS.has(topic)) {
        // Today's billing and traffic events are not analytics facts Report may derive: a seen id changes nothing.
        const inbox = createPgInbox(store.db, { table: 'report_inbox', now });
        const r = await inbox.once(INBOX, eventId, async () => 'ignored:topic');
        return { duplicate: r.duplicate, outcome: r.result || 'ignored:topic' };
    }
    const payload = e.payload && typeof e.payload === 'object' ? e.payload : {};
    const inbox = createPgInbox(store.db, { table: 'report_inbox', now });
    const r = await inbox.once(INBOX, eventId, async (t) => {
        await t.prepare(`INSERT INTO report_events (event_id, source, topic, occurred_at, payload) VALUES (?, ?, ?, ?, ?::jsonb) ON CONFLICT (event_id) DO NOTHING`)
            .run(eventId, source, topic, occurredAt, JSON.stringify(payload));
        await t.prepare('UPDATE report_inbox SET source = ?, topic = ?, payload_hash = ? WHERE consumer = ? AND event_id = ?')
            .run(source, topic, hashOf(payload), INBOX, eventId);
        if (topic === 'live.stream.ended') return await recordStream(t, e, payload, occurredAt, source);
        // The AI meter (L40/L41): one record per AI call, stored once by the system and the run (or turn).
        if (topic === 'ai.call.recorded') return await require('./ai-usage').recordUsage(t, payload, { occurredAt, source });
        if (topic === 'network.frame.hit' || topic === 'network.frame.day' || topic === 'frame.hit') return await recordFrame(t, topic, payload, occurredAt, source);
        return 'event:recorded';
    });
    return { duplicate: r.duplicate, outcome: r.result || 'event:recorded' };
}

/** Ingest one GET /api/v1/stats answer. Idempotent by its content hash. */
async function ingestStats(store, stats, { now = () => Date.now(), source = 'network-stats' } = {}) {
    if (!store || !store.db) throw new TypeError('ingestStats needs an open Report store');
    if (!stats || typeof stats !== 'object') return { ok: false, reason: 'no stats' };
    const windowDays = normaliseDays(stats.window_days);
    const rows = metricRowsFromStats(stats);
    const docs = jsonRowsFromStats(stats);
    const frames = frameRowsFromStats(stats);
    const dims = dimensionsFromStats(stats);
    const eventId = `stats:${windowDays}:${hashOf({ stats })}`;
    const inbox = createPgInbox(store.db, { table: 'report_inbox', now });
    const r = await inbox.once(STATS_INBOX, eventId, async (t) => {
        for (const row of rows) {
            if (row.kind === 'window') await setWindow(t, row, source);
            else if (row.kind === 'day') await setDay(t, row, source);
        }
        for (const doc of docs) await setJson(t, doc);
        for (const frame of frames) await setFrame(t, frame);
        for (const dim of dims) await setDimension(t, dim);
        await t.prepare('UPDATE report_inbox SET source = ?, topic = ?, payload_hash = ? WHERE consumer = ? AND event_id = ?')
            .run(source, 'network.stats', hashOf(stats), STATS_INBOX, eventId);
        return `stats:${rows.length}`;
    });
    return { ok: true, duplicate: r.duplicate, outcome: r.result, window_days: windowDays, rows: rows.length, event_id: eventId };
}

/** Pull Network's open stats once and ingest them. Null from Network is "no answer", never zeroes. */
async function ingestNetwork(store, network, { days = 90, now = () => Date.now() } = {}) {
    if (!network || typeof network.stats !== 'function') throw new TypeError('ingestNetwork needs a Network client');
    const stats = await network.stats(days);
    if (!stats) return { ok: false, reason: 'network_did_not_answer' };
    return await ingestStats(store, stats, { now });
}

module.exports = {
    recordEvent, ingestStats, ingestNetwork, metricRowsFromStats, jsonRowsFromStats, frameRowsFromStats, dimensionsFromStats,
    setDay, addDay, maxDay, setWindow, setJson, setFrame, setDimension, hashOf, dayOf, unitOf, ALLOWED_TOPICS, INBOX, STATS_INBOX, DAY,
};
