'use strict';
/**
 * OpenVibe.Search's trending searches (plan 2026-11-13 §AD.13 (1)): GET /api/v1/trending/stats?days=1..7 — searches by
 * day and by site, and the rising searches (a query shows once 5 or more people searched it). Aggregates only: no
 * visitor, no person. Kept five minutes; Search not answering is null (the page says so).
 */
const { createCache } = require('./cache');
const { trim, requestJson, TIMEOUT_MS } = require('./source');

const TTL_MS = 5 * 60_000;

function createSearchTrendsClient({ config = {}, fetchImpl = globalThis.fetch, log = console, now = () => Date.now(), timeoutMs = TIMEOUT_MS } = {}) {
    const baseUrl = trim(config.searchUrl || 'http://127.0.0.1:4710');
    const cache = createCache({ max: 20, now });
    async function stats(days = 7) {
        const d = Math.max(1, Math.min(7, Number(days) || 7));
        const hit = cache.get(d);
        if (hit !== undefined) return hit;
        const data = await requestJson(`${baseUrl}/api/v1/trending/stats?days=${d}`, { fetchImpl, log, timeoutMs, label: `search trends (${d}d)` });
        if (data === null) return null;
        return cache.set(d, data, TTL_MS);
    }
    return { stats };
}

module.exports = { createSearchTrendsClient };
