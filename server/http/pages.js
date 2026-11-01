'use strict';

/**
 * The pages, server-rendered from a plain model (server/views/index.js):
 *
 *   GET /                       stats 7 days + the Rundown + topics
 *   GET /stats?days=            7 | 30 | 90 (anything else is 30)
 *   GET /rundown                the Rundown + topics
 *   GET /rundown/t/:slug        one topic
 *   GET /rundown/e/:streamId    one stream as an episode
 *   GET /rundown/s/:username    one streamer
 *   GET /after-show/:streamId   one after-show report
 *   GET /c/:username            one channel's after-show reports
 *
 * A bad path parameter is a 404 without a source request; so is a source that answers nothing. Pages are public
 * for two minutes.
 *
 * The public pages the agent layer also twins have their data and view here (createPublicPages), so a route and its
 * Markdown twin render the very same page; `agent: true` in those views adds the discovery links.
 */
const express = require('express');
const views = require('../views');
const { normaliseDays, isSlug, isStreamId, isUsername, streamIdOf } = require('../data/source');
const { twinPath } = require('../agent-pages');
const designViews = require('../views/design');
const designHealth = require('../data/design-health');

const CACHE = 'public, max-age=120';

/** The pages the agent layer twins: their data, then the view. Each returns { html } or null (nothing to show). */
function createPublicPages({ network, live, bench, analytics = null }) {
    const numbers = (days) => (analytics ? analytics.stats(days) : network.stats(days));

    async function home() {
        const [stats, rundown, topics] = await Promise.all([numbers(7), live.rundown(), live.topics()]);
        // Each part of the home stands alone: a source that does not answer leaves its part out, not the page.
        return { html: views.home({ stats, rundown, topics }) };
    }

    async function stats(days) {
        const data = await numbers(days);
        return data ? { html: views.stats({ stats: data, days }) } : null;
    }

    function developers() {
        return { html: views.developers() };
    }

    async function aiIndex() {
        const kinds = await bench.kinds();
        const list = kinds && Array.isArray(kinds.data.kinds) ? kinds.data.kinds : [];
        const boards = await Promise.all(list.map((kind) => bench.board(kind.id, 'elo')));
        return { html: views.aiIndex({ kinds, boards }) };
    }

    async function aiBoard(kindId, tab) {
        if (!bench.isKindId(kindId)) return null;
        const [kinds, board, cost] = await Promise.all([
            bench.kinds(), bench.board(kindId, tab), tab === 'pareto' ? bench.board(kindId, 'cost') : Promise.resolve(null),
        ]);
        const kind = kinds && Array.isArray(kinds.data.kinds) ? kinds.data.kinds.find((k) => k.id === kindId) : null;
        if (kinds && !kind) return null;
        return { html: views.aiBoard({ kindId, kind, tab, board, cost, kinds }) };
    }

    async function aiModel(model) {
        if (!bench.isModelName(model)) return null;
        return { html: views.aiModel({ model, summary: await bench.modelSummary(model) }) };
    }

    return { home, stats, developers, aiIndex, aiBoard, aiModel };
}

