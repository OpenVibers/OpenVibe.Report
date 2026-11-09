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
 * GET /api/v1/me/ai/usage and GET /api/v1/me/stats answer only the person their session names, so they are private,
 * never cached, and have their own tighter per-address limit. PUT /api/v1/me/stats/published is the one write; GET
 * /api/v1/u/:name/stats is public and carries only the sections that person published.
 */
const express = require('express');
const { findCatalogModel, makerOf } = require('../data/ai-join');
const rateLimit = require('express-rate-limit');
const contracts = require('openvibe-contracts');
const { normaliseDays, isSlug, isStreamId, isUsername, streamIdOf } = require('../data/source');
const { createServiceAuth, CAPS } = require('../auth');
const { GROUPS: AI_USAGE_GROUPS, PERSON_GROUPS } = require('../analytics/ai-usage');
const GROUPS = Object.keys(AI_USAGE_GROUPS);
const designHealth = require('../data/design-health');
const sharing = require('../sharing');

const CACHE = 'public, max-age=120';

function createApi({ network, live, bench = null, aiCatalogue = null, analytics = null, aiUsage = null, aiExchange = null, sessionReports = null, meStats = null, config = {}, now = () => Date.now(), log = console }) {
    const r = express.Router();
    const serviceAuth = createServiceAuth({ config, now });

    // The one write: the person's own publish switches. A browser sends a same-origin request (or an
    // X-Requested-With); a Bearer caller is not a cookie, so it needs no CSRF token. Everything else is read-only.
    const isPublishWrite = (req) => req.method === 'PUT' && (req.path === '/me/stats/published' || req.path === '/me/stats/published/');
    function sameOrigin(req) {
        if (String((req.headers && req.headers.authorization) || '').startsWith('Bearer ')) return true;
        const site = String((req.headers && req.headers['sec-fetch-site']) || '');
        return req.headers['x-requested-with'] === 'fetch' || site === 'same-origin' || site === 'same-site';
    }

    r.use((req, res, next) => {
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Cache-Control', CACHE);
        if (req.method === 'OPTIONS' && req.path === '/me/stats/published') {
            res.set('Access-Control-Allow-Methods', 'GET, HEAD, PUT, OPTIONS');
            res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
            return res.status(204).end();
        }
        if (req.method !== 'GET' && req.method !== 'HEAD' && !isPublishWrite(req)) {
            res.set('Allow', 'GET, HEAD');
            return problem(req, res, 405, 'method.not_allowed', 'This API is read-only; use GET.');
        }
        res.set('Access-Control-Allow-Methods', 'GET, HEAD, PUT, OPTIONS');
        res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
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

    const aiEnvelope = (schema, data) => ({ '$schema': schema, generated_at: new Date(now()).toISOString(), ...data });
    const aiRows = async () => {
        const [kindsResult, catalogueResult] = await Promise.all([bench && bench.kinds(), require('../data/ai-market').comparisonCatalogue(aiCatalogue)]);
        if (!kindsResult) return null;
        const kinds = kindsResult.data && kindsResult.data.kinds || [];
        const catalogModels = catalogueResult && catalogueResult.models || [];
        const boards = await Promise.all(kinds.map((kind) => bench.board(kind.id, 'elo')));
        const rows = [];
        for (let i = 0; i < boards.length; i += 1) {
            const board = boards[i];
            const list = board && board.data && board.data.board && board.data.board.rows || [];
            for (const entry of list) {
                const id = entry.subject || entry.model || entry.name;
                const catalogue = findCatalogModel(catalogModels, id);
                const elo = entry.elo != null && Number.isFinite(Number(entry.elo)) && Number(entry.games) !== 0 ? Number(entry.elo) : null;
                rows.push({ id, routed: catalogue ? catalogue.routed !== false : false, kind: kinds[i].id, maker: makerOf(catalogue, id), weights: catalogue && (catalogue.weights || (catalogue.open_weights == null ? null : catalogue.open_weights ? 'open' : 'closed')) || null,
                    status: catalogue && catalogue.status || 'current', uncensored: catalogue && catalogue.uncensored === true,
                    community: Boolean(catalogue && catalogue.community), rating: elo == null ? { value: null, reason: 'Bench has no rating.' } : { value: elo, interval: [entry.ci_lower ?? null, entry.ci_upper ?? null], source: 'OpenVibe.Bench', date: board.at, sample_size: entry.games ?? null },
                    benchmark: entry.score == null ? { value: null, reason: 'No benchmark score.' } : { value: entry.score, source: 'OpenVibe.Bench', date: board.at, sample_size: entry.runs ?? null },
                    provider_offers: catalogue ? catalogue.offers.map((offer) => ({ ...offer, source: { name: 'OpenVibe.AI', date: catalogueResult.generated_at || null, sample_size: offer.requests_7d ?? null } })) : [], source: { name: 'OpenVibe.Bench', date: board.at, sample_size: entry.games ?? null } });
            }
        }
        const rated = new Set(rows.map(row => findCatalogModel(catalogModels, row.id)).filter(Boolean));
        for (const model of catalogModels) {
            if (rated.has(model)) continue;
            rows.push({ id: model.slug || model.canonical, kind: model.kind || null, maker: makerOf(model),
                routed: model.routed !== false, weights: model.open_weights == null ? null : model.open_weights ? 'open' : 'closed',
                status: model.status || 'current', uncensored: Boolean(model.uncensored), community: Boolean(model.community),
                rating: { value: null, reason: 'Not rated yet.' }, benchmark: { value: null, reason: 'Not rated yet.' },
                provider_offers: model.offers || [], source: { name: 'OpenVibe.AI', date: catalogueResult.generated_at || null, sample_size: null } });
        }
        rows.sort((a, b) => (b.rating.value ?? -Infinity) - (a.rating.value ?? -Infinity) || String(a.id).localeCompare(String(b.id)));
        rows.forEach((row, index) => {
            const lo = row.rating.interval && row.rating.interval[0]; const hi = row.rating.interval && row.rating.interval[1];
            if (lo == null || hi == null) row.rank = { value: null, reason: 'Not enough data to establish a rank band.' };
            else { const overlapping = rows.filter((other) => other.rating.interval && other.rating.interval[0] != null && other.rating.interval[1] != null && other.rating.interval[0] <= hi && other.rating.interval[1] >= lo); row.rank = { min: Math.min(...overlapping.map((x) => rows.indexOf(x) + 1)), max: Math.max(...overlapping.map((x) => rows.indexOf(x) + 1)), position: index + 1, source: 'OpenVibe.Bench', date: row.source.date, sample_size: row.source.sample_size }; }
        });
        return rows;
    };

    r.get('/ai/leaderboard', async (req, res) => {
        const all = await aiRows();
        if (!all) return problem(req, res, 502, 'report.ai_source_unavailable', 'OpenVibe.Bench did not answer.');
        let rows = all;
        const q = req.query;
        if (q.kind) rows = rows.filter((x) => x.kind === q.kind);
        if (q.maker) rows = rows.filter((x) => String(x.maker || '').toLowerCase() === String(q.maker).toLowerCase());
        if (q.weights === 'open') rows = rows.filter((x) => x.weights === 'open' || x.weights === 'open_weights');
        if (q.weights === 'closed') rows = rows.filter((x) => x.weights === 'closed');
        if (q.status === 'current') rows = rows.filter((x) => x.status === 'current');
        if (q.uncensored === 'true') rows = rows.filter((x) => x.uncensored);
        if (q.community === 'true') rows = rows.filter((x) => x.community);
        if (q.price) rows = rows.filter((x) => x.provider_offers.some((o) => o.price && o.price.out != null && (q.price === 'free' ? o.free_tier : q.price === 'low' ? Number(o.price.out) <= 1 : ['mid', 'medium'].includes(q.price) ? Number(o.price.out) > 1 && Number(o.price.out) <= 10 : q.price === 'high' ? Number(o.price.out) > 10 : false)));
        if (q.sort === 'name') rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
        if (q.sort === 'price') rows.sort((a, b) => Math.min(...a.provider_offers.map((o) => (o.price?.out == null ? NaN : Number(o.price.out))).filter(Number.isFinite), Infinity) - Math.min(...b.provider_offers.map((o) => (o.price?.out == null ? NaN : Number(o.price.out))).filter(Number.isFinite), Infinity));
        if (q.sort === 'speed') rows.sort((a, b) => Math.min(...a.provider_offers.map((o) => (o.speed?.p50_ms == null ? NaN : Number(o.speed.p50_ms))).filter(Number.isFinite), Infinity) - Math.min(...b.provider_offers.map((o) => (o.speed?.p50_ms == null ? NaN : Number(o.speed.p50_ms))).filter(Number.isFinite), Infinity));
        const limit = Math.max(1, Math.min(100, Number(q.limit) || 25)); const offset = Math.max(0, Number(q.cursor) || 0);
        if (q.format === 'csv') {
            const csv = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
            const lines = [['id', 'maker', 'rating', 'rank_min', 'rank_max', 'source', 'date', 'sample_size'], ...rows.map((x) => [x.id, x.maker, x.rating && x.rating.value, x.rank && x.rank.min, x.rank && x.rank.max, x.source && x.source.name, x.source && x.source.date, x.source && x.source.sample_size])];
            return res.type('text/csv; charset=utf-8').send(lines.map((line) => line.map(csv).join(',')).join('\r\n'));
        }
        return res.json(aiEnvelope('report.ai-leaderboard@1', { count: rows.length, rows: rows.slice(offset, offset + limit), next_cursor: offset + limit < rows.length ? String(offset + limit) : null }));
    });
    r.get('/ai/models/:id', async (req, res) => {
        const result = bench && await bench.modelDetail(req.params.id);
        if (!result) return notFound(req, res, 'report.ai_model_not_found', 'No public Bench model by that id.');
        const rows = await aiRows(); const ranking = rows && rows.filter((x) => x.id === req.params.id);
        return res.json(aiEnvelope('report.ai-model@1', { ...result.data, ratings: ranking || [], source: { name: 'OpenVibe.Bench', date: result.at, sample_size: result.data.runs ?? null } }));
    });
    r.get('/ai/providers', async (_req, res) => {
        const data = await require('../data/ai-market').comparisonCatalogue(aiCatalogue);
        if (!data) return problem(_req, res, 502, 'report.ai_source_unavailable', 'OpenVibe.AI did not answer with provider metrics.');
        const providers = data.models.flatMap((model) => (model.offers || []).map((offer) => {
            const evidence = { name: 'OpenVibe.AI', date: offer.observed_at || data.generated_at, sample_size: offer.requests_7d ?? null };
            return { ...offer, model: model.slug, routed: offer.routed !== false, error_rate: offer.uptime == null ? { value: null, reason: 'Not enough provider attempts to calculate an error rate.' } : { value: Math.max(0, 1 - Number(offer.uptime)), source: evidence, derivation: '1 - uptime' },
                tokens_per_second: { value: offer.routed === false ? null : offer.speed?.tokens_per_second ?? null, reason: offer.routed === false ? 'Not routed here' : 'Not measured yet' },
                ttft_ms: { value: offer.routed === false ? null : offer.speed?.ttft_ms ?? null, reason: offer.routed === false ? 'Not routed here' : 'Not measured yet' }, source: evidence };
        }));
        return res.json(aiEnvelope('report.ai-providers@1', { generated_at: data.generated_at, stale: data.stale || false, metadata: data.metadata || null, providers }));
    });
    r.get('/ai/compare', async (req, res) => {
        const ids = String(req.query.models || '').split(',').filter(Boolean).slice(0, 4);
        const models = await Promise.all(ids.map(async (id) => { const value = bench && await bench.modelDetail(id); return value ? { ...value.data, source: { name: 'OpenVibe.Bench', date: value.at, sample_size: value.data.runs ?? null } } : { id, model: null, reason: 'No public Bench data for this model.' }; }));
        return res.json(aiEnvelope('report.ai-compare@1', { models }));
    });
    r.get('/ai/picks', async (_req, res) => {
        const rows = await aiRows(); if (!rows) return problem(_req, res, 502, 'report.ai_source_unavailable', 'OpenVibe.Bench did not answer.');
        const best = rows.find((x) => x.rating.value != null) || null;
        const cheapest = rows.filter((x) => x.provider_offers.some((o) => o.price && o.price.out != null)).sort((a, b) => Number(a.provider_offers[0].price.out) - Number(b.provider_offers[0].price.out))[0] || null;
        const value = rows.filter((x) => x.rating.value != null && x.provider_offers.some((o) => o.price && Number(o.price.out) > 0)).sort((a, b) => Number(a.provider_offers.find((o) => o.price && Number(o.price.out) > 0).price.out) / a.rating.value - Number(b.provider_offers.find((o) => o.price && Number(o.price.out) > 0).price.out) / b.rating.value)[0] || null;
        const fastest = rows.filter((x) => x.provider_offers.some((o) => Number.isFinite((o.speed?.p50_ms == null ? NaN : Number(o.speed.p50_ms))))).sort((a, b) => Math.min(...a.provider_offers.map((o) => (o.speed?.p50_ms == null ? NaN : Number(o.speed.p50_ms))).filter(Number.isFinite)) - Math.min(...b.provider_offers.map((o) => (o.speed?.p50_ms == null ? NaN : Number(o.speed.p50_ms))).filter(Number.isFinite)))[0] || null;
        const picks = [{ id: 'overall', model: best, why: best ? 'Highest Bench rating.' : 'Not enough data.' }, { id: 'value', model: value, why: value ? 'Bench rating relative to listed provider output price.' : 'Not enough paired rating and price data.' }, { id: 'fastest', model: fastest, why: fastest ? 'Lowest measured p50 response time.' : 'Not enough measured speed data.' }];
        for (const id of ['open', 'code', 'writing', 'uncensored', 'free']) {
            const model = rows.find((x) => id === 'open' ? x.weights === 'open' : id === 'uncensored' ? x.uncensored : id === 'free' ? x.provider_offers.some((o) => o.free_tier) : x.kind === id) || null;
            picks.push({ id, model, why: model ? 'Based on currently available public source data.' : `Not enough source data to establish a ${id} pick.` });
        }
        return res.json(aiEnvelope('report.ai-picks@1', { picks }));
    });
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

    // ── A person's own numbers (the owner, 2026-11-09) ─────────────────────────────────────────────────
    //
    // GET /api/v1/me/stats answers the person the session names, with every section a source answered for. The
    // per-section switches are the person's own; a section is absent until a source gives it, never a zero. A public
    // reader gets only what the person published, from their last snapshot (GET /api/v1/u/:name/stats).
    r.get('/me/stats', async (req, res) => {
        const user = req.user;
        if (!user || !user.subject_id) return problem(req, res, 401, 'auth.sign_in_required', 'Sign in to see your own numbers.');
        if (!meStats) return problem(req, res, 503, 'report.no_me_stats', 'Your numbers are not available in this process.');
        try {
            const body = await meStats.compute({ user, token: req.token, days: normaliseDays(req.query.days) });
            return res.json(body);
        } catch (err) {
            log.error('[OpenVibe.Report] the personal stats failed:', err && err.message ? String(err.message).slice(0, 200) : err);
            return problem(req, res, 500, 'report.me_stats_failed', 'Your numbers could not be read.');
        }
    });

    // The per-section switch. It is the one route that changes something: it writes only this subject's row and
    // answers the recomputed document, so the page can show what is public now.
    r.put('/me/stats/published', express.json({ limit: '4kb' }), async (req, res) => {
        const user = req.user;
        if (!user || !user.subject_id) return problem(req, res, 401, 'auth.sign_in_required', 'Sign in to publish your numbers.');
        if (!sameOrigin(req)) return problem(req, res, 403, 'report.csrf', 'Cross-site request refused.');
        if (!meStats) return problem(req, res, 503, 'report.no_me_stats', 'Your numbers are not available in this process.');
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const published = body.published;
        if (!published || typeof published !== 'object' || Array.isArray(published)) {
            return problem(req, res, 422, 'report.me_stats_invalid', 'published must name every section.');
        }
        const switches = {};
        for (const key of meStats.SECTIONS) {
            if (typeof published[key] !== 'boolean') return problem(req, res, 422, 'report.me_stats_invalid', `published.${key} must be true or false.`);
            switches[key] = published[key];
        }
        try {
            const out = await meStats.setPublished({ user, token: req.token, days: normaliseDays(body.days), published: switches });
            return res.json(out);
        } catch (err) {
            log.error('[OpenVibe.Report] the stats switches failed:', err && err.message ? String(err.message).slice(0, 200) : err);
            return problem(req, res, 500, 'report.me_stats_failed', 'Your public settings could not be saved.');
        }
    });

    // A person's published numbers. Only the sections they published are here; a person who has published nothing is
    // a 404 to a stranger, exactly as if they had never made a page. The answer is the owner's last snapshot.
    r.get('/u/:name/stats', async (req, res) => {
        const name = String(req.params.name || '');
        if (!isUsername(name)) return notFound(req, res, 'report.person_stats_not_found', 'No such person.');
        if (!meStats) return problem(req, res, 503, 'report.no_me_stats', 'Public numbers are not available in this process.');
        try {
            const body = await meStats.publicFor(name);
            if (!body || !meStats.anyPublished(body.published)) return notFound(req, res, 'report.person_stats_not_found', 'No public numbers for that person.');
            return res.json(body);
        } catch (err) {
            log.error('[OpenVibe.Report] the public stats failed:', err && err.message ? String(err.message).slice(0, 200) : err);
            return problem(req, res, 500, 'report.me_stats_failed', 'Those numbers could not be read.');
        }
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
