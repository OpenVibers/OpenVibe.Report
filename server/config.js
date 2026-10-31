'use strict';

/**
 * OpenVibe.Report configuration. Every value comes from the environment (production: /etc/openvibe/report.env,
 * see .env.example). load(env) is pure so tests can build a config without touching process.env.
 *
 * Report reads Network's open stats and Live's Rundown and after-show reports over loopback. It also has its own
 * PostgreSQL database (migrations/) for the analytics it ingests, and reads revenue from Billing. REPORT_SOURCE
 * chooses which side the pages and GET /api/v1/stats answer from: `network` (today's behaviour) or `report`.
 * The AI boards under /ai read OpenVibe.Bench's public boards the same way.
 */
require('dotenv').config();

const trim = (s) => String(s || '').replace(/\/+$/, '');
const int = (v, def) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : def);
const bool = (v, def = false) => (v == null || v === '' ? def : !/^(0|false|no|off)$/i.test(String(v)));
const sourceOf = (v) => (String(v || '').toLowerCase() === 'report' ? 'report' : 'network');
// A PEM in one line carries two-character escapes for its line breaks; this turns them back into newlines.
const unescapePem = (v) => String(v || '').split(String.fromCharCode(92) + 'n').join('\n');

function load(env = process.env) {
    const nodeEnv = env.NODE_ENV || 'development';
    const isProduction = nodeEnv === 'production';
    const port = int(env.PORT, 5080);
    const baseUrl = trim(env.BASE_URL || (isProduction ? 'https://openvibe.report' : `http://localhost:${port}`));
    const networkPublicUrl = trim(env.OV_NETWORK_URL || 'https://openvibe.network');

    return {
        service: 'report',
        name: 'OpenVibe.Report',
        port,
        host: env.HOST || '127.0.0.1',
        nodeEnv,
        isProduction,
        baseUrl,
        trustProxy: env.TRUST_PROXY != null ? Number(env.TRUST_PROXY) : 2,

        // Which source answers the pages and the stats API. `network` is the shadowing default: the pages keep
        // reading where they read today until an operator sets REPORT_SOURCE=report.
        source: sourceOf(env.REPORT_SOURCE),

        // The two read-only sources. Both serve these APIs on loopback; manifests/services/{network,live}.json in
        // openvibe-contracts name the same defaults.
        // networkUrl is the loopback origin the read clients call (the manifest's internalOrigin).
        networkUrl: trim(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000'),
        networkPublicUrl,
        networkInternalUrl: trim(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000'),
        liveUrl: trim(env.OV_LIVE_INTERNAL_URL || 'http://127.0.0.1:3000'),

        // OpenVibe.Bench's public reads (kinds, boards, models, datasets) — the AI boards under /ai. Public HTML
        // boards render here; Bench stays the benchmark authority that owns the numbers.
        benchUrl: trim(env.OV_BENCH_INTERNAL_URL || 'https://bench.openvibe.services'),

        // Report's own database (ADR-035). DATABASE_URL serves (PgBouncer), DATABASE_DIRECT_URL migrates (owner
        // role); development without DATABASE_URL uses an embedded PGlite database under REPORT_PGLITE_DIR.
        db: { url: env.DATABASE_URL || '', directUrl: env.DATABASE_DIRECT_URL || '', pgliteDir: env.REPORT_PGLITE_DIR || '' },

        // OpenVibe.Billing's read API. Report holds no money and derives none: it quotes the amounts Billing
        // returns. The service token needs billing.stats.read (GET /api/v1/stats) and billing.balance.read
        // (GET /api/v1/transactions?subject=… for one channel's settled revenue and refunds).
        billing: {
            url: trim(env.OV_BILLING_INTERNAL_URL || 'http://127.0.0.1:4600'),
            token: env.REPORT_BILLING_TOKEN || '',
            timeoutMs: Math.max(300, int(env.REPORT_BILLING_TIMEOUT_MS, 5000)),
        },
        oauth: {
            tokenUrl: trim(env.OV_NETWORK_OAUTH_TOKEN_URL || `${networkPublicUrl}/oauth/token`),
            clientId: env.OV_OAUTH_CLIENT_ID || 'report',
            clientSecret: env.OV_OAUTH_CLIENT_SECRET || '',
        },

        // OpenVibe.Network's signing keys, for the operator routes that need a service token: a pinned PEM
        // (OV_NETWORK_PUBLIC_KEY) or the JWKS the SDK's client fetches.
        networkPublicKey: env.OV_NETWORK_PUBLIC_KEY ? unescapePem(env.OV_NETWORK_PUBLIC_KEY) : null,
        networkJwksUrl: `${trim(env.OV_NETWORK_JWKS_URL || env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000')}/api/.well-known/jwks`,
        issuer: trim(env.OV_NETWORK_ISSUER || networkPublicUrl),

        // Drill mode: the jobs that would change numbers stay off while a drill runs.
        drill: env.REPORT_DRILL === '1' || env.REPORT_DRILL === 'true',

        // OpenVibe.Events → Report: live.stream.ended and the frame beacon. The secret signs a delivery (comma
        // separated for rotation, 32+ characters each); unset makes POST /internal/events answer 503.
        events: {
            secrets: String(env.REPORT_EVENTS_SECRET || '').split(',').map((x) => x.trim()).filter((x) => x.length >= 32),
        },

        // The ingest and shadow jobs. REPORT_JOBS=0 turns both off (tests do this by never starting them).
        jobs: {
            enabled: bool(env.REPORT_JOBS, true),
            onBoot: bool(env.REPORT_JOBS_ON_BOOT, true),
            ingestIntervalMs: Math.max(30_000, int(env.REPORT_INGEST_INTERVAL_MS, 5 * 60_000)),
            ingestWindows: [7, 30, 90],
            shadowIntervalMs: Math.max(30_000, int(env.REPORT_SHADOW_INTERVAL_MS, 15 * 60_000)),
            shadowWindowDays: [7, 30, 90].includes(Number(env.REPORT_SHADOW_WINDOW_DAYS)) ? Number(env.REPORT_SHADOW_WINDOW_DAYS) : 7,
            // The AI meter (plan L40/L41): the daily roll-up of the usage records, and the pruning of the raw records.
            aiUsageIntervalMs: Math.max(60_000, int(env.REPORT_AI_USAGE_INTERVAL_MS, 60 * 60_000)),
            aiUsageRollupDays: Math.max(1, int(env.REPORT_AI_USAGE_ROLLUP_DAYS, 14)),
            aiUsageRetentionDays: Math.max(1, int(env.REPORT_AI_USAGE_RETENTION_DAYS, 90)),
        },

        // One caller may make this many API requests a minute (express-rate-limit, keyed by address).
        apiRateLimitPerMinute: Math.max(1, int(env.REPORT_API_RATE_LIMIT_PER_MIN, 120)),
        // A person's own narrow routes (GET /api/v1/me/ai/usage) have their own, tighter per-address limit.
        meRateLimitPerMinute: Math.max(1, int(env.REPORT_ME_RATE_LIMIT_PER_MIN, 60)),

        // How long a readiness probe may take before the source is reported as not answering.
        readyTimeoutMs: Math.max(200, int(env.REPORT_READY_TIMEOUT_MS, 2500)),
    };
}

module.exports = { load };
