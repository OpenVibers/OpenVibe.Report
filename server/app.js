'use strict';

/**
 * OpenVibe.Report — Express app factory. server/index.js listens; tests build their own instance with a stub
 * fetch so no test needs the network or a running site.
 *
 *   /, /stats, /rundown, /rundown/t/:slug, /rundown/e/:streamId, /rundown/s/:username,
 *   /after-show/:streamId, /c/:username                       the pages (http/pages.js)
 *   /you                                                       your own numbers, signed in (plan L41 R1)
 *   /auth/*                                                    sign-in with OpenVibe.Network (openvibe-sdk/sso)
 *   /ai, /ai/models/:model, /ai/:kind                         the AI boards, from OpenVibe.Bench (http/pages.js)
 *   /api/v1/*                                                  the JSON API (http/api.js)
 *   /robots.txt, /sitemap.xml, /llms.txt                       crawl artifacts (http/discovery.js)
 *   /api/health, /api/ready, /release.json, /release-metrics   the plumbing (loopback scrape for /metrics)
 *
 * Report has its own database (server/db.js, migrations/) for the analytics it ingests, and reads Billing's money
 * through Billing's read API. The pages and GET /api/v1/stats answer from REPORT_SOURCE (network by default,
 * report after cutover); Report's tables are written by the ingest job and by OpenVibe.Events. The only session is
 * the person's own sign-in (openvibe-sdk/sso, the `report` client): it reads /you and nothing else.
 */
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const contracts = require('openvibe-contracts');
const cache = require('openvibe-shared/cache-policy');

const configLib = require('./config');
const { openStore } = require('./db');
const { createNetworkClient } = require('./data/network');
const { createLiveClient } = require('./data/live');
const { createBillingClient } = require('./data/billing');
const { createBenchClient } = require('./data/bench');
const { createAnalytics } = require('./analytics');
const { createAiUsage } = require('./analytics/ai-usage');
const { createAiExchange } = require('./analytics/ai-exchange');
const createAiExchangeConfig = require('./ai-exchange-config').create;
const { createSearchIndex } = require('./search-index');
const { createShadow } = require('./analytics/shadow');
const { createApi } = require('./http/api');
const { createPageRoutes, createPublicPages } = require('./http/pages');
const { createDiscoveryRoutes } = require('./http/discovery');
const { createInternalRoutes } = require('./http/internal');
const { createServiceReadiness } = require('./observability');
const { createSsoClient } = require('openvibe-sdk/sso');
const views = require('./views');
const { PUBLIC_DIR, assetVersion } = require('./assets');

const VERSION = require('../package.json').version;
const PAGE_CACHE = 'public, max-age=120';

