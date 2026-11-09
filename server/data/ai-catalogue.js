'use strict';

const { requestJson, trim } = require('./source');

const TTL_MS = 120_000;
function createAiCatalogue({ config = {}, fetchImpl = globalThis.fetch, log = console, now = () => Date.now(), timeoutMs } = {}) {
    const baseUrl = trim(config.aiUrl || 'https://ai.openvibe.services');
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
    return { catalog, baseUrl, ttlMs: TTL_MS };
}

module.exports = { createAiCatalogue, TTL_MS };
