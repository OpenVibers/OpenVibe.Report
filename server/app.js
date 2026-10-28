'use strict';

/**
 * OpenVibe.Report — Express app factory. server/index.js listens; tests build their own instance with a stub
 * fetch so no test needs the network or a running site.
 *
 *   /, /stats, /rundown, /rundown/t/:slug, /rundown/e/:streamId, /rundown/s/:username,
 *   /after-show/:streamId, /c/:username                       the pages (http/pages.js)
 *   /api/v1/*                                                  the JSON API (http/api.js)
 *   /robots.txt, /sitemap.xml, /llms.txt                       crawl artifacts (http/discovery.js)
 *   /api/health, /api/ready, /release.json, /release-metrics   the plumbing (loopback scrape for /metrics)
 *
 * The service is stateless: no database, no sessions and no events. The two source clients are the only state
 * (their in-process caches). The plumbing is the skeleton's, modelled on OpenVibe.Help.
 */
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const contracts = require('openvibe-contracts');
const cache = require('openvibe-shared/cache-policy');

const configLib = require('./config');
const { createNetworkClient } = require('./data/network');
const { createLiveClient } = require('./data/live');
const { createApi } = require('./http/api');
const { createPageRoutes } = require('./http/pages');
const { createDiscoveryRoutes } = require('./http/discovery');
const { createServiceReadiness } = require('./observability');
const views = require('./views');
const { PUBLIC_DIR, assetVersion } = require('./assets');

const VERSION = require('../package.json').version;
const PAGE_CACHE = 'public, max-age=120';

/** opts: config, fetchImpl, log, now, network, live, releaseEnv */
async function createApp(opts = {}) {
    const config = opts.config || configLib.load();
    const log = opts.log || console;
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    const now = opts.now || (() => Date.now());

    const network = opts.network || createNetworkClient({ config, fetchImpl, log, now });
    const live = opts.live || createLiveClient({ config, fetchImpl, log, now });
    views.configure({ baseUrl: config.baseUrl });

    const ctx = { config, log, fetchImpl, now, network, live };
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);

    // Request context (traceparent + X-OpenVibe-Request-Id, req.ov) for every response, including problem+json.
    app.use(contracts.http.middleware());

    // The OpenVibe Frame (theme-loader, navbar, footer) comes from this site's /shared copy; the inline boot is ours.
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network', 'https://static.cloudflareinsights.com'],
                styleSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network', 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
                fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
                imgSrc: ["'self'", 'data:', 'https://openvibe.network', 'https://openvibe.media'],
                connectSrc: ["'self'", 'https://openvibe.network', 'https://cloudflareinsights.com', 'https://openvibe.events'],
                frameSrc: ["'self'", 'https://openvibe.network'],
                frameAncestors: ["'none'"],
                objectSrc: ["'none'"],
                baseUri: ["'self'"],
                formAction: ["'self'", 'https://openvibe.network'],
            },
        },
        frameguard: { action: 'deny' },
        crossOriginEmbedderPolicy: false,
        crossOriginResourcePolicy: { policy: 'same-site' },
        referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }));

    // ── Release metadata and Prometheus metrics (the metrics route stays host-local in nginx) ──
    const release = require('openvibe-shared/release').createRelease({
        service: 'report',
        root: path.join(__dirname, '..'),
        env: opts.releaseEnv || process.env,
    });
    const metrics = require('openvibe-shared/metrics').instrument(app, { service: 'report', release: release.release });
    app.locals.metrics = metrics.registry;
    app.locals.ctx = ctx;
    ctx.release = release;
    ctx.metrics = metrics.registry;
    ctx.metricsStop = metrics.stop;

    // ── Machine endpoints ───────────────────────────────────
    app.get('/api/health', (_req, res) => res.set('Cache-Control', 'no-store').json({ status: 'ok', service: 'openvibe-report', version: VERSION }));
    release.mount(app, { registry: metrics.registry });
    const readiness = createServiceReadiness({ config, fetchImpl, release: release.release });
    ctx.readiness = readiness;
    app.get('/api/ready', readiness.handler);

    // ── Static assets: this site's own (content-hashed ?v= → immutable) and the Shared Frame ──
    require('./views').setRelease(release && release.release);
    app.use('/shared', require('openvibe-shared/serve').handler());
    app.use(express.static(PUBLIC_DIR, {
        index: false,
        redirect: false,
        setHeaders(res, filePath) {
            const rel = path.relative(PUBLIC_DIR, filePath).split(path.sep).join('/');
            const v = res.req && res.req.query && res.req.query.v;
            res.setHeader('Cache-Control', cache.assetHeaders(rel, { hashed: !!v && v === assetVersion(rel) }));
        },
    }));

    // ── API: CORS-open, public for two minutes, 120 requests a minute per address ──
    app.use('/api/v1', (_req, res, next) => {
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Cache-Control', PAGE_CACHE);
        next();
    });
    app.use('/api/v1', rateLimit({
        windowMs: 60_000,
        limit: config.apiRateLimitPerMinute,
        standardHeaders: true,
        legacyHeaders: false,
        handler: (req, res) => contracts.http.sendProblem(res, 429, 'rate_limited', { detail: 'too many requests from this address; retry shortly', ctx: req.ov }),
    }));
    app.use('/api/v1', createApi({ network, live }));
    app.use('/api', (req, res) => contracts.http.sendProblem(res, 404, 'route.not_found', { detail: 'No such API route', ctx: req.ov }));

    // ── Crawl artifacts, then the pages ─────────────────────
    app.use(createDiscoveryRoutes(ctx));
    app.use(createPageRoutes(ctx));
    app.use((_req, res) => {
        res.status(404).set('Cache-Control', PAGE_CACHE).type('html').send(views.notFound());
    });

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, _next) => {
        log.error('[OpenVibe.Report]', err && err.message ? String(err.message).slice(0, 300) : err);
        if (res.headersSent) return;
        if (req.path.startsWith('/api/')) {
            return contracts.http.sendProblem(res, 500, 'internal.error', { detail: 'Internal error', ctx: req.ov });
        }
        return res.status(500).set('Cache-Control', 'no-store').type('text/plain').send('Something went wrong on our side. Try again in a moment.');
    });

    return { app, ctx };
}

module.exports = { createApp };
