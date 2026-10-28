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
 */
const express = require('express');
const views = require('../views');
const { normaliseDays, isSlug, isStreamId, isUsername, streamIdOf } = require('../data/source');

const CACHE = 'public, max-age=120';

function createPageRoutes({ network, live }) {
    const r = express.Router();

    function send(res, html, status = 200) {
        res.status(status).set('Cache-Control', CACHE).type('html').send(html);
    }
    function notFound(res) {
        return send(res, views.notFound(), 404);
    }

    r.get('/', async (_req, res) => {
        const [stats, rundown, topics] = await Promise.all([
            network.stats(7),
            live.rundown(),
            live.topics(),
        ]);
        // Each part of the home stands alone: a source that does not answer leaves its part out, not the page.
        return send(res, views.home({ stats, rundown, topics }));
    });

    r.get('/developers', (_req, res) => send(res, views.developers()));

    r.get('/stats', async (req, res) => {
        const days = normaliseDays(req.query.days);
        const stats = await network.stats(days);
        if (!stats) return notFound(res);
        return send(res, views.stats({ stats, days }));
    });

    r.get('/rundown', async (_req, res) => {
        const [rundown, topics] = await Promise.all([live.rundown(), live.topics()]);
        if (!rundown || !topics) return notFound(res);
        return send(res, views.rundown({ rundown, topics }));
    });

    r.get('/rundown/t/:slug', async (req, res) => {
        const { slug } = req.params;
        if (!isSlug(slug)) return notFound(res);
        const topic = await live.topic(slug);
        if (!topic) return notFound(res);
        return send(res, views.topic({ topic }));
    });

    r.get('/rundown/e/:streamId', async (req, res) => {
        if (!isStreamId(req.params.streamId)) return notFound(res);
        const episode = await live.episode(streamIdOf(req.params.streamId));
        if (!episode) return notFound(res);
        return send(res, views.episode({ episode }));
    });

    r.get('/rundown/s/:username', async (req, res) => {
        const { username } = req.params;
        if (!isUsername(username)) return notFound(res);
        const speaker = await live.speaker(username);
        if (!speaker) return notFound(res);
        return send(res, views.speaker({ speaker, username }));
    });

    r.get('/after-show/:streamId', async (req, res) => {
        if (!isStreamId(req.params.streamId)) return notFound(res);
        const recap = await live.recap(streamIdOf(req.params.streamId));
        if (!recap) return notFound(res);
        return send(res, views.recap({ recap }));
    });

    r.get('/c/:username', async (req, res) => {
        const { username } = req.params;
        if (!isUsername(username)) return notFound(res);
        const recaps = await live.channelRecaps(username);
        if (!recaps) return notFound(res);
        return send(res, views.channel({ username, recaps }));
    });

    return r;
}

module.exports = { createPageRoutes };
