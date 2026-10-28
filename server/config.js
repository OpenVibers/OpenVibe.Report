'use strict';

/**
 * OpenVibe.Report configuration. Every value comes from the environment (production: /etc/openvibe/report.env,
 * see .env.example). load(env) is pure so tests can build a config without touching process.env.
 *
 * Report is stateless: it has no database, no sessions and no events. It reads two loopback APIs:
 * OpenVibe.Network's open stats and OpenVibe.Live's Rundown and after-show reports.
 */
require('dotenv').config();

const trim = (s) => String(s || '').replace(/\/+$/, '');
const int = (v, def) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : def);

function load(env = process.env) {
    const nodeEnv = env.NODE_ENV || 'development';
    const isProduction = nodeEnv === 'production';
    const port = int(env.PORT, 5080);
    const baseUrl = trim(env.BASE_URL || (isProduction ? 'https://openvibe.report' : `http://localhost:${port}`));

    return {
        service: 'report',
        name: 'OpenVibe.Report',
        port,
        host: env.HOST || '127.0.0.1',
        nodeEnv,
        isProduction,
        baseUrl,
        trustProxy: env.TRUST_PROXY != null ? Number(env.TRUST_PROXY) : 2,

        // The two sources. Both serve these read APIs on loopback; manifests/services/{network,live}.json in
        // openvibe-contracts name the same defaults.
        networkUrl: trim(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000'),
        liveUrl: trim(env.OV_LIVE_INTERNAL_URL || 'http://127.0.0.1:3000'),

        // One caller may make this many API requests a minute (express-rate-limit, keyed by address).
        apiRateLimitPerMinute: Math.max(1, int(env.REPORT_API_RATE_LIMIT_PER_MIN, 120)),

        // How long a readiness probe may take before the source is reported as not answering.
        readyTimeoutMs: Math.max(200, int(env.REPORT_READY_TIMEOUT_MS, 2500)),
    };
}

module.exports = { load };
