'use strict';

/**
 * The AI section (owner, 2026-11-08): Bench's pages moved into Report. The overview, one task kind, one benchmark,
 * one model, the comparison, the method page and the new-results feeds read only Bench's public answers.
 */
const assert = require('assert');
const { boot, check, done, stubFetch, jsonResponse } = require('./helpers/boot');

const BMK = 'bmk_01M65KA3H4Y4ZENBYYZQA8SRNN';
const RUN_A = 'brn_01M65KA3H4Y4ZENBYYZQA8SRN1';
const RUN_B = 'brn_01M65KA3H4Y4ZENBYYZQA8SRN2';

const overview = {
    kinds: 2, benchmarks: 1, tasks: 2, runs: 3, models: 2, last_run: '2026-11-07T10:00:00.000Z',
    list: [{ id: BMK, title: 'Playable games arena', kind: 'design.page', description: 'A test benchmark.', latest_version: 1, runs: 3, last_run: '2026-11-07T10:00:00.000Z' }],
    recent: [
        { id: RUN_B, benchmark_id: BMK, model: 'model-b', score: 70, cost_usd: 0.04, ms: 2000, provenance: 'verified', created_at: '2026-11-07T10:00:00.000Z' },
        { id: RUN_A, benchmark_id: BMK, model: 'model-a', score: 90, cost_usd: 0.02, ms: 1000, provenance: 'verified', created_at: '2026-11-06T10:00:00.000Z' },
    ],
};

const runs = {
    count: 2, offset: 0, last_run: '2026-11-07T10:00:00.000Z',
    runs: [
        { id: RUN_B, benchmark_id: BMK, model: 'model-b', score: 70, cost_usd: 0.04, ms: 2000, tokens: 20, provenance: 'verified', created_at: '2026-11-07T10:00:00.000Z' },
        { id: RUN_A, benchmark_id: BMK, model: 'model-a', score: 90, cost_usd: 0.02, ms: 1000, tokens: 10, provenance: 'verified', created_at: '2026-11-06T10:00:00.000Z' },
    ],
};

const rankings = { rankings: { benchmark: BMK, metric: 'score', entries: [
    { model: 'model-a', runs: 2, score: 85, cost_usd: 0.02, ms: 1000, cost_per_solved: 0.024, min_score: 80, max_score: 90, last_run: '2026-11-06T10:00:00.000Z' },
    { model: 'model-b', runs: 1, score: 70, cost_usd: 0.04, ms: 2000, cost_per_solved: 0.057, min_score: 70, max_score: 70, last_run: '2026-11-07T10:00:00.000Z' },
] } };

const benchmark = {
    benchmark: { id: BMK, title: 'Playable games arena', kind: 'design.page', description: 'A test benchmark.' },
    version: { version: 1, created_at: '2026-10-30T05:07:52.000Z' },
    definition: { tasks: [{ id: 't1', prompt: 'Build one screen.' }, { id: 't2', prompt: 'Build another.' }] },
    task_meta: [],
};

const modelDetail = {
    model: 'model-a', runs: 2,
    benchmarks: [{ benchmark_id: BMK, title: 'Playable games arena', kind: 'design.page', runs: 2, score: 85, best: 90, worst: 80, cost_usd: 0.02, ms: 1000, last_run: '2026-11-06T10:00:00.000Z' }],
    tasks: [
        { benchmark_id: BMK, benchmark_title: 'Playable games arena', task_id: 't1', runs: 2, score: 90, best: 90, worst: 90, last_run: '2026-11-06T10:00:00.000Z' },
        { benchmark_id: BMK, benchmark_title: 'Playable games arena', task_id: 't2', runs: 2, score: 80, best: 80, worst: 80, last_run: '2026-11-06T10:00:00.000Z' },
    ],
    best_task: { task_id: 't1', score: 90 }, worst_task: { task_id: 't2', score: 80 },
    total_cost_usd: 0.04, total_ms: 2000, total_tokens: 20, last_run: '2026-11-06T10:00:00.000Z',
    recent_runs: [
        ...runs.runs.filter((r) => r.model === 'model-a'),
        { id: 'brn_01M65KA3H4Y4ZENBYYZQA8SRN3', benchmark_id: BMK, model: 'model-a', score: 80, cost_usd: 0.02, ms: 1200, tokens: 10, provenance: 'verified', created_at: '2026-11-05T10:00:00.000Z' },
    ],
};

const legacy = { model: 'model-a', ratings: [{ kind_id: 'design.page', elo: 1043, ci_lower: 1005, ci_upper: 1081, games: 8, win_rate: 0.75 }], entries: [], total_cost_usd: 0.04 };

