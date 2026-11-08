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
 *   GET /api/v1/design-health, /api/v1/design-health/:site   every site's design health (a snapshot, server/design-health/)
 *
 * A bad parameter is checked here, before the source is asked, and is a 404 problem+json, exactly like a source
 * that answered nothing. Every /api/v1 answer is CORS-open and public for two minutes; the app mounts the 120/min
 * per-address limit in front of this router.
 *
 * GET /api/v1/me/ai/usage is the exception: it answers only the person their session names, so it is private, never
 * cached, and has its own tighter per-address limit.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const contracts = require('openvibe-contracts');
const { normaliseDays, isSlug, isStreamId, isUsername, streamIdOf } = require('../data/source');
const { createServiceAuth, CAPS } = require('../auth');
const { GROUPS: AI_USAGE_GROUPS, PERSON_GROUPS } = require('../analytics/ai-usage');
const GROUPS = Object.keys(AI_USAGE_GROUPS);
const designHealth = require('../data/design-health');
const sharing = require('../sharing');

const CACHE = 'public, max-age=120';

function createApi({ network, live, bench = null, analytics = null, aiUsage = null, aiExchange = null, sessionReports = null, config = {}, now = () => Date.now(), log = console }) {
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

    // The session-report routes are the one place where the answer depends on who is asking, so they may not sit
    // under the public default above: signed in is always private, no-store (the same rule the page keeps), and only
    // a signed-out reader's copy of an Everyone report is the shared cache's.
    r.use(['/session-reports', '/session-reports/:id'], (req, res, next) => {
        res.set('Cache-Control', req.user ? 'private, no-store' : CACHE);
        next();
    });

    // The personal routes: private and never cached, even when they refuse the caller, and their own limit.
    const personalLimit = rateLimit({
        windowMs: 60_000,
        limit: Math.max(1, Number(config.meRateLimitPerMinute) || 60),
        standardHeaders: true,
        legacyHeaders: false,
        handler: (req, res) => contracts.http.sendProblem(res, 429, 'rate_limited', { detail: 'too many requests from this address; retry shortly', ctx: req.ov }),
    });
    r.use('/me', (req, res, next) => {
        res.set('Cache-Control', 'private, no-store');
        next();
    }, personalLimit);

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

    // Every site's design health (plan L45 step 6): the snapshot scripts/design-health.js wrote from each site's code.
    r.get('/design-health', (req, res) => res.json(designHealth.all()));
    r.get('/design-health/:site', (req, res) => {
        const site = designHealth.site(req.params.site);
        if (!site) return notFound(req, res, 'report.design_site_not_found', 'No site by that name in the design health snapshot.');
        const { generated_at, rules, weights, kept } = designHealth.all();
        return res.json({ generated_at, rules, weights, kept, site });
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

    // The caller's own session reports of the last days (Today's "Your agents this week", S7). The list is the
    // person's alone: a signed-out reader is 401, never a list of everybody's public reports.
    r.get('/me/session-reports', async (req, res) => {
        if (!sessionReports) return problem(req, res, 503, 'report.no_database', 'Report has no database in this process.');
        const viewer = sharing.viewerOf(req.user);
        if (!viewer) return problem(req, res, 401, 'auth.sign_in_required', 'Sign in to read your agents.');
        const days = Math.min(30, Math.max(1, Number(req.query.days) || 7));
        const from = now() - days * 24 * 60 * 60_000;
        const reports = (await sessionReports.listForOwner(viewer.subject.id, { limit: 200 }))
            .filter((r) => { const at = Date.parse(r.created_at); return !Number.isFinite(at) || at >= from; });
        return res.json({ days, reports });
    });

    // ── Session reports (Agent Streams S3), in the sharing system's four audiences ─────────────────────
    //
    // The share row decides through canView, exactly as the page does: a report of Specific people is a 404 for a
    // signed-in person who is not on the list, and for everyone signed out. A report that is not in Everyone is never
    // cached in a shared cache; its answer is private and never stored.
    r.get('/session-reports/:id', async (req, res) => {
        if (!sessionReports) return problem(req, res, 503, 'report.no_database', 'Report has no database in this process.');
        const rep = await sessionReports.get(String(req.params.id || ''));
        if (!rep) return notFound(req, res, 'report.session_not_found', 'No such report.');
        const viewer = sharing.viewerOf(req.user);
        if (!(await sharing.canView(viewer, rep))) return notFound(req, res, 'report.session_not_found', 'No such report.');
        const audience = await sharing.audienceOf(rep);
        if (audience !== 'public') res.set('Cache-Control', 'private, no-store');
        return res.json({ ...rep, audience });
    });

    // The reports a reader may see: Everyone's, plus the caller's own (a list never shows a hidden item, not even as a
    // count). The public part is what the Rundown's section and the sitemap read.
    r.get('/session-reports', async (req, res) => {
        if (!sessionReports) return problem(req, res, 503, 'report.no_database', 'Report has no database in this process.');
        const viewer = sharing.viewerOf(req.user);
        const publicOnes = await sessionReports.listPublic({ limit: 50 });
        const mine = viewer ? (await sessionReports.listForOwner(viewer.subject.id, { limit: 50 })).filter((r) => !publicOnes.some((p) => p.id === r.id)) : [];
        if (viewer) res.set('Cache-Control', 'private, no-store');
        return res.json({
            reports: [...publicOnes.map((r) => ({ ...r, audience: 'public' })), ...mine],
        });
    });

    // The new AI results, as JSON: the same public runs the /ai/feed.xml RSS carries. Only Bench's own rows; a
    // result with no run is not in it.
    r.get('/ai/results', async (req, res) => {
        if (!bench) return problem(req, res, 503, 'report.no_bench', 'Bench is not configured in this process.');
        const [runs, overview] = await Promise.all([bench.runs({ limit: 50 }), bench.overview()]);
        const list = runs && runs.data && Array.isArray(runs.data.runs) ? runs.data.runs : null;
        if (!list) return problem(req, res, 502, 'report.bench_unavailable', 'Bench did not answer with its runs.');
        const titles = new Map((overview && overview.data && Array.isArray(overview.data.list) ? overview.data.list : []).map((b) => [b.id, b.title]));
        const results = list.map((run) => ({
            id: run.id, benchmark_id: run.benchmark_id, benchmark: titles.get(run.benchmark_id) || null,
            model: run.model, score: run.score, cost_usd: run.cost_usd, ms: run.ms, provenance: run.provenance,
            created_at: run.created_at, url: `${String(config.baseUrl || 'https://openvibe.report').replace(/\/+$/, '')}/ai/${encodeURIComponent(run.benchmark_id)}`,
        }));
        return res.json({ count: results.length, generated_at: new Date(now()).toISOString(), results });
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

    // The person's own rows (plan L41 R1). The subject is the signed-in person from Report's sso session (cookie or
    // bearer), never the query; signed out is 401. The last 30 days by default, 400 at most; raw records answer a
    // range inside the 90-day retention and the roll-ups the part beyond it. Private: the /me middleware above sets
    // private, no-store and the tighter limit, and the answer adds the lines worked out from its own numbers.
    r.get('/me/ai/usage', async (req, res) => {
        const user = req.user;
        const subject = user && typeof user.subject_id === 'string' ? user.subject_id.trim() : '';
        if (!subject) return problem(req, res, 401, 'auth.sign_in_required', 'Sign in to see your own AI usage.');
        if (!aiUsage) return problem(req, res, 503, 'report.no_database', 'Report has no database in this process.');
        const group = String(req.query.group || 'day');
        if (!PERSON_GROUPS.includes(group)) return problem(req, res, 422, 'ai.invalid', 'group must be one of ' + PERSON_GROUPS.join(', '));
        try {
            const body = await aiUsage.forPerson({ from: req.query.from || null, to: req.query.to || null, group, subject, now: now() });
            return res.json(body);
        } catch (err) {
            if (err instanceof RangeError) return problem(req, res, 422, 'ai.invalid', err.message);
            log.error('[OpenVibe.Report] the personal AI usage rows failed:', err && err.message ? String(err.message).slice(0, 200) : err);
            return problem(req, res, 500, 'report.ai_usage_failed', 'Your AI usage could not be read.');
        }
    });

    // The AI Exchange (plan G-P9): Billing's settlements, summed by day, resolved model and provider access. Only
    // when REPORT_AI_EXCHANGE is on, and only for the staff gate the AI meter already uses. Aggregates only: no
    // person, no project, no prompt. Report never sets a rate, a price or a balance.
    r.get('/ai/exchange', async (req, res) => {
        if (!config.aiExchange || !config.aiExchange.enabled) return notFound(req, res, 'route.not_found', 'No such API route.');
        if (!aiExchange) return problem(req, res, 503, 'report.no_database', 'Report has no database in this process.');
        const v = await serviceAuth.authenticate(req);
        if (!v.ok) return problem(req, res, v.status, v.code, v.detail);
        if (!serviceAuth.hasCap(v.claims, CAPS.aiUsageRead)) {
            return problem(req, res, 403, 'capability.denied', 'report.ai_usage.read is not granted to this token.');
        }
        try {
            const body = await aiExchange.analytics({ from: req.query.from || null, to: req.query.to || null });
            return res.set('Cache-Control', 'no-store').json(body);
        } catch (err) {
            if (err instanceof RangeError) return problem(req, res, 422, 'ai.invalid', err.message);
            log.error('[OpenVibe.Report] the AI Exchange aggregates failed:', err && err.message ? String(err.message).slice(0, 200) : err);
            return problem(req, res, 500, 'report.ai_exchange_failed', 'The AI Exchange aggregates could not be read.');
        }
    });

    r.use((req, res) => notFound(req, res, 'route.not_found', 'No such API route.'));
    return r;
}

module.exports = { createApi };