function createPageRoutes(ctx) {
    const { live, bench } = ctx;
    const r = express.Router();
    const publicPages = ctx.publicPages || createPublicPages(ctx);
    // A path ending in .md is a Markdown twin (server/agent-pages.js), never a page parameter.
    r.use((req, res, next) => (req.path.endsWith('.md') ? next('router') : next()));

    function send(req, res, html, status = 200, cacheControl = CACHE) {
        // A page with a Markdown twin names it, as the agent layer's own responses do (openvibe-shared/agent-layer).
        if (status === 200 && twinPath(req.path)) {
            const site = String(ctx.config.baseUrl).replace(/\/+$/, '');
            res.set('Link', require('openvibe-shared/agent-layer').linkHeaderTags(`${site}${req.originalUrl}`, `${site}/llms.txt`).header);
        }
        res.status(status).set('Cache-Control', cacheControl).type('html').send(html);
    }
    function notFound(req, res) {
        return send(req, res, views.notFound(), 404);
    }

    r.get('/', async (req, res) => send(req, res, (await publicPages.home()).html));

    r.get('/developers', (req, res) => send(req, res, publicPages.developers().html));

    // Every site's design health (plan L45 step 6), from the snapshot (server/data/design-health.js).
    r.get('/design', (req, res) => send(req, res, designViews.designHealth(designHealth.all())));
    r.get('/design/:site', (req, res) => {
        const site = designHealth.site(req.params.site);
        if (!site) return notFound(req, res);
        return send(req, res, designViews.designSite(designHealth.all(), site));
    });

    r.get('/stats', async (req, res) => {
        const page = await publicPages.stats(normaliseDays(req.query.days));
        if (!page) return notFound(req, res);
        return send(req, res, page.html);
    });

    r.get('/ai', async (req, res) => send(req, res, (await publicPages.aiIndex()).html, 200, 'no-store'));

    r.get('/ai/models/:model', async (req, res) => {
        const page = await publicPages.aiModel(req.params.model);
        if (!page) return notFound(req, res);
        return send(req, res, page.html, 200, 'no-store');
    });

    r.get('/ai/:kind', async (req, res) => {
        const page = await publicPages.aiBoard(req.params.kind, bench.normaliseTab(req.query.tab));
        if (!page) return notFound(req, res);
        return send(req, res, page.html, 200, 'no-store');
    });

    r.get('/rundown', async (req, res) => {
        const [rundown, topics] = await Promise.all([live.rundown(), live.topics()]);
        if (!rundown || !topics) return notFound(req, res);
        return send(req, res, views.rundown({ rundown, topics }));
    });

    r.get('/rundown/t/:slug', async (req, res) => {
        const { slug } = req.params;
        if (!isSlug(slug)) return notFound(req, res);
        const topic = await live.topic(slug);
        if (!topic) return notFound(req, res);
        return send(req, res, views.topic({ topic }));
    });

    r.get('/rundown/e/:streamId', async (req, res) => {
        if (!isStreamId(req.params.streamId)) return notFound(req, res);
        const episode = await live.episode(streamIdOf(req.params.streamId));
        if (!episode) return notFound(req, res);
        return send(req, res, views.episode({ episode }));
    });

    r.get('/rundown/s/:username', async (req, res) => {
        const { username } = req.params;
        if (!isUsername(username)) return notFound(req, res);
        const speaker = await live.speaker(username);
        if (!speaker) return notFound(req, res);
        return send(req, res, views.speaker({ speaker, username }));
    });

    r.get('/after-show/:streamId', async (req, res) => {
        if (!isStreamId(req.params.streamId)) return notFound(req, res);
        const recap = await live.recap(streamIdOf(req.params.streamId));
        if (!recap) return notFound(req, res);
        return send(req, res, views.recap({ recap }));
    });

    // A person's own numbers (plan L41 R1). Signed out: what it is and a sign-in. Signed in: their channel's streams and
    // after-show reports, the payments Billing says reached them, and The Rundown, over 7, 30 or 90 days. Private.
    r.get('/you', async (req, res) => {
        const user = req.user;
        if (!user || !isUsername(String(user.username || ''))) return send(req, res, views.youSignedOut(), 200, 'private, no-store');
        const days = normaliseDays(req.query.days);
        // Your AI (plan L40/L41): the ledger's own rows for this person, read in-process, never by a query value.
        const subject = typeof user.subject_id === 'string' ? user.subject_id.trim() : '';
        const from = new Date((ctx.now ? ctx.now() : Date.now()) - (days - 1) * 86400000).toISOString().slice(0, 10);
        const [stats, recaps, speaker, ai] = await Promise.all([
            ctx.analytics && typeof ctx.analytics.channel === 'function' ? ctx.analytics.channel(user.username, days).catch(() => null) : null,
            Promise.resolve(live.channelRecaps(user.username)).catch(() => null),
            Promise.resolve(live.speaker(user.username)).catch(() => null),
            subject && ctx.aiUsage ? ctx.aiUsage.forPerson({ subject, from, group: 'day' }).catch(() => null) : null,
        ]);
        return send(req, res, views.you({ user, days, stats, recaps, speaker, ai }), 200, 'private, no-store');
    });

    r.get('/c/:username', async (req, res) => {
        const { username } = req.params;
        if (!isUsername(username)) return notFound(req, res);
        const recaps = await live.channelRecaps(username);
        if (!recaps) return notFound(req, res);
        return send(req, res, views.channel({ username, recaps }));
    });

    return r;
}

module.exports = { createPageRoutes, createPublicPages };
