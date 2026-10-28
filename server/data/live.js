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
const { trim, requestJson, isSlug, streamIdOf, isUsername, TIMEOUT_MS } = require('./source');

const TTL = {
    rundown: 2 * 60_000,
    topics: 5 * 60_000,
    topic: 5 * 60_000,
    episode: 5 * 60_000,
    speaker: 5 * 60_000,
    recap: 10 * 60_000,
    channelRecaps: 5 * 60_000,
};

/**
 * opts: config ({ liveUrl }), fetchImpl, log, now, timeoutMs, cacheMax
 */
function createLiveClient({ config = {}, fetchImpl = globalThis.fetch, log = console, now = () => Date.now(), timeoutMs = TIMEOUT_MS, cacheMax = 1000 } = {}) {
    const baseUrl = trim(config.liveUrl || config.liveInternalUrl || 'http://127.0.0.1:3000');
    const cache = createCache({ max: cacheMax, now });

    async function cached(key, path, ttl, label) {
        const hit = cache.get(key);
        if (hit !== undefined) return hit;
        const data = await requestJson(`${baseUrl}${path}`, { fetchImpl, log, timeoutMs, label });
        if (data === null) return null;
        return cache.set(key, data, ttl);
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

    function recap(streamId) {
        const id = streamIdOf(streamId);
        if (!id) return null;
        return cached(`recap:${id}`, `/api/recap/${id}`, TTL.recap, 'live recap');
    }

    function channelRecaps(username) {
        if (!isUsername(username)) return null;
        const key = username.toLowerCase();
        return cached(`recaps:channel:${key}`, `/api/recap/channel/${encodeURIComponent(username)}`, TTL.channelRecaps, 'live channel recaps');
    }

    return { rundown, topics, topic, episode, speaker, recap, channelRecaps, cache, baseUrl, ttlMs: TTL };
}

module.exports = { createLiveClient, TTL };