(async () => {
    const source = stubFetch();
    const fetchImpl = async (url, opts) => {
        const u = new URL(String(url));
        if (u.port !== '5230') return source(url, opts);
        const p = u.pathname;
        if (p === '/api/v1/kinds') return jsonResponse({ count: 1, kinds: [{ id: 'design.page', room: 'design', name: 'Design page arena', judge: 'human_pairwise' }] });
        if (p === '/api/v1/boards/design.page') {
            const type = u.searchParams.get('type');
            const rows = type === 'elo'
                ? [{ subject: 'model-a', elo: 1043, ci_lower: 1005, ci_upper: 1081, games: 8, win_rate: 0.75, median_cost_usd: 0.02, median_ms: 1000, provisional: true }]
                : type === 'pareto' ? [{ subject: 'model-a', quality: 0.8 }] : [{ subject: 'model-a', entries: 2, solved: 2, total_cost_usd: 0.04, cost_per_solved: 0.02, median_ms: 1000 }];
            return jsonResponse({ board: { kind_id: 'design.page', type, rows } });
        }
        if (p === '/api/v1/overview') return jsonResponse(overview);
        if (p === '/api/v1/benchmarks') return jsonResponse({ count: 1, benchmarks: overview.list });
        if (p === `/api/v1/benchmarks/${BMK}`) return jsonResponse(benchmark);
        if (p === '/api/v1/rankings') return jsonResponse(rankings);
        if (p === '/api/v1/runs') return jsonResponse(runs);
        if (p === '/api/v1/models/model-a') return jsonResponse(legacy);
        if (p === '/api/v1/models/model-a/summary') return jsonResponse(modelDetail);
        if (p === '/api/v1/models/model-b/summary') return jsonResponse({ ...modelDetail, model: 'model-b', runs: 1, total_cost_usd: 0.04, recent_runs: runs.runs.filter((r) => r.model === 'model-b') });
        return jsonResponse({ error: 'no stub for ' + p }, 404);
    };
    const t = await boot({ fetchImpl, env: { OV_BENCH_INTERNAL_URL: 'http://127.0.0.1:5230' } });
    try {
        await check('the AI overview renders the leaderboard hub from the Bench fixture', async () => {
            const r = await t.get('/ai');
            assert.strictEqual(r.status, 200);
            for (const s of ['AI model leaderboard', 'model-a', '1043', 'Best overall', 'FAQPage', 'Dataset']) assert.ok(r.text.includes(s), s);
            assert.ok(r.text.includes('href="/ai/leaderboard"') && r.text.includes('/api/v1/ai/leaderboard'));
        });

        await check('one task kind shows quality, price and speed side by side and its latest runs', async () => {
            const r = await t.get('/ai/design.page');
            assert.strictEqual(r.status, 200);
            for (const s of ['Quality, price and speed side by side', 'Cost/run', 'Speed/run', '$0.02', '1 s', 'Latest runs', 'model-a', 'Nov 7']) assert.ok(r.text.includes(s), s);
        });

        await check('one benchmark page has a ranking, an SVG and the latest runs', async () => {
            const r = await t.get(`/ai/${BMK}`);
            assert.strictEqual(r.status, 200);
            for (const s of ['Playable games arena', 'Score against cost per run', 'ovk-chart--scatter', 'model-a', '85', '$0.02', 'Cost per solved', 'Latest runs', 'version 1']) assert.ok(r.text.includes(s), s);
        });

        await check('one model page uses the comparison profile and available Bench task data', async () => {
            const r = await t.get('/ai/models/model-a');
            assert.strictEqual(r.status, 200);
            for (const s of ['Providers', 'Task ratings', 'Playable games arena', 'snapshot', 'Product', 'Try it in Chat', 'Use it from code']) assert.ok(r.text.includes(s), s);
            assert.ok(!r.text.includes('&lt;span title='), 'a stat is escaped HTML, not markup');
        });

        await check('the old query compare redirects to a canonical pair page', async () => {
            const two = await t.get('/ai/compare?models=model-a,model-b');
            assert.strictEqual(two.status, 301);
            assert.strictEqual(two.headers.get('location'), '/ai/compare/model-a-vs-model-b');
            const pair = await t.get('/ai/compare/model-a-vs-model-b');
            assert.strictEqual(pair.status, 200);
            assert.ok(pair.text.includes('model-a') && pair.text.includes('model-b'), 'both models');
            const one = await t.get('/ai/compare?models=model-a');
            assert.strictEqual(one.status, 200);
            assert.ok(one.text.includes('Choose two models to compare'), 'ask for a second model');
        });

        await check('an unknown benchmark id is a 404 once Bench has answered its list', async () => {
            assert.strictEqual((await t.get('/ai/bmk_01M65KA3H4Y4ZENBYYZQA8SRN9')).status, 404);
        });

        await check('the method page explains judging, verification and cost', async () => {
            const r = await t.get('/ai/method');
            assert.strictEqual(r.status, 200);
            for (const s of ['What a score means', 'How runs are judged', 'Verified and submitted', 'Cost per solved', 'blind votes', 'benchmarks.jsonl']) assert.ok(r.text.includes(s), s);
        });

        await check('new results are RSS and JSON, from the same runs', async () => {
            const rss = await t.get('/ai/feed.xml');
            assert.strictEqual(rss.status, 200);
            assert.match(rss.headers.get('content-type') || '', /application\/rss\+xml/);
            assert.ok(rss.text.includes('<title>model-a on Playable games arena</title>') && rss.text.includes(RUN_A), 'the run is in the feed');
            const json = await t.get('/api/v1/ai/results');
            assert.strictEqual(json.status, 200);
            const body = json.json();
            assert.strictEqual(body.count, 2);
            assert.strictEqual(body.results[0].id, RUN_B);
            assert.strictEqual(body.results[0].benchmark, 'Playable games arena');
            assert.ok(body.results[0].url.endsWith('/ai/' + BMK));
        });

        await check('the AI pages have Markdown twins, and the benchmark twin names its page', async () => {
            for (const [path, expected] of [[`/ai/${BMK}.md`, 'Playable games arena'], ['/ai/method.md', 'How the AI results are judged'], ['/ai/models/model-a.md', 'model-a']]) {
                const r = await t.get(path);
                assert.strictEqual(r.status, 200, path);
                assert.match(r.headers.get('content-type') || '', /^text\/markdown/, path);
                assert.ok(r.text.includes(expected), `${path}: ${expected}`);
            }
        });

        await check('the sitemap lists the AI pages and the benchmark', async () => {
            const r = await t.get('/sitemap.xml');
            assert.strictEqual(r.status, 200);
            for (const s of ['/ai</loc>', '/ai/method', '/ai/compare', `/ai/${BMK}`, '/ai/design.page', '/ai/models/model-a']) assert.ok(r.text.includes(s), s);
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
