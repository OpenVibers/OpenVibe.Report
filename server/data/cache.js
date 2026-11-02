'use strict';

/**
 * A small in-memory cache for the two source clients: a Map with an expiry per entry, 1000 entries at most and
 * the oldest inserted entry dropped first. Read APIs are public and change slowly, so a page view is usually a
 * cache hit; a process restart is the only thing that empties it.
 *
 *   const cache = createCache({ max: 1000, now: () => Date.now() });
 *   cache.get(key)                 undefined when absent or expired
 *   cache.peek(key, staleMs)       the value even past its expiry, while it expired under staleMs ago (else undefined)
 *   cache.set(key, value, ttlMs)
 * An expired entry stays until it is replaced or pushed out, so a client can serve it while it refreshes.
 */
function createCache({ max = 1000, now = () => Date.now() } = {}) {
    const entries = new Map();
    const clock = typeof now === 'function' ? now : () => Date.now();

    function get(key) {
        const hit = entries.get(key);
        if (!hit) return undefined;
        if (hit.expiresAt <= clock()) return undefined;
        // Do not move it to the end: "oldest out" means insertion order, not least-recently-used.
        return hit.value;
    }

    function set(key, value, ttlMs) {
        entries.delete(key);
        entries.set(key, { value, expiresAt: clock() + Math.max(0, Number(ttlMs) || 0) });
        while (entries.size > Math.max(1, Number(max) || 1)) {
            const oldest = entries.keys().next().value;
            entries.delete(oldest);
        }
        return value;
    }

    function peek(key, staleMs = 0) {
        const hit = entries.get(key);
        if (!hit || clock() - hit.expiresAt >= Math.max(0, Number(staleMs) || 0)) return undefined;
        return hit.value;
    }

    return {
        get,
        peek,
        set,
        delete: (key) => entries.delete(key),
        get size() { return entries.size; },
    };
}

module.exports = { createCache };
