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
 *   GET /ai                     OpenVibe.Bench's public results: task kinds, benchmarks, runs and last runs
 *   GET /ai/method              how a score, a cost and a speed are made
 *   GET /ai/compare             two or three models side by side
 *   GET /ai/feed.xml            new runs as RSS
 *   GET /ai/:ref                one task kind (Elo/price/speed) or one public benchmark (bmk_…)
 *   GET /ai/models/:model       one model's runs over time, tasks, cost and recent runs
 *
 * A bad path parameter is a 404 without a source request; so is a source that answers nothing. Pages are public
 * for two minutes.
 *
 * The public pages the agent layer also twins have their data and view here (createPublicPages), so a route and its
 * Markdown twin render the very same page; `agent: true` in those views adds the discovery links.
 */
const express = require('express');
const { findCatalogModel, makerOf } = require('../data/ai-join');
const contracts = require('openvibe-contracts');
const views = require('../views');
const { normaliseDays, isSlug, isStreamId, isUsername, streamIdOf } = require('../data/source');
const { twinPath } = require('../agent-pages');
const designViews = require('../views/design');
const designHealth = require('../data/design-health');
const sharing = require('../sharing');
const aiComparisonViews = require('../views/ai-comparison');

const CACHE = 'public, max-age=120';

/** The pages the agent layer twins: their data, then the view. Each returns { html } or null (nothing to show). */
function createPublicPages({ sessionReports, network, live, bench, aiCatalogue = null, analytics = null, viewsData = null }) {
    const numbers = (days) => (analytics ? analytics.stats(days) : network.stats(days));

    async function home() {
        const [stats, rundown, topics] = await Promise.all([numbers(7), live.rundown(), live.topics()]);
        // Each part of the home stands alone: a source that does not answer leaves its part out, not the page.
        return { html: views.home({ stats, rundown, topics }) };
    }

    async function stats(days) {
        const [data, viewData] = await Promise.all([numbers(days), viewsData ? viewsData.top(days) : null]);
        return data ? { html: views.stats({ stats: data, days, views: viewData }) } : null;
    }

    function developers() {
        return { html: views.developers() };
    }

    async function aiIndex() {
        return aiComparisonHub();
    }

    async function comparisonData() {
        const [kindsResult, catalogue] = await Promise.all([bench.kinds(), require('../data/ai-market').comparisonCatalogue(aiCatalogue)]);
        const kinds = kindsResult && kindsResult.data && kindsResult.data.kinds || [];
        const boards = await Promise.all(kinds.map((kind) => bench.board(kind.id, 'elo')));
        const catModels = (catalogue && catalogue.models || []).map((model) => ({ ...model, offers: (model.offers || []).map((offer) => ({ ...offer, source: offer.source || { name: 'OpenVibe.AI', date: catalogue.generated_at || null, sample_size: offer.requests_7d ?? null } })) }));
        const findCat = (id) => findCatalogModel(catModels, id);
        const rows = [];
        for (let i = 0; i < boards.length; i += 1) {
            const list = boards[i] && boards[i].data && boards[i].data.board && boards[i].data.board.rows || [];
            for (const entry of list) {
                const id = entry.subject || entry.model || entry.name;
                const cat = findCat(id);
                rows.push({ id, routed: cat ? cat.routed !== false : false, kind: kinds[i].id, model_kind: cat && cat.kind || 'chat', maker: makerOf(cat, id), weights: cat && (cat.weights || (cat.open_weights == null ? null : cat.open_weights ? 'open' : 'closed')), status: cat && cat.status || 'current', uncensored: Boolean(cat && cat.uncensored), community: Boolean(cat && cat.community), rating: { value: entry.elo == null || Number(entry.games) === 0 ? null : Number(entry.elo), interval: Number(entry.games) === 0 ? [null, null] : [entry.ci_lower ?? null, entry.ci_upper ?? null], source: 'OpenVibe.Bench', date: boards[i].at || null, sample_size: entry.games ?? null }, benchmark: { value: entry.score == null ? null : Number(entry.score), reason: entry.score == null ? 'No benchmark score.' : undefined }, provider_offers: cat && Array.isArray(cat.offers) ? cat.offers : [], source: { name: 'OpenVibe.Bench', date: boards[i].at || null, sample_size: entry.games ?? null } });
            }
        }
        const grouped = new Map();
        for (const row of rows) {
            const existing = grouped.get(row.id);
            if (existing) existing.task_ratings.push({ kind: row.kind, rating: row.rating, benchmark: row.benchmark });
            else grouped.set(row.id, { ...row, task_ratings: [{ kind: row.kind, rating: row.rating, benchmark: row.benchmark }] });
        }
        rows.length = 0;
        rows.push(...grouped.values());
        // Every model the Exchange sells is listed with its prices and speed, rated or not: a model without
        // Bench games yet shows as not rated, never as missing.
        const ratedCats = new Set(rows.map((row) => findCat(row.id)).filter(Boolean));
        for (const cat of catModels) {
            if (ratedCats.has(cat)) continue;
            const id = cat.slug || cat.canonical || cat.id;
            if (!id) continue;
            const source = { name: 'OpenVibe.AI', date: catalogue.generated_at || null, sample_size: null };
            rows.push({ id, routed: cat.routed !== false, kind: cat.kind || null, model_kind: cat.kind || 'chat', maker: makerOf(cat, id), weights: cat.weights || (cat.open_weights == null ? null : cat.open_weights ? 'open' : 'closed'), status: cat.status || 'current', uncensored: Boolean(cat.uncensored), community: Boolean(cat.community), rating: { value: null, interval: [null, null], source: 'OpenVibe.Bench', date: null, sample_size: 0 }, benchmark: { value: null, reason: 'Not rated yet.' }, provider_offers: Array.isArray(cat.offers) ? cat.offers : [], source, task_ratings: [], unrated: true });
        }
        for (const kind of kinds) {
            const ranked = rows.map((row) => ({ row, task: row.task_ratings.find((rating) => rating.kind === kind.id) })).filter((x) => x.task).sort((a, b) => (b.task.rating.value ?? -Infinity) - (a.task.rating.value ?? -Infinity));
            ranked.forEach(({ task }, i) => {
                const [lo, hi] = task.rating.interval || [];
                if (lo == null || hi == null) return;
                const overlap = ranked.map((other, j) => ({ other, rank: j + 1 })).filter(({ other }) => other.task.rating.interval && other.task.rating.interval[0] != null && other.task.rating.interval[1] != null && other.task.rating.interval[0] <= hi && other.task.rating.interval[1] >= lo).map(({ rank }) => rank);
                task.rank = overlap.length ? { min: Math.min(...overlap), max: Math.max(...overlap), position: i + 1 } : null;
            });
        }
        const outPrice = (r) => Math.min(...(r.provider_offers || []).map((o) => (o.price && o.price.out != null ? Number(o.price.out) : NaN)).filter(Number.isFinite), Infinity);
        rows.sort((a, b) => (b.rating.value ?? -Infinity) - (a.rating.value ?? -Infinity)
            || (b.routed === true) - (a.routed === true)
            || outPrice(a) - outPrice(b)
            || String(a.id).localeCompare(String(b.id)));
        rows.forEach((row, i) => {
            const [lo, hi] = row.rating.interval || [];
            if (lo == null || hi == null) row.rank = null;
            else {
                const overlap = rows.map((other, j) => ({ other, rank: j + 1 })).filter(({ other }) => other.rating.interval && other.rating.interval[0] != null && other.rating.interval[1] != null && other.rating.interval[0] <= hi && other.rating.interval[1] >= lo).map(({ rank }) => rank);
                row.rank = overlap.length ? { min: Math.min(...overlap), max: Math.max(...overlap), position: i + 1 } : null;
            }
        });
        const tasks = kinds.map((kind) => ({ id: kind.id, name: kind.name }));
        const providers = catModels.flatMap((m) => (m.offers || []).map((o) => ({ ...o, routed: o.routed !== false, model: m.slug })));
        return { rows, providers, tasks, picks: [], catalogue };
    }

    async function aiComparisonHub() {
        const data = await comparisonData();
        const num = (x) => (x == null || x === '' ? NaN : Number(x));
        const chat = data.rows.filter((r) => (r.model_kind || 'chat') === 'chat');
        const rated = chat.filter((r) => r.rating.value != null);
        const best = (list) => [...list].sort((a, b) => b.rating.value - a.rating.value)[0];
        const cheapest = (r) => Math.min(...(r.provider_offers || []).map((o) => num(o.price && o.price.out)).filter(Number.isFinite), Infinity);
        const fastest = (r) => Math.min(...(r.provider_offers || []).filter((o) => Number(o.requests_7d) > 0).map((o) => num(o.speed && o.speed.p50_ms)).filter(Number.isFinite), Infinity);
        const free = (r) => (r.provider_offers || []).some((o) => o.free === true || o.free_now === true || num(o.price && o.price.out) === 0);
        const taskRows = (kind) => rated.map((row) => { const task = row.task_ratings.find((x) => x.kind === kind && x.rating && x.rating.value != null); return task ? { ...row, kind, rating: task.rating, benchmark: task.benchmark } : null; }).filter(Boolean);
        const choose = (id, model, why) => ({ id, model: model || null, why: model ? why : 'Not enough source data to establish this pick.' });
        data.picks = [
            choose('overall', best(rated), 'Highest rating from blind votes and open runs.'),
            choose('value', rated.filter((r) => Number.isFinite(cheapest(r))).sort((a, b) => cheapest(a) - cheapest(b))[0], 'Lowest output price among rated models.'),
            choose('fastest', chat.filter((r) => Number.isFinite(fastest(r))).sort((a, b) => fastest(a) - fastest(b))[0], 'Fastest typical reply on real traffic this week.'),
            choose('open', best(rated.filter((r) => ['open', 'open_weights'].includes(r.weights))), 'Highest-rated model with open weights.'),
            choose('code', best(taskRows('code')), 'Highest rating on code tasks.'),
            choose('writing', best(taskRows('writing')), 'Highest rating on writing tasks.'),
            choose('uncensored', best(rated.filter((r) => r.uncensored)), 'Highest-rated uncensored model; 18+.'),
            choose('free', best(rated.filter(free)) || chat.find(free), 'Free to use now through the Exchange.'),
        ];
        data.others = data.rows.length - chat.length;
        data.rows = chat;
        return { html: aiComparisonViews.hub(data) };
    }
    async function aiComparisonLeaderboard(query = {}) {
        const nz = (x) => (x == null || x === '' ? NaN : Number(x));
        const data = await comparisonData();
        let rows = data.rows;
        if (query.kind) rows = rows.map((x) => {
            const task = x.task_ratings.find((rating) => rating.kind === query.kind);
            return task ? { ...x, kind: query.kind, rating: task.rating, benchmark: task.benchmark } : x.kind === query.kind ? x : null;
        }).filter(Boolean);
        const type = ['chat', 'embedding', 'stt', 'all'].includes(query.type) ? query.type : 'chat';
        if (type !== 'all') rows = rows.filter((x) => (x.model_kind || 'chat') === type);
        if (query.maker) rows = rows.filter((x) => String(x.maker || '').toLowerCase() === String(query.maker).toLowerCase());
        if (query.weights) rows = rows.filter((x) => x.weights === query.weights || (query.weights === 'open' && x.weights === 'open_weights'));
        if (query.status !== 'all') rows = rows.filter((x) => x.status === (query.status || 'current'));
        if (query.uncensored) rows = rows.filter((x) => x.uncensored);
        if (query.community) rows = rows.filter((x) => x.community);
        if (query.price) rows = rows.filter((x) => x.provider_offers.some((o) => {
            const p = nz(o.price && o.price.out);
            return query.price === 'free' ? (o.free === true || o.free_now === true || p === 0) : !Number.isFinite(p) ? false : query.price === 'low' ? p <= 1 : query.price === 'mid' ? p > 1 && p <= 10 : query.price === 'high' ? p > 10 : true;
        }));
        if (query.q) rows = rows.filter((x) => `${x.id} ${x.maker || ''}`.toLowerCase().includes(String(query.q).toLowerCase()));
        if (query.sort === 'name') rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
        if (query.sort === 'price') rows.sort((a, b) => Math.min(...a.provider_offers.map((o) => nz(o.price && o.price.out)).filter(Number.isFinite), Infinity) - Math.min(...b.provider_offers.map((o) => nz(o.price && o.price.out)).filter(Number.isFinite), Infinity));
        if (query.sort === 'speed') rows.sort((a, b) => Math.min(...a.provider_offers.filter((o) => Number(o.requests_7d) > 0).map((o) => nz(o.speed && o.speed.p50_ms)).filter(Number.isFinite), Infinity) - Math.min(...b.provider_offers.filter((o) => Number(o.requests_7d) > 0).map((o) => nz(o.speed && o.speed.p50_ms)).filter(Number.isFinite), Infinity));
        if (query.sort === 'rating') rows.sort((a, b) => (b.rating.value ?? -Infinity) - (a.rating.value ?? -Infinity));
        return { html: aiComparisonViews.leaderboard({ rows, filters: query }) };
    }
    async function aiComparisonProviders() { const data = await comparisonData(); return { html: aiComparisonViews.providers(data) }; }
    async function aiComparisonModel(id) {
        if (!bench.isModelName(id)) return null;
        const data = await comparisonData();
        const row = data.rows.find((x) => x.id === id);
        const detail = await bench.modelDetail(id);
        return { html: aiComparisonViews.model({ id, detail: detail && detail.data, sourceDate: detail && detail.at, row, providers: data.providers }) };
    }
    async function aiComparison({ models = [] } = {}) {
        const data = await comparisonData();
        const selected = models.map((id) => data.rows.find((x) => x.id === id) || { id, reason: 'No public model data.' });
        return { html: aiComparisonViews.compare({ models: selected, options: data.rows.map((x) => x.id) }) };
    }
    function aiArena() { return { html: aiComparisonViews.arena() }; }

    async function aiBoard(kindId, tab) {
        if (!bench.isKindId(kindId)) return null;
        const [kinds, board, cost, benchmarks, runs, overview] = await Promise.all([
            bench.kinds(),
            bench.board(kindId, tab),
            tab === 'pareto' ? bench.board(kindId, 'cost') : Promise.resolve(null),
            bench.benchmarks(),
            bench.runs({ kind: kindId, limit: 8 }),
            bench.overview(),
        ]);
        const kind = kinds && Array.isArray(kinds.data.kinds) ? kinds.data.kinds.find((k) => k.id === kindId) : null;
        if (kinds && !kind) return null;
        const kindBenchmarks = benchmarks && benchmarks.data && Array.isArray(benchmarks.data.benchmarks)
            ? benchmarks.data.benchmarks.filter((b) => b.kind === kindId) : [];
        const rankings = await Promise.all(kindBenchmarks.map((b) => bench.rankings(b.id, 'score')));
        return { html: views.aiBoard({ kindId, kind, tab, board, cost, kinds, benchmarks, rankings, runs, overview }) };
    }

    async function aiBenchmark(benchmarkId) {
        if (!bench.isBenchmarkId(benchmarkId)) return null;
        const [benchmark, rankings, runs, overview] = await Promise.all([
            bench.benchmark(benchmarkId), bench.rankings(benchmarkId, 'score'), bench.runs({ benchmark: benchmarkId, limit: 20 }), bench.overview(),
        ]);
        // A public id the overview does not list is a 404; a Bench that did not answer at all is the honest unavailable page.
        const list = overview && overview.data && Array.isArray(overview.data.list) ? overview.data.list : null;
        if (list && !list.some((b) => b.id === benchmarkId)) return null;
        return { html: views.aiBenchmark({ benchmark, rankings, runs }) };
    }

    async function aiModel(model) {
        if (!bench.isModelName(model)) return null;
        const [detail, legacy] = await Promise.all([bench.modelDetail(model), bench.modelSummary(model)]);
        return { html: views.aiModel({ model, detail, legacy }) };
    }

    async function aiMethod() {
        const [overview, kinds] = await Promise.all([bench.overview(), bench.kinds()]);
        return { html: views.aiMethod({ overview, kinds }) };
    }

    async function aiCompare(models = [], errors = []) {
        const clean = [...new Set((models || []).filter((m) => bench.isModelName(m)))].slice(0, 3);
        const [details, legacy] = await Promise.all([
            Promise.all(clean.map((m) => bench.modelDetail(m))),
            Promise.all(clean.map((m) => bench.modelSummary(m))),
        ]);
        return { models: clean, html: views.aiCompare({ models: clean, details, legacy, errors }) };
    }

    async function aiFeed() {
        const [runs, overview] = await Promise.all([bench.runs({ limit: 20 }), bench.overview()]);
        return { runs, overview };
    }

    function design() { return { html: designViews.designHealth(designHealth.all()) }; }

    async function rundown() {
        const [r, topics, reports] = await Promise.all([
            live.rundown(), live.topics(),
            sessionReports ? sessionReports.listPublicToday({ limit: 24 }) : [],
        ]);
        return { html: views.rundown({ rundown: r, topics, reports }) };
    }

    return { home, stats, developers, design, rundown, aiIndex, aiBoard, aiBenchmark, aiModel, aiMethod, aiCompare, aiFeed, aiComparisonHub, aiComparisonLeaderboard, aiComparisonProviders, aiComparisonModel, aiComparison, aiArena };
}

