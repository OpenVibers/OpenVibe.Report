'use strict';

/**
 * OpenVibe.Report — Express app factory. server/index.js listens; tests build their own instance with a stub
 * fetch so no test needs the network or a running site.
 *
 *   /, /stats, /rundown, /rundown/t/:slug, /rundown/e/:streamId, /rundown/s/:username,
 *   /after-show/:streamId, /c/:username                       the pages (http/pages.js)
 *   /you                                                       your own numbers, signed in (plan L41 R1)
 *   /me, /u/:username                                          a person's stats: private by default, the published
 *                                                              sections at /u (the owner, 2026-11-09)
 *   /auth/*                                                    sign-in with OpenVibe.Network (openvibe-sdk/sso)
 *   /ai, /ai/models/:model, /ai/:kind                         the AI boards, from OpenVibe.Bench (http/pages.js)
 *   /api/v1/*                                                  the JSON API (http/api.js)
 *   /robots.txt, /sitemap.xml, /llms.txt                       crawl artifacts (http/discovery.js)
 *   /api/health, /api/ready, /release.json, /release-metrics   the plumbing (loopback scrape for /metrics)
 *
 * Report has its own database (server/db.js, migrations/) for the analytics it ingests, and reads Billing's money
 * through Billing's read API. The pages and GET /api/v1/stats answer from REPORT_SOURCE (network by default,
 * report after cutover); Report's tables are written by the ingest job and by OpenVibe.Events. The only session is
 * the person's own sign-in (openvibe-sdk/sso, the `report` client): it reads /you, /me and the /u/<name> page a
 * person chose to publish; the only write is the per-section publish switch (PUT/POST /api/v1/me/stats/published).
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
const { createAiCatalogue } = require('./data/ai-catalogue');
const { createAnalytics } = require('./analytics');
const { createAiUsage } = require('./analytics/ai-usage');
const { createAiExchange } = require('./analytics/ai-exchange');
const createAiExchangeConfig = require('./ai-exchange-config').create;
const { createSearchIndex } = require('./search-index');
const { createSessionReports } = require('./session-reports');
const { createMeStats } = require('./me-stats');
const { createSessionReportRoutes } = require('./http/session-reports');
const sharing = require('./sharing');
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

/**
 * The Share sheet's access part (openvibe-sdk/share's router), built on the first request rather than at load (the
 * database opens at boot). It sees only /api/v1/<kind>/<id>/share, /api/v1/shared-with-me and /api/v1/share/people;
 * anything else falls through to Report's own read API.
 *
 * The caller is the signed-in person (Report's own sso session, cookie or bearer). `describe` names a report for the
 * sheet, and the share store itself refuses anyone who is not its owner: a 404 that says nothing about the report.
 */
