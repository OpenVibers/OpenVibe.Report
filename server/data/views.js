'use strict';

/**
 * OpenVibe.Media's view store: the one place every kind's views and engaged viewers are counted (POST /api/v1/views on
 * Media; Media's GET /api/v1/views/aggregate answers here). Report quotes the numbers, it never derives them.
 *
 * → { scope, id, days, from, to, rows: [{ id, service?, kind?, item_id?, site, creator, views, engaged, previews,
 *      preview_share, peak_concurrent }], totals: { views, engaged, previews, preview_share, peak_concurrent } }
 *
 * A source that does not answer is null (the page leaves the section out, never a zero); rows are kept 60 seconds.
 */
const { trim } = require('./source');

const TTL_MS = 60_000;
const MAX = 300;

function createViewsClient({ config = {}, fetchImpl = globalThis.fetch, log = console, timeoutMs = 4000, now = () => Date.now() } = {}) {
    const baseUrl = trim(config.mediaUrl || 'http://127.0.0.1:4100');
    const cache = new Map();
    const inflight = new Map();

    async function load(query) {
        const key = JSON.stringify(query);
        const kept = cache.get(key);
        if (kept && now() - kept.at < TTL_MS) return kept.data;
        if (inflight.has(key)) return await inflight.get(key);
        const p = (async () => {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), timeoutMs);
            try {
                const u = new URL(`${baseUrl}/api/v1/views/aggregate`);
                for (const [k, v] of Object.entries(query)) if (v != null && v !== '') u.searchParams.set(k, String(v));
                const res = await fetchImpl(u.href, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
                if (!res.ok) return null;
                const data = await res.json();
                if (!data || !Array.isArray(data.rows)) return null;
                if (cache.size >= MAX) cache.clear();
                cache.set(key, { at: now(), data });
                return data;
            } catch (err) {
                if (log && typeof log.warn === 'function') log.warn('[views] Media did not answer:', err && err.message);
                return null;
            } finally { clearTimeout(timer); }
        })().finally(() => inflight.delete(key));
        inflight.set(key, p);
        return await p;
    }

    return {
        /** One item's numbers (service and kind name the owner and type). */
        item({ service, kind, id, days = 30 } = {}) {
            if (!service || !kind || id == null) return null;
            return load({ scope: 'item', service, kind, id, days });
        },
        creator(id, days = 30) {
            if (!id) return null;
            return load({ scope: 'creator', id, days });
        },
        site(id, days = 30) {
            if (!id) return null;
            return load({ scope: 'site', id, days });
        },
        /** The three dimensions at once: items, creators and sites for the room's tables. */
        async top(days = 30) {
            const [items, creators, sites] = await Promise.all([
                load({ scope: 'item', days, limit: 12 }),
                load({ scope: 'creator', days, limit: 12 }),
                load({ scope: 'site', days, limit: 24 }),
            ]);
            if (!items && !creators && !sites) return null;
            return { days, items, creators, sites };
        },
    };
}

module.exports = { createViewsClient, TTL_MS };
