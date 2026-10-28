'use strict';

/**
 * Truthful readiness for GET /api/ready (openvibe-shared/ready, Track O).
 *
 * Report has no database, no sessions and no queues: its only dependencies are the two loopback read APIs.
 * Both checks are optional, so a source that does not answer makes the service degraded, never not_ready:
 * the process still serves the pages it can and the 503 would stop the deploy of a stateless front.
 *
 *   network   optional  OpenVibe.Network answers /api/health
 *   live      optional  OpenVibe.Live answers /api/health
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

    return createReadiness({
        service: 'report',
        release,
        timeoutMs: config.readyTimeoutMs || 2500,
        checks: [
            healthOf('network', config.networkUrl),
            healthOf('live', config.liveUrl),
        ],
    });
}

module.exports = { createServiceReadiness };
