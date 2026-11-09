'use strict';

/**
 * OpenVibe.Network's open stats: GET /api/v1/stats?days=7|30|90.
 *
 * The answer is public counts only. It is held for five minutes in this process and a failure answers null
 * (after one short log line), never an exception: a page renders "not available", never a made-up zero.
 */
const { createCache } = require('./cache');
const { trim, requestJson, normaliseDays, TIMEOUT_MS } = require('./source');

const STATS_TTL_MS = 5 * 60_000;

/**
 * opts: config ({ networkUrl }), fetchImpl, log, now, timeoutMs, cacheMax
 */
function createNetworkClient({ config = {}, fetchImpl = globalThis.fetch, log = console, now = () => Date.now(), timeoutMs = TIMEOUT_MS, cacheMax = 1000 } = {}) {
    const baseUrl = trim(config.networkUrl || config.networkInternalUrl || 'http://127.0.0.1:4000');
    const cache = createCache({ max: cacheMax, now });

    /** The numbers for the last 7, 30 or 90 days; 30 for anything else. */
    async function stats(days) {
        const window = normaliseDays(days);
        const hit = cache.get(window);
        if (hit !== undefined) return hit;
        const data = await requestJson(`${baseUrl}/api/v1/stats?days=${window}`, {
            fetchImpl, log, timeoutMs, label: `network stats (${window}d)`,
        });
        if (data === null) return null;
        return cache.set(window, data, STATS_TTL_MS);
    }

    /**
     * The person's own cross-site history (GET /api/history), with their own Network session token. Report's sign-in
     * token is a Network user session (openvibe-sdk/sso, audience openvibe.network + report), so Network answers it.
     * Returns the rows, or null when Network cannot answer. Never cached: it is one person's and changes.
     */
    async function history(token, { limit = 200 } = {}) {
        const bearer = typeof token === 'string' ? token.trim() : '';
        if (!bearer) return null;
        const cap = Math.max(1, Math.min(200, Number(limit) || 200));
        const data = await requestJson(`${baseUrl}/api/history?limit=${cap}`, {
            fetchImpl, log, timeoutMs, label: 'network history', headers: { Authorization: `Bearer ${bearer}` },
        });
        if (!data || !Array.isArray(data.items)) return null;
        return data.items;
    }

    return { stats, history, cache, baseUrl, ttlMs: STATS_TTL_MS };
}

module.exports = { createNetworkClient, STATS_TTL_MS };