/** opts: config, store, fetchImpl, log, now, network, live, billing, analytics, shadow, sso, releaseEnv */
async function createApp(opts = {}) {
    const config = opts.config || configLib.load();
    const log = opts.log || console;
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    const now = opts.now || (() => Date.now());

    // `store: null` is a deliberate no-database process (most unit tests); undefined opens the configured one.
    const store = opts.store !== undefined ? opts.store : await openStore(config, { now, log });
    const network = opts.network || createNetworkClient({ config, fetchImpl, log, now });
    const live = opts.live || createLiveClient({ config, fetchImpl, log, now });
    const billing = opts.billing || createBillingClient({ config, fetchImpl, log, now });
    const bench = opts.bench || createBenchClient({ config, fetchImpl, log, now });
    // D11 owner settings (report.ai_exchange): the switch is read through the store, env pins winning. Report can
    // run without a database (a network-only front): then there is no store and the env value is all there is.
    const exchangeConfig = store ? await createAiExchangeConfig({ db: store.db, config, env: opts.env || process.env, now, log, onActivate: opts.onConfigActivate }) : null;
    if (exchangeConfig) Object.defineProperty(config.aiExchange, 'enabled', { enumerable: true, configurable: true, get: () => exchangeConfig.get('enabled') });
    const analytics = opts.analytics || createAnalytics({ config, store, network, billing, now, log, aiExchange: () => Boolean(config.aiExchange && config.aiExchange.enabled) });
    // The AI ledger (plan L40/L41): the records of every AI call on the network and their roll-ups.
    const aiUsage = opts.aiUsage || createAiUsage({ store, now, log });
    // AI Exchange analytics (G-P9, flag off): Billing's settlements, aggregated. No database, no ledger.
    const aiExchange = opts.aiExchange !== undefined ? opts.aiExchange : (store ? createAiExchange({ store, now, log }) : null);
    const shadow = opts.shadow || (store ? createShadow({ store, network, now, log }) : null);
    // The Rundown topic pages in OpenVibe.Search (started by server/index.js, never under REPORT_DRILL).
    const searchIndex = opts.searchIndex || (store ? createSearchIndex({ config, store, live, log }) : null);
    views.configure({ baseUrl: config.baseUrl });

    // A person's sign-in (the `report` client, the same id and secret Report already reads Billing with).
    const sso = opts.sso || createSsoClient({
        site: 'report', baseUrl: config.baseUrl, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        networkUrl: config.networkPublicUrl, networkInternalUrl: config.networkInternalUrl,
        secureCookies: /^https:/.test(config.baseUrl), fetch: fetchImpl, log,
    });

    const ctx = { config, log, fetchImpl, now, store, network, live, billing, bench, analytics, shadow, sso, aiUsage, aiExchange, searchIndex, exchangeConfig };
    const app = express();
    if (exchangeConfig) exchangeConfig.mount(app);
    // GET /openapi.json (SEO-3): this service's public API as OpenAPI 3.1, generated from the contracts
    // (openvibe-contracts); the operations they mark internal-only are left out.
    app.get('/openapi.json', (_req, res) => {
        const doc = require('openvibe-contracts').openapi.document('report');
        if (!doc) return res.status(404).type('text/plain').send('No API document.');
        const METHODS = new Set(['get', 'put', 'post', 'delete', 'patch', 'head', 'options']);
        const paths = {};
        for (const [p, item] of Object.entries(doc.paths || {})) {
            const kept = {};
            for (const [k, op] of Object.entries(item || {})) {
                if (!METHODS.has(k)) { kept[k] = op; continue; }
                const vis = [].concat((op && op['x-openvibe-visibility']) || []);
                if (vis.length && vis.every((v) => v === 'internal')) continue;
                kept[k] = op;
            }
            if (Object.keys(kept).some((k) => METHODS.has(k))) paths[p] = kept;
        }
        res.set('Cache-Control', 'public, max-age=3600').set('Access-Control-Allow-Origin', '*').json({ ...doc, paths });
    });
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
    const readiness = createServiceReadiness({ config, fetchImpl, release: release.release, store });
    ctx.readiness = readiness;
    app.get('/api/ready', readiness.handler);

    // ── Static assets: this site's own (content-hashed ?v= → immutable) and the Shared Frame ──
    require('./views').setRelease(release && release.release);
    app.use('/shared', require('openvibe-shared/serve').handler());
    // Terms, Privacy and DMCA in this site's own words (openvibe-shared/legal, profile 'public'; 11-03: the footer's
    // legal links answered 404 here). The facts must match the code: change both together.
    const legal = require('openvibe-shared/legal');
    app.get(legal.PATHS, legal.handler({
        "host": "openvibe.report",
        "name": "OpenVibe.Report",
        "id": "report",
        "service": "report",
        "profile": "public",
        "what": "The network's numbers open to everyone, what streamers talked about in The Rundown, and every stream's after-show report, each number with its definition and its date."
    }));
    app.use(express.static(PUBLIC_DIR, {
        index: false,
        redirect: false,
        setHeaders(res, filePath) {
            const rel = path.relative(PUBLIC_DIR, filePath).split(path.sep).join('/');
            const v = res.req && res.req.query && res.req.query.v;
            res.setHeader('Cache-Control', cache.assetHeaders(rel, { hashed: !!v && v === assetVersion(rel) }));
        },
    }));

    // ── Sign-in (/auth/login, /callback, /fedcm, /logout, /me, /refresh); req.user on every later route ──
    app.use('/auth', sso.router(express));
    app.use(sso.optionalAuth());

    // ── Loopback-only operator and Events routes ────────────
    app.use('/internal', createInternalRoutes({ analytics, shadow, config, now, log }));

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
    app.use('/api/v1', createApi({ network, live, analytics, aiUsage, aiExchange, config, now, log }));
    app.use('/api', (req, res) => contracts.http.sendProblem(res, 404, 'route.not_found', { detail: 'No such API route', ctx: req.ov }));

    // ── Crawl artifacts, then the pages ─────────────────────
    app.use(createDiscoveryRoutes(ctx));
    // The agent layer (openvibe-shared/agent-layer): /.well-known/agent.json and each twinned page's Markdown twin. It
    // mounts after the page routes, which keep their own cache policy and answer the HTML (with the discovery links),
    // and before the 404, so an unknown twin is still a 404. A .md path skips the page routes (http/pages.js).
    const publicPages = createPublicPages(ctx);
    app.use(createPageRoutes({ ...ctx, publicPages }));
    require('openvibe-shared/agent-layer').mount(app, {
        descriptor: require('./agent-descriptor'),
        render: require('./agent-pages').createAgentPages({ publicPages, bench }).renderPublicPage,
    });
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
