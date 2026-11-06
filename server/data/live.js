'use strict';

/**
 * OpenVibe.Live's read APIs:
 *   GET /api/rundown/            the Rundown's home: on air, the lead, streams, trending, voices, counts
 *   GET /api/rundown/topics      every topic
 *   GET /api/rundown/t/:slug     one topic and its takes
 *   GET /api/rundown/e/:id       one stream as an episode
 *   GET /api/rundown/s/:user     a streamer's episodes, topics and lines
 *   GET /api/recap/:id           an after-show report
 *   GET /api/recap/channel/:user a channel's latest reports
 *
 * Answers are held in this process (2 to 10 minutes, as each source changes); a failure answers null after
 * one short log line. Path parameters are checked here, before a request is made: a slug that cannot exist is
 * a 404 without asking Live.
 */
const { createCache } = require('./cache');
const { trim, requestJson, requestJsonMeta, isSlug, streamIdOf, isUsername, TIMEOUT_MS } = require('./source');

const SERVE_STALE_MS = 30 * 60_000;

const TTL = {
    rundown: 2 * 60_000,
    topics: 5 * 60_000,
    topic: 5 * 60_000,
    episode: 5 * 60_000,
    speaker: 5 * 60_000,
    // An after-show report follows its stream's Rundown episode: Live decides who sees it, and its streamer may make
    // it private at any moment. Report holds one a minute at most, and never past what Live said (see sharedRecap).
    recap: 60_000,
    channelRecaps: 60_000,
};

/**
 * opts: config ({ liveUrl }), fetchImpl, log, now, timeoutMs, cacheMax
 */
function createLiveClient({ config = {}, fetchImpl = globalThis.fetch, log = console, now = () => Date.now(), timeoutMs = TIMEOUT_MS, cacheMax = 1000 } = {}) {
    const baseUrl = trim(config.liveUrl || config.liveInternalUrl || 'http://127.0.0.1:3000');
    const cache = createCache({ max: cacheMax, now });

    // An answer past its time but expired under SERVE_STALE_MS ago is served at once while one refresh per key runs
    // behind the page: the visitor after an expiry waited for Live (/rundown at up to 1.9 s at the origin, 11-02). A
    // failed refresh leaves the stale answer to be served (and refreshed again) until it is too old.
    const refreshing = new Map();
    async function load(key, path, ttl, label) {
        const data = await requestJson(`${baseUrl}${path}`, { fetchImpl, log, timeoutMs, label });
        if (data === null) return null;
        return cache.set(key, data, ttl);
    }
    async function cached(key, path, ttl, label) {
        const hit = cache.get(key);
        if (hit !== undefined) return hit;
        const stale = cache.peek(key, SERVE_STALE_MS);
        if (stale !== undefined) {
            if (!refreshing.has(key)) refreshing.set(key, load(key, path, ttl, label).catch(() => null).finally(() => refreshing.delete(key)));
            return stale;
        }
        return load(key, path, ttl, label);
    }

    function rundown() {
        return cached('rundown:home', '/api/rundown/', TTL.rundown, 'live rundown');
    }

    function topics() {
        return cached('rundown:topics', '/api/rundown/topics', TTL.topics, 'live topics');
    }

    function topic(slug) {
        if (!isSlug(slug)) return null;
        return cached(`rundown:topic:${slug}`, `/api/rundown/t/${encodeURIComponent(slug)}`, TTL.topic, 'live topic');
    }

    /** Live's episode route is named by the stream id (a positive integer). */
    function episode(streamId) {
        const id = streamIdOf(streamId);
        if (!id) return null;
        return cached(`rundown:episode:${id}`, `/api/rundown/e/${id}`, TTL.episode, 'live episode');
    }

    function speaker(username) {
        if (!isUsername(username)) return null;
        const key = username.toLowerCase();
        return cached(`rundown:speaker:${key}`, `/api/rundown/s/${encodeURIComponent(username)}`, TTL.speaker, 'live speaker');
    }

    /**
     * An after-show report, held for a minute and only when Live marked the answer public.
     *
     * Report shows these as Live decided them (the streamer's Rundown episode is the audience), so it must never widen
     * one: an answer Live did not mark `public` - a per-person view, a no-store - is returned to this reader and not
     * kept. A 404 is a miss, not an answer: the entry is emptied, so a report its streamer just made private leaves at
     * once instead of being served from a copy for the rest of the minute, and the next read asks Live again. No stale
     * copy is ever served here (cached() does that for the Rundown's own lists, which nobody hides): one failure is
     * null, and the page says what it always says when Live cannot answer.
     */
    async function sharedRecap(key, path, ttl, label) {
        const hit = cache.get(key);
        if (hit !== undefined) return hit;
        cache.delete(key);
        const res = await requestJsonMeta(`${baseUrl}${path}`, { fetchImpl, log, timeoutMs, label });
        if (res.status === 404) {
            cache.delete(key);
            return null;
        }
        if (!res.data || !/\bpublic\b/i.test(String(res.cacheControl || ''))) return null;
        return cache.set(key, res.data, ttl);
    }

    function recap(streamId) {
        const id = streamIdOf(streamId);
        if (!id) return null;
        return sharedRecap(`recap:${id}`, `/api/recap/${id}`, TTL.recap, 'live recap');
    }

    function channelRecaps(username) {
        if (!isUsername(username)) return null;
        const key = username.toLowerCase();
        return sharedRecap(`recaps:channel:${key}`, `/api/recap/channel/${encodeURIComponent(username)}`, TTL.channelRecaps, 'live channel recaps');
    }

    return { rundown, topics, topic, episode, speaker, recap, channelRecaps, cache, baseUrl, ttlMs: TTL, settled: () => Promise.all([...refreshing.values()]) };
}

module.exports = { createLiveClient, TTL };