function shareRouterFor({ log }) {
    let built;
    return function shareRouter(req, res, next) {
        if (!req.path.startsWith('/api/v1/')) return next();
        if (built === undefined) {
            built = sharing.router({
                authenticate: async (request) => sharing.viewerOf(request.user),
                describe: (ref) => sharing.describe(ref),
            }) || null;
        }
        if (!built) return next();
        return built(req, res, next);
    };
}

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
    const aiCatalogue = opts.aiCatalogue || createAiCatalogue({ config, fetchImpl, log, now });
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
    // The report of every agent session (Agent Streams S3): one table, one route, one page.
    const sessionReports = opts.sessionReports || (store ? createSessionReports({ store, config, log }) : null);
    // A person's own numbers (the owner, 2026-11-09): the five sections and the per-section publish switches. The
    // snapshot is stored here; the public page reads only what the person published. With no store, /me computes but
    // nothing can be published.
    const meStats = opts.meStats || createMeStats({ store, network, analytics, aiUsage, sessionReports, config, now, log });
    // The sharing system (openvibe-sdk/share, share.v1): a report's four audiences live in its share row, the owner's
    // Share sheet changes it, and every read path asks canView (server/sharing.js). Built before the session-report
    // writer, so the first write registers its row.
    if (store) sharing.init({ store, network: opts.shareNetwork || null, events: opts.shareEvents || null, notify: opts.shareNotify || null });
    // The Rundown topic pages in OpenVibe.Search (started by server/index.js, never under REPORT_DRILL).
    const searchIndex = opts.searchIndex || (store ? createSearchIndex({ config, store, live, sessionReports, log }) : null);
    if (searchIndex) require('./search-index').setInstance(searchIndex);
    views.configure({ baseUrl: config.baseUrl });

    // A person's sign-in (the `report` client, the same id and secret Report already reads Billing with).
    const sso = opts.sso || createSsoClient({
        site: 'report', baseUrl: config.baseUrl, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        networkUrl: config.networkPublicUrl, networkInternalUrl: config.networkInternalUrl,
        secureCookies: /^https:/.test(config.baseUrl), fetch: fetchImpl, log,
    });

    const ctx = { config, log, fetchImpl, now, store, network, live, billing, bench, aiCatalogue, analytics, shadow, sso, aiUsage, aiExchange, searchIndex, exchangeConfig, sessionReports, meStats };
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
                // Cards show the readings' own pictures: a stream's thumbnail comes from Live and a post's screenshot
                // from Community (the sources of the Rundown's takes), so both origins are allowed here and nowhere wider.
                imgSrc: ["'self'", 'data:', 'https://openvibe.network', 'https://openvibe.media', 'https://openvibe.live', 'https://openvibe.community'],
                connectSrc: ["'self'", 'https://openvibe.network', 'https://openvibe.chat', 'https://cloudflareinsights.com', 'https://openvibe.events'],
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

    // ── The sharing system's HTTP surface (the Share sheet's access part), at /api/v1/<kind>/<id>/share ──
    // Mounted after sign-in, before the read API, so its paths are never read as one of Report's. Absent when the
    // pinned openvibe-sdk predates `share`: then only the old column's three levels work, and a report nobody may open
    // is a 404 — fail closed.
    app.use(shareRouterFor({ log }));
    // The publish switches as a plain form (the /me page's "Make my stats public" rows), so the page works whole
    // without JavaScript. Same origin only; signed in only; answers /me again with the new switches in force. The JSON
    // PUT for apps and the menu lives in the read API below.
    app.post('/api/v1/me/stats/published', express.urlencoded({ extended: false, limit: '4kb' }), async (req, res) => {
        res.set('Cache-Control', 'private, no-store');
        const user = req.user;
        if (!user || !user.subject_id) return res.redirect(303, '/auth/login?next=%2Fme');
        if (!req.headers['x-requested-with'] && !['same-origin', 'same-site'].includes(String(req.headers['sec-fetch-site'] || ''))) {
            return contracts.http.sendProblem(res, 403, 'report.csrf', { detail: 'Cross-site request refused', ctx: req.ov });
        }
        const published = {};
        for (const key of meStats.SECTIONS) {
            const raw = req.body && req.body[key];
            published[key] = (Array.isArray(raw) ? raw[raw.length - 1] : raw) === 'true';
        }
        try {
            await meStats.setPublished({ user, token: req.token, published });
        } catch (err) {
            log.error('[OpenVibe.Report] the stats switches failed:', err && err.message ? String(err.message).slice(0, 200) : err);
        }
        return res.redirect(303, '/me');
    });
    // The owner's default for the reports they make from now on (their own page, /you). Signed in only, same-origin
    // only, and it changes nothing about a report that already exists — the sheet changes those one by one.
    app.post('/api/v1/me/session-reports/default', express.json({ limit: '2kb' }), async (req, res) => {
        res.set('Cache-Control', 'private, no-store');
        const viewer = sharing.viewerOf(req.user);
        if (!viewer) return contracts.http.sendProblem(res, 401, 'auth.sign_in_required', { detail: 'Sign in to change your default.', ctx: req.ov });
        if (!req.headers['x-requested-with'] && !['same-origin', 'same-site'].includes(String(req.headers['sec-fetch-site'] || ''))) {
            return contracts.http.sendProblem(res, 403, 'share.csrf', { detail: 'Cross-site request refused', ctx: req.ov });
        }
        const audience = String((req.body && req.body.audience) || '');
        if (!sharing.AUDIENCES.includes(audience)) {
            return contracts.http.sendProblem(res, 422, 'ai.invalid', { detail: 'audience must be one of ' + sharing.AUDIENCES.join(', '), ctx: req.ov });
        }
        if (!sessionReports) return contracts.http.sendProblem(res, 503, 'report.no_database', { detail: 'Report has no database in this process.', ctx: req.ov });
        try {
            await sessionReports.setDefaultAudience(viewer.subject.id, audience);
            return res.json({ audience, visibility: sharing.visibilityFor(audience) });
        } catch (err) {
            log.error('[OpenVibe.Report] the session report default failed:', err && err.message ? String(err.message).slice(0, 200) : err);
            return contracts.http.sendProblem(res, 500, 'report.default_failed', { detail: 'Your default could not be saved.', ctx: req.ov });
        }
    });

    // ── The door for the first-party services that ran an agent session (Codes, Actor, Live) ──
    if (sessionReports) app.use('/internal', createSessionReportRoutes({ config, sessionReports, log, verify: opts.verifyServiceToken }));

    // ── Loopback-only operator and Events routes ────────────
    app.use('/internal', createInternalRoutes({ analytics, shadow, config, now, log }));

    // ── A session report from any harness with the person's own token (Agent Streams S7) ──
    // openvibe-sdk/reports writes here. The Report service takes the owner from the token, never from the body; the
    // report is private by default; a browser call must be same-origin, while a server-to-server call carries a Bearer.
    app.post('/api/v1/me/session-reports', express.json({ limit: '256kb' }), async (req, res) => {
        res.set('Cache-Control', 'private, no-store');
        const viewer = sharing.viewerOf(req.user);
        if (!viewer) return contracts.http.sendProblem(res, 401, 'auth.sign_in_required', { detail: 'Sign in to write your report.', ctx: req.ov });
        const bearer = /^Bearer\s+\S+/i.test(String(req.headers.authorization || ''));
        const sameSite = ['same-origin', 'same-site'].includes(String(req.headers['sec-fetch-site'] || ''));
        if (!bearer && !sameSite && !req.headers['x-requested-with']) {
            return contracts.http.sendProblem(res, 403, 'share.csrf', { detail: 'Cross-site request refused', ctx: req.ov });
        }
        if (!sessionReports) return contracts.http.sendProblem(res, 503, 'report.no_database', { detail: 'Report has no database in this process.', ctx: req.ov });
        const body = req.body && typeof req.body === 'object' ? { ...req.body } : {};
        delete body.owner;
        try {
            const out = await sessionReports.write({ ...body, owner: viewer.subject.id });
            return res.status(out.created ? 201 : 200).json(out);
        } catch (err) {
            return contracts.http.sendProblem(res, 400, 'report.invalid', { detail: String((err && err.message) || err).slice(0, 300), ctx: req.ov });
        }
    });

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
    app.use('/api/v1', createApi({ network, live, bench, aiCatalogue, analytics, aiUsage, aiExchange, sessionReports, meStats, config, now, log }));
    app.use('/api', (req, res) => contracts.http.sendProblem(res, 404, 'route.not_found', { detail: 'No such API route', ctx: req.ov }));

    // ── Crawl artifacts, then the pages ─────────────────────
    app.use(createDiscoveryRoutes(ctx));
    // The agent layer (openvibe-shared/agent-layer): /.well-known/agent.json and each twinned page's Markdown twin. It
    // mounts after the page routes, which keep their own cache policy and answer the HTML (with the discovery links),
    // and before the 404, so an unknown twin is still a 404. A .md path skips the page routes (http/pages.js).
    const publicPages = createPublicPages(ctx);
    app.use(require('./http/arena').createArenaRoutes(ctx));
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
