'use strict';

const { requestJson, trim } = require('./source');

const TTL_MS = 120_000;
function createAiCatalogue({ config = {}, fetchImpl = globalThis.fetch, log = console, now = () => Date.now(), timeoutMs } = {}) {
    const baseUrl = trim(config.aiUrl || 'https://api.openvibe.exchange');
    let hit = null;
    let pending = null;
    async function catalog() {
        if (hit && hit.expires > now()) return hit.value;
        if (!pending) pending = (async () => {
            const data = await requestJson(`${baseUrl}/api/v1/exchange/catalog`, { fetchImpl, log, label: 'ai exchange catalog', timeoutMs });
            if (data && Array.isArray(data.models)) hit = { value: data, expires: now() + TTL_MS };
            pending = null;
            return data && Array.isArray(data.models) ? data : null;
        })();
        return pending;
    }
    let marketHit = null; let marketPending = null;
    async function market() {
        if (marketHit && marketHit.expires > now()) return marketHit.value;
        if (!marketPending) marketPending = (async () => {
            const offers = []; const seen = new Set(); let cursor = null; let first = null;
            do {
                const suffix = cursor == null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
                const data = await requestJson(`${baseUrl}/api/v1/exchange/market?limit=500${suffix}`, { fetchImpl, log, label: 'ai exchange market', timeoutMs });
                if (!data || !Array.isArray(data.offers) || !('next_cursor' in data) || (data.next_cursor != null && typeof data.next_cursor !== 'string') || (first && first.generated_at !== data.generated_at) || seen.has(data.next_cursor) || seen.size > 1000) {
                    const value = marketHit ? { ...marketHit.value, stale: true } : null;
                    marketHit = { value, expires: now() + TTL_MS };
                    return value;
                }
                first ||= data; offers.push(...data.offers); cursor = data.next_cursor;
                if (cursor != null) seen.add(cursor);
            } while (cursor != null);
            const value = { ...first, offers, next_cursor: null, stale: false };
            marketHit = { value, expires: now() + TTL_MS }; return value;
        })().finally(() => { marketPending = null; });
        return marketPending;
    }
    return { catalog, market, baseUrl, ttlMs: TTL_MS };
}

module.exports = { createAiCatalogue, TTL_MS };
