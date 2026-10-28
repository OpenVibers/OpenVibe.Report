'use strict';

/**
 * Truthful readiness for GET /api/ready (openvibe-shared/ready, Track O).
 *
 * The two loopback read APIs are optional: a source that does not answer makes the service degraded, never
 * not_ready, because the process still serves the pages it can. When a PostgreSQL database is configured, its
 * check is required only after REPORT_SOURCE=report (before the cutover it is Report's shadow store, not the
 * answer to a page).
 *
 *   network   optional  OpenVibe.Network answers /api/health
 *   live      optional  OpenVibe.Live answers /api/health
 *   db        required only when REPORT_SOURCE=report, and only when DATABASE_URL is configured
 */
const { createReadiness } = require('openvibe-shared/ready');

function createServiceReadiness({ config, fetchImpl = globalThis.fetch, release = null }) {
    const healthOf = (name, origin) => ({
        name,
        required: false,
        description: `${name} answers its health endpoint`,
        async check() {
            const url = `${String(origin || '').replace(/\/+$/, '')}/api/health`;
            try {
                const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
                    ? AbortSignal.timeout(config.readyTimeoutMs || 2500)
                    : undefined;
                const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal });
                if (res && res.ok) return true;
                return `${name} answered HTTP ${res ? res.status : 'nothing'}`;
            } catch (err) {
                return `${name} did not answer: ${(err && err.message) || 'fetch failed'}`;
            }
        },
    });

    const checks = [
        healthOf('network', config.networkUrl),
        healthOf('live', config.liveUrl),
    ];
    if (config.db && config.db.url) {
        checks.push({
            name: 'db',
            required: config.source === 'report',
            description: 'Report\'s PostgreSQL database answers',
            async check() {
                if (!store || !store.db) return 'no database handle';
                try { await store.db.value('SELECT 1'); return true; } catch (err) { return `database did not answer: ${(err && err.message) || 'query failed'}`; }
            },
        });
    }
    return createReadiness({
        service: 'report',
        release,
        timeoutMs: config.readyTimeoutMs || 2500,
        checks,
    });
}

module.exports = { createServiceReadiness };
