'use strict';

/**
 * OpenVibe.Report's Rundown topic pages in OpenVibe.Search (openvibe-publishing/search-feed, contracts 0.275.0): one
 * search.index-document@1 per topic (/rundown/t/<slug>, the slug as the id), sent as report.index_document.upserted|
 * deleted through this service's events outbox. Live's own topic pages are noindex; Report's are the public copy, so
 * they are the ones Search gets. The document is what the page says: the topic's title, its headline and the summary
 * of what streamers said, its kind and how many takes and streamers it has. 60 topics were on no network search
 * (2026-11-02).
 *
 * The topics come from OpenVibe.Live's Rundown (data/live.js, cached five minutes) and change through the day, so a
 * sweep a minute after boot and every hour: the sequencer (report_index_revisions) gives an unchanged topic its old
 * revision and a quiet sweep sends nothing; a topic that left the Rundown gets a tombstone. When Live does not answer
 * the sweep stops rather than read an empty list as "every topic is gone". Off under REPORT_DRILL and without a
 * database.
 */
const { createServiceOutbox } = require('openvibe-sdk/events');
const { createSearchFeed } = require('openvibe-publishing/search-feed');

const EVENT_TYPES = ['report.index_document.upserted', 'report.index_document.deleted'];
const START_DELAY_MS = 60_000;
const INTERVAL_MS = 60 * 60_000;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,89}$/;
const KIND = { news: 'News', games: 'Games', tech: 'Tech', life: 'Life' };

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// Live's times are UTC without a zone ("2026-10-25 22:37:36").
const iso = (t) => {
    if (!t) return null;
    const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(String(t)) ? t : `${String(t).replace(' ', 'T')}Z`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** One topic from Live's list → what its Report page says, as search-feed's document description. */
function describeTopic(t) {
    const takes = Number(t.takes) || 0;
    const streamers = Number(t.streamers) || 0;
    const count = takes ? `${plural(takes, 'take', 'takes')} from ${plural(streamers || 1, 'streamer', 'streamers')}` : '';
    const kind = KIND[t.kind] || '';
    // Live's headlines end without a full stop; the summary adds one before the counts.
    const head = t.headline ? (/[.!?…]$/.test(String(t.headline).trim()) ? String(t.headline).trim() : `${String(t.headline).trim()}.`) : '';
    return {
        listed: true,
        noindex: !takes,
        title: `${t.title}: The Rundown`,
        summary: [head, count ? `${count} on OpenVibe.Live.` : ''].filter(Boolean).join(' '),
        // The snippet reads the summary and body together: the body is what streamers said, not the headline again.
        body: [t.summary, kind ? `${kind} topic on The Rundown.` : ''].filter(Boolean).join('\n'),
        facets: { ...(t.kind ? { kind: t.kind } : {}), takes, streamers },
        authorship: { mode: 'ai' },
        publishedAt: iso(t.first_seen_at),
        updatedAt: iso(t.last_seen_at),
    };
}

/** One session report -> what its Report page says, as search-feed's document description. */
function describeSession(rep) {
    const outputs = (rep.outputs || []).map((o) => o.title).filter(Boolean);
    return {
        listed: true,
        noindex: false,
        title: rep.task.title + ': the session report',
        summary: rep.summary,
        body: [rep.summary, outputs.length ? 'What came out: ' + outputs.join(', ') + '.' : ''].filter(Boolean).join('\n'),
        facets: { source: rep.source, outcome: rep.outcome },
        authorship: { mode: 'ai' },
        publishedAt: rep.created_at || null,
        updatedAt: rep.created_at || null,
    };
}

function createSearchIndex({ config, store, live, sessionReports = null, log = console, outbox = null }) {
    const db = store.db;
    const out = outbox || createServiceOutbox({
        db, source: 'report', eventsUrl: (config.events && config.events.url) || null, networkInternalUrl: config.networkInternalUrl,
        clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, log, eventTypes: EVENT_TYPES,
    });

    // Every topic, in slug order. Throws when Live does not answer: a sweep must never take an empty answer for an
    // empty Rundown and tombstone every page.
    async function list() {
        const data = await live.topics();
        if (!data || !Array.isArray(data.topics)) throw new Error('OpenVibe.Live did not answer the topic list');
        return data.topics.filter((t) => t && SLUG_RE.test(String(t.slug || '')) && t.title)
            .map((t) => ({ ...t, id: t.slug }))
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }

    const feed = createSearchFeed({
        owner: 'report', db, outbox: out, baseUrl: config.baseUrl, now: store.now, log,
        types: {
            // The public session reports (Agent Streams S3). Only the public ones: a private or unlisted report is
            // never in a search index.
            session: {
                page: (row) => '/s/' + row.id,
                document: describeSession,
                rows: async (after, limit) => (sessionReports ? await sessionReports.listPublic({ limit: 500 }) : [])
                    .filter((r) => r.id > String(after || '')).slice(0, limit),
                exists: async (ids) => {
                    const have = new Set((sessionReports ? await sessionReports.listPublic({ limit: 500 }) : []).map((r) => r.id));
                    return ids.filter((id) => have.has(id));
                },
            },
            topic: {
                page: (row) => `/rundown/t/${row.id}`,
                document: describeTopic,
                rows: async (after, limit) => (await list()).filter((t) => t.id > String(after || '')).slice(0, limit),
                exists: async (ids) => { const have = new Set((await list()).map((t) => t.id)); return ids.filter((id) => have.has(id)); },
            },
        },
    });
    const timers = [];

    /**
     * One report's Search copy, brought level with its audience now (the share store's onAudienceChange calls this, in
     * the same transaction as the audience change): in Everyone is a document, anything else a tombstone. Rule 4 says a
     * report that leaves Everyone leaves search at once, not at the next hourly sweep.
     */
    async function syncReport(id, audience, t = null) {
        const rep = await sessionReports.get(String(id));
        const handle = t || store.db;
        if (!rep) return await feed.remove(handle, 'session', String(id));
        if (audience !== 'public') return await feed.remove(handle, 'session', String(id));
        return await feed.sync(handle, 'session', rep);
    }

    async function sweep() {
        const res = await feed.sweep();
        const r = res.topic;
        if (r.sent || r.removed || r.failed) log.log(`[Search] Rundown topics: ${r.sent} sent, ${r.removed} removed, ${r.failed} failed of ${r.seen}`);
        if (out.kick) out.kick().catch(() => {});
        return res;
    }
    const quietly = () => { sweep().catch((err) => log.warn(`[Search] sweep failed: ${(err && err.message) || err}`)); };

    function start() {
        if (config.drill || timers.length) return false;
        out.start();
        const kick = setTimeout(quietly, START_DELAY_MS);
        if (kick.unref) kick.unref();
        const tick = setInterval(quietly, INTERVAL_MS);
        if (tick.unref) tick.unref();
        timers.push(kick, tick);
        return true;
    }

    function stop() {
        for (const t of timers.splice(0)) { clearTimeout(t); clearInterval(t); }
        out.stop();
    }

    return { feed, outbox: out, sweep, syncReport, start, stop, status: () => out.status() };
}

/** The feed the app built, for modules that need to sync one row outside a sweep (server/sharing.js). */
let _instance = null;
function instance() { return _instance; }
function setInstance(index) { _instance = index; return index; }

module.exports = { createSearchIndex, describeTopic, describeSession, EVENT_TYPES, instance, setInstance };
