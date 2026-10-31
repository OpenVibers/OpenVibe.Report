'use strict';

/**
 * /api/v1 — the read APIs of OpenVibe.Network and OpenVibe.Live, proxied as the source answers them.
 *
 *   GET /api/v1/stats?days=7|30|90
 *   GET /api/v1/rundown
 *   GET /api/v1/rundown/topics
 *   GET /api/v1/rundown/t/:slug
 *   GET /api/v1/after-show/:streamId
 *   GET /api/v1/c/:username
 *
 * A bad parameter is checked here, before the source is asked, and is a 404 problem+json, exactly like a source
 * that answered nothing. Every /api/v1 answer is CORS-open and public for two minutes; the app mounts the 120/min
 * per-address limit in front of this router.
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const { normaliseDays, isSlug, isStreamId, isUsername, streamIdOf } = require('../data/source');
const { createServiceAuth, CAPS } = require('../auth');
const { GROUPS: AI_USAGE_GROUPS } = require('../analytics/ai-usage');
const GROUPS = Object.keys(AI_USAGE_GROUPS);

const CACHE = 'public, max-age=120';

function createApi({ network, live, analytics = null, aiUsage = null, config = {}, now = () => Date.now(), log = console }) {
    const r = express.Router();
    const serviceAuth = createServiceAuth({ config, now });

    r.use((req, res, next) => {
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Cache-Control', CACHE);
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.set('Allow', 'GET, HEAD');
            return problem(req, res, 405, 'method.not_allowed', 'This API is read-only; use GET.');
        }
        return next();
    });

    function problem(req, res, status, code, detail) {
        return contracts.http.sendProblem(res, status, code, { detail, ctx: req.ov });
    }

    function notFound(req, res, code = 'report.not_found', detail = 'No such answer from the source.') {
        return problem(req, res, 404, code, detail);
    }

    r.get('/stats', async (req, res) => {
        const days = normaliseDays(req.query.days);
        const stats = analytics ? await analytics.stats(days) : await network.stats(days);
        if (!stats) return notFound(req, res, 'report.stats_not_found', 'The open numbers did not answer for this window.');
        return res.json(stats);
    });

    r.get('/rundown', async (req, res) => {
        const rundown = await live.rundown();
        if (!rundown) return notFound(req, res, 'report.rundown_not_found', 'OpenVibe.Live did not answer with The Rundown.');
        return res.json(rundown);
    });

    r.get('/rundown/topics', async (req, res) => {
        const topics = await live.topics();
        if (!topics) return notFound(req, res, 'report.topics_not_found', 'OpenVibe.Live did not answer with the topics.');
        return res.json(topics);
    });

    r.get('/rundown/t/:slug', async (req, res) => {
        const { slug } = req.params;
        if (!isSlug(slug)) return notFound(req, res, 'report.topic_not_found', 'No such topic.');
        const topic = await live.topic(slug);
        if (!topic) return notFound(req, res, 'report.topic_not_found', 'No such topic.');
        return res.json(topic);
    });

    r.get('/after-show/:streamId', async (req, res) => {
        if (!isStreamId(req.params.streamId)) return notFound(req, res, 'report.recap_not_found', 'No such after-show report.');
        const recap = await live.recap(streamIdOf(req.params.streamId));
        if (!recap) return notFound(req, res, 'report.recap_not_found', 'No such after-show report.');
        return res.json(recap);
    });

    r.get('/c/:username', async (req, res) => {
        const { username } = req.params;
        if (!isUsername(username)) return notFound(req, res, 'report.channel_not_found', 'No such channel.');
        const recaps = await live.channelRecaps(username);
        if (!recaps) return notFound(req, res, 'report.channel_not_found', 'No such channel.');
        return res.json(recaps);
    });

    // ── The AI meter (plan L40 and L41) ─────────────────────────────────────────────
    //
    // The public totals: the tokens, the cache's share, the own-key share and the spend by week. No person, no
    // site and no key is in it.
    r.get('/ai/usage/open', async (req, res) => {
        if (!aiUsage) return problem(req, res, 503, 'report.no_database', 'Report has no database in this process.');
        try {
            const body = await aiUsage.openTotals({ from: req.query.from || null, to: req.query.to || null });
            return res.json(body);
        } catch (err) {
            log.error('[OpenVibe.Report] the open AI totals failed:', err && err.message ? String(err.message).slice(0, 200) : err);
            return problem(req, res, 500, 'report.ai_usage_failed', 'The AI totals could not be read.');
        }
    });

    // The meter across everyone: a service token with report.ai_usage.read, and nothing else.
    r.get('/ai/usage', async (req, res) => {
        if (!aiUsage) return problem(req, res, 503, 'report.no_database', 'Report has no database in this process.');
        const v = await serviceAuth.authenticate(req);
        if (!v.ok) return problem(req, res, v.status, v.code, v.detail);
        if (!serviceAuth.hasCap(v.claims, CAPS.aiUsageRead)) {
            return problem(req, res, 403, 'capability.denied', 'report.ai_usage.read is not granted to this token.');
        }
        const group = String(req.query.group || 'day');
        if (!GROUPS.includes(group)) return problem(req, res, 422, 'ai.invalid', 'group must be one of ' + GROUPS.join(', '));
        try {
            const rows = await aiUsage.usage({ from: req.query.from || null, to: req.query.to || null, group, subject: req.query.subject || null });
            return res.set('Cache-Control', 'no-store').json({ group, usage: rows, totals: aiUsage.totalsOf(rows) });
        } catch (err) {
            log.error('[OpenVibe.Report] the AI usage rows failed:', err && err.message ? String(err.message).slice(0, 200) : err);
            return problem(req, res, 500, 'report.ai_usage_failed', 'The AI usage rows could not be read.');
        }
    });

    // The person's own rows: the route opens with Report's sign-in, which is the owner's next step. The shape is
    // already fixed in the contracts (report.ai-usage-me-result@1), so the route does not have to change when it
    // opens.
    r.get('/me/ai/usage', (req, res) => problem(req, res, 501, 'report.not_implemented', 'This route opens with Report sign-in.'));

    r.use((req, res) => notFound(req, res, 'route.not_found', 'No such API route.'));
    return r;
}

module.exports = { createApi };