/** The new-results feed: one item per public run, with its own Bench date and no invented number. */
function rssFeed({ runs, overview, base }) {
    const xml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const list = runs && runs.data && Array.isArray(runs.data.runs) ? runs.data.runs : [];
    const titles = new Map((overview && overview.data && Array.isArray(overview.data.list) ? overview.data.list : []).map((b) => [b.id, b.title]));
    const site = String(base || 'https://openvibe.report').replace(/\/+$/, '');
    const items = list.map((r) => {
        const title = `${r.model} on ${titles.get(r.benchmark_id) || r.benchmark_id}`;
        const link = `${site}/ai/${encodeURIComponent(r.benchmark_id)}`;
        const score = r.score == null ? 'no score' : `${Math.round(Number(r.score) * 10) / 10}/100`;
        const cost = r.cost_usd == null ? 'cost not given' : `$${Number(r.cost_usd).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
        const speed = r.ms == null ? 'time not given' : `${Math.round(Number(r.ms))} ms`;
        const at = Date.parse(r.created_at);
        return `<item><title>${xml(title)}</title><link>${xml(link)}</link><guid isPermaLink="false">${xml(r.id)}</guid>${Number.isFinite(at) ? `<pubDate>${new Date(at).toUTCString()}</pubDate>` : ''}<description>${xml(`${r.model} scored ${score} on ${titles.get(r.benchmark_id) || r.benchmark_id}, for ${cost} in ${speed} (${r.provenance || 'run'}).`)}</description></item>`;
    }).join('');
    const newest = list.length ? Date.parse(list[0].created_at) : NaN;
    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>OpenVibe AI: new results</title><link>${xml(`${site}/ai`)}</link><description>Verified and submitted AI runs as OpenVibe.Bench publishes them.</description><language>en</language>${Number.isFinite(newest) ? `<lastBuildDate>${new Date(newest).toUTCString()}</lastBuildDate>` : ''}${items}</channel></rss>`;
}

function createPageRoutes(ctx) {
    const { live, bench, sessionReports, viewsData } = ctx;
    const r = express.Router();
    const publicPages = ctx.publicPages || createPublicPages(ctx);
    // The Rundown's pages canonicalise to OpenVibe.Live, and so does its Markdown twin: the generic agent layer
    // (server/agent-pages.js) would sign the twin with this site's own address. Answer it here instead, before the
    // .md hand-off, with Live's canonical.
    r.get('/rundown.md', async (_req, res) => {
        const { markdownTwin } = require('openvibe-shared/agent-layer');
        const page = await publicPages.rundown();
        const body = markdownTwin({ html: page.html, canonical: 'https://openvibe.live/rundown' });
        res.set('Content-Type', 'text/markdown; charset=utf-8').set('Cache-Control', CACHE).send(body);
    });
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

    r.get('/ai', async (_req, res) => send(_req, res, (await publicPages.aiComparisonHub()).html));

    r.get('/ai/leaderboard', async (req, res) => send(req, res, (await publicPages.aiComparisonLeaderboard(req.query)).html));
    r.get('/ai/providers', async (req, res) => send(req, res, (await publicPages.aiComparisonProviders()).html));
    r.get('/ai/arena', (_req, res) => send(_req, res, publicPages.aiArena().html));
    r.get('/ai/compare', async (req, res) => {
        // The picker sends a and b; older links send models=a,b.
        const picked = [req.query.a, req.query.b].map((x) => String(x || '').trim()).filter(Boolean);
        const models = picked.length ? picked : String(req.query.models || '').split(',').map((x) => x.trim()).filter(Boolean);
        if (models.length === 2) return res.redirect(301, `/ai/compare/${encodeURIComponent(models[0])}-vs-${encodeURIComponent(models[1])}`);
        return send(req, res, (await publicPages.aiComparison({ models })).html);
    });
    r.get('/ai/compare/:pair', async (req, res) => {
        const match = String(req.params.pair).match(/^(.+)-vs-(.+)$/);
        if (!match) return notFound(req, res);
        const ordered = [decodeURIComponent(match[1]), decodeURIComponent(match[2])].sort();
        const canonical = `/ai/compare/${encodeURIComponent(ordered[0])}-vs-${encodeURIComponent(ordered[1])}`;
        if (req.path !== canonical) return res.redirect(301, canonical);
        return send(req, res, (await publicPages.aiComparison({ models: ordered })).html);
    });

    r.get('/ai/models/:model', async (req, res) => {
        const page = await publicPages.aiComparisonModel(req.params.model);
        if (!page) return notFound(req, res);
        return send(req, res, page.html);
    });

    // The AI section's method, comparison and feed. They must sit before /ai/:ref, which would read them as a kind.
    r.get('/ai/method', async (req, res) => send(req, res, (await publicPages.aiMethod()).html, 200, 'no-store'));

    r.get('/ai/compare', async (req, res) => {
        const raw = String(req.query.models || '').split(',').map((x) => x.trim()).filter(Boolean);
        const errors = [];
        const unique = [...new Set(raw)];
        if (unique.length < 2) errors.push('Pick at least two model ids, comma separated.');
        if (unique.length > 3) errors.push('At most three models can be compared at once.');
        const page = await publicPages.aiCompare(unique.slice(0, 3), errors);
        return send(req, res, page.html, 200, 'no-store');
    });

    r.get('/ai/feed.xml', async (req, res) => {
        const feed = await publicPages.aiFeed();
        res.status(200).set('Cache-Control', 'public, max-age=120').type('application/rss+xml; charset=utf-8').send(rssFeed({ ...feed, base: ctx.config.baseUrl }));
    });

    // The AI Exchange's daily aggregates (plan G-P9), staff-only, behind REPORT_AI_EXCHANGE. The gate is the signed-in
    // person's staff role (`staff.site.view`, the capability that covers analytics and money state), the same
    // openvibe-contracts staff map other staff pages use. The page is private and never cached.
    r.get('/ai/exchange', async (req, res) => {
        if (!ctx.config.aiExchange || !ctx.config.aiExchange.enabled) return notFound(req, res);
        if (!req.user) return send(req, res, views.staffOnly({ signedIn: false }), 401, 'private, no-store');
        if (!contracts.staff.can(req.user, 'staff.site.view')) return send(req, res, views.staffOnly({ signedIn: true }), 403, 'private, no-store');
        if (!ctx.aiExchange) return contracts.http.sendProblem(res, 503, 'report.no_database', { detail: 'Report has no database in this process.', ctx: req.ov });
        try {
            const body = await ctx.aiExchange.analytics({ from: req.query.from || null, to: req.query.to || null });
            return send(req, res, views.aiExchange(body), 200, 'private, no-store');
        } catch (err) {
            if (err instanceof RangeError) return contracts.http.sendProblem(res, 422, 'ai.invalid', { detail: err.message, ctx: req.ov });
            ctx.log.error('[OpenVibe.Report] the AI Exchange page failed:', err && err.message ? String(err.message).slice(0, 200) : err);
            return contracts.http.sendProblem(res, 500, 'report.ai_exchange_failed', { detail: 'The AI Exchange aggregates could not be read.', ctx: req.ov });
        }
    });

    r.get('/ai/:ref', async (req, res) => {
        const ref = String(req.params.ref || '');
        const page = bench.isBenchmarkId(ref)
            ? await publicPages.aiBenchmark(ref)
            : await publicPages.aiBoard(ref, bench.normaliseTab(req.query.tab));
        if (!page) return notFound(req, res);
        return send(req, res, page.html, 200, 'no-store');
    });

    r.get('/rundown', async (req, res) => {
        const [rundown, topics, reports] = await Promise.all([
            live.rundown(), live.topics(),
            sessionReports ? sessionReports.listPublicToday({ limit: 24 }) : [],
        ]);
        if (!rundown || !topics) return notFound(req, res);
        return send(req, res, views.rundown({ rundown, topics, reports }));
    });

    // One agent session's report (Agent Streams S3), in the sharing system's four audiences (design 2026-11-06): the
    // share row decides, through canView, and nobody else learns whether it exists — a report of Specific people is a
    // 404 for a signed-in person who is not on the list, and for everyone signed out.
    r.get('/s/:id', async (req, res) => {
        const id = String(req.params.id || '');
        const rep = sessionReports ? await sessionReports.get(id) : null;
        if (!rep) return notFound(req, res);
        const viewer = sharing.viewerOf(req.user);
        if (!(await sharing.canView(viewer, rep))) return notFound(req, res);
        const audience = await sharing.audienceOf(rep);
        const isOwner = Boolean(viewer && viewer.subject.id === rep.owner);
        const members = isOwner ? await sharing.memberSubjects(rep.id) : [];
        // Only a signed-out visitor's copy of a public report may be stored by a shared cache. A signed-in reader's
        // page carries their own parts — above all the owner's, which names the Share sheet's kind and id and the
        // people the report is shared with — and Cloudflare on our zones does not honour Vary or Authorization, so a
        // public header there could hand the owner's page to the next visitor. Signed in is always private, no-store.
        const cacheControl = audience === 'public' && !viewer ? CACHE : 'private, no-store';
        return send(req, res, views.sessionReport({ report: rep, signedIn: Boolean(viewer), isOwner, audience, members }), 200, cacheControl);
    });

    r.get('/rundown/t/:slug', async (req, res) => {
        const { slug } = req.params;
        if (!isSlug(slug)) return notFound(req, res);
        const topic = await live.topic(slug);
        if (!topic) return notFound(req, res);
        // S7: a public agent report may cite the topic when the agent worked on it (only Everyone's reports).
        const citations = sessionReports ? await sessionReports.listPublicMatchingTopic((topic.topic && topic.topic.title) || topic.title).catch(() => []) : [];
        return send(req, res, views.topic({ topic, citations }));
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

    // A person's stats (the owner, 2026-11-09): /me is private and signed in only, with a switch per section; /u/<name>
    // is the same document with only the sections the person made public. Both are server-rendered, so the words and
    // the numbers are crawlable when published; /me is never indexed. The public page is the owner's last snapshot,
    // dated in the page, because Network's history can only be read with the person's own token.
    r.get('/me', async (req, res) => {
        const user = req.user;
        if (!user || !isUsername(String(user.username || ''))) return send(req, res, views.meSignedOut(), 200, 'private, no-store');
        const days = normaliseDays(req.query.days);
        try {
            const doc = await ctx.meStats.compute({ user, token: req.token, days });
            return send(req, res, views.me({ user, doc, days }), 200, 'private, no-store');
        } catch (err) {
            ctx.log.error('[OpenVibe.Report] the /me page failed:', err && err.message ? String(err.message).slice(0, 200) : err);
            return send(req, res, views.meError({ user }), 500, 'private, no-store');
        }
    });

    r.get('/u/:username', async (req, res) => {
        const { username } = req.params;
        if (!isUsername(username)) return notFound(req, res);
        const doc = ctx.meStats ? await ctx.meStats.publicFor(username) : null;
        if (!doc) return notFound(req, res);
        const published = ctx.meStats.anyPublished(doc.published);
        return send(req, res, published ? views.publicStats({ doc }) : views.publicStatsPrivate({ doc }), 200, published ? CACHE : 'private, no-store');
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
        const [stats, recaps, speaker, ai, reports] = await Promise.all([
            ctx.analytics && typeof ctx.analytics.channel === 'function' ? ctx.analytics.channel(user.username, days).catch(() => null) : null,
            Promise.resolve(live.channelRecaps(user.username)).catch(() => null),
            Promise.resolve(live.speaker(user.username)).catch(() => null),
            subject && ctx.aiUsage ? ctx.aiUsage.forPerson({ subject, from, group: 'day' }).catch(() => null) : null,
            subject && sessionReports ? sessionReports.listForOwner(subject, { limit: 20 }).catch(() => null) : null,
        ]);
        // Their own reports, each with the audience it has now, and the default for the next one.
        const withAudience = reports ? await Promise.all(reports.map(async (r) => ({ ...r, audience: await sharing.audienceOf(r) }))) : null;
        const defaultAudience = subject && sessionReports ? (await sessionReports.defaultAudience(subject)) || 'private' : 'private';
        return send(req, res, views.you({ user, days, stats, recaps, speaker, ai, reports: withAudience, defaultAudience }), 200, 'private, no-store');
    });

    r.get('/c/:username', async (req, res) => {
        const { username } = req.params;
        if (!isUsername(username)) return notFound(req, res);
        const [recaps, viewRows] = await Promise.all([live.channelRecaps(username), viewsData ? viewsData.creator(username, 30) : null]);
        if (!recaps) return notFound(req, res);
        return send(req, res, views.channel({ username, recaps, views: viewRows }));
    });

    return r;
}

module.exports = { createPageRoutes, createPublicPages };
