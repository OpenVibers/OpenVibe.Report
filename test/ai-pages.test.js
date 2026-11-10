'use strict';

const assert = require('assert');
const { boot, check, done, stubFetch, jsonResponse } = require('./helpers/boot');

(async () => {
    let time = Date.parse('2026-10-28T12:00:00Z');
    let down = false;
    const source = stubFetch();
    const calls = [];
    const fetchImpl = async (url, opts) => {
        const u = new URL(String(url));
        if (u.port !== '5230') return source(url, opts);
        calls.push(u.pathname + u.search);
        if (down) throw new Error('Bench offline');
        if (u.pathname === '/api/v1/kinds') return jsonResponse({ count: 1, kinds: [{ id: 'design.page', room: 'design', name: 'Page <design>', judge: 'human_pairwise' }] });
        if (['/api/v1/boards/design.page', '/api/v1/ratings/design.page'].includes(u.pathname)) {
            const type = u.pathname.includes('/ratings/') ? 'elo' : u.searchParams.get('type');
            const rows = {
                elo: [
                    { subject: 'openai/gpt-4o', elo: 1043, ci_lower: 1005, ci_upper: 1081, games: 20, win_rate: 0.75, provisional: false },
                    { subject: 'model-b', elo: 980, ci_lower: 940, ci_upper: 1020, games: 20, win_rate: 0.25, provisional: false },
                ],
                pareto: [
                    { subject: 'openai/gpt-4o', quality: 0.8 },
                    { subject: 'model-b', quality: 0.6 },
                ],
                cost: [
                    { subject: 'model-b', entries: 8, solved: 6, total_cost_usd: 0.3, cost_per_solved: 0.05 },
                    { subject: 'openai/gpt-4o', entries: 8, solved: 8, total_cost_usd: 0.8, cost_per_solved: 0.1 },
                ],
            }[type];
            return rows ? jsonResponse({ board: { kind_id: 'design.page', type, rows } }) : jsonResponse({}, 404);
        }
        if (u.pathname === '/api/v1/models/openai%2Fgpt-4o') return jsonResponse({ model: 'openai/gpt-4o', ratings: [{ kind_id: 'design.page', elo: 1043, ci_lower: 1005, ci_upper: 1081, games: 20, win_rate: 0.75 }], entries: [{ kind_id: 'design.page' }], total_cost_usd: 0.8 });
        return jsonResponse({}, 404);
    };
    const t = await boot({ fetchImpl, now: () => time, env: { OV_BENCH_INTERNAL_URL: 'http://127.0.0.1:5230' } });
    try {
        await check('/ai renders the comparison hub and structured data', async () => {
            const r = await t.get('/ai');
            assert.strictEqual(r.status, 200);
            for (const s of ['AI model leaderboard', 'openai/gpt-4o', 'Best overall', 'Dataset', 'FAQPage']) assert.ok(r.text.includes(s), s);
            assert.ok(!r.text.includes('Page <design>'));
        });

        await check('Shared Elo shows ranks, intervals and win rates', async () => {
            const r = await t.get('/ai/design.page');
            assert.strictEqual(r.status, 200);
            for (const s of ['<ol class="ovk-rank"', '<b>1,043</b><small>± 38</small>', '75% won', 'Ranking', '95% interval', 'dataset JSONL']) assert.ok(r.text.includes(s), s);
            const data = await t.get('/api/v1/ai/ratings/design.page');
            assert.strictEqual(data.status, 200, data.text);
            assert.strictEqual(data.json().board.rows[0].elo, 1043);
            assert.strictEqual(data.json().board.rows[0].games, 20);
            assert.strictEqual(data.headers.get('access-control-allow-origin'), '*');
            const preflight = await t.get('/api/v1/ai/ratings/design.page', { method: 'OPTIONS' });
            assert.strictEqual(preflight.status, 204);
            assert.match(preflight.headers.get('access-control-allow-headers'), /traceparent/);
        });

        await check('Pareto has an inline SVG, frontier labels and an exact-value table', async () => {
            const r = await t.get('/ai/design.page?tab=pareto');
            assert.strictEqual(r.status, 200);
            for (const s of ['ovk-chart--scatter', '<svg', 'class="ovk-chart-front"', 'Quality against cost per solved task', 'Cost per solved task (USD', 'frontier', 'model-b', 'dataset JSONL', '<table']) assert.ok(r.text.includes(s), s);
            assert.ok(r.text.includes('data-label="Quality">80%</td>') && r.text.includes('data-label="Cost per solved">$0.10</td>'), 'the exact numbers, not dashes');
        });

        await check('cost and model views quote Bench numbers', async () => {
            const cost = await t.get('/ai/design.page?tab=cost');
            assert.strictEqual(cost.status, 200);
            assert.ok(cost.text.includes('Cost per solved'));
            assert.ok(cost.text.includes('$0.05'));
            const model = await t.get('/ai/models/openai%2Fgpt-4o');
            assert.strictEqual(model.status, 200);
            assert.ok(model.text.includes('design.page'));
            assert.ok(model.text.includes('1043') && model.text.includes('1005–1081'));
        });

        await check('invalid kinds and models do not call Bench', async () => {
            const before = calls.length;
            assert.strictEqual((await t.get('/ai/bad!kind')).status, 404);
            assert.strictEqual((await t.get('/ai/models/bad!model')).status, 404);
            assert.strictEqual(calls.length, before);
        });

        await check('sitemap includes AI index and every kind', async () => {
            const r = await t.get('/sitemap.xml');
            assert.strictEqual(r.status, 200);
            assert.ok(r.text.includes('<loc>https://openvibe.report/ai</loc>'));
            assert.ok(r.text.includes('<loc>https://openvibe.report/ai/design.page</loc>'));
        });

    await check('the comparison pages remain rendered during a Bench outage', async () => {
            down = true;
            time += 60_001;
            for (const path of ['/ai', '/ai/design.page', '/ai/design.page?tab=pareto', '/ai/models/openai%2Fgpt-4o']) {
                const r = await t.get(path);
                assert.strictEqual(r.status, 200, path);
            }
        });
    } finally { await t.close(); }

    await check('the comparison hub replaces the old AI landing page', async () => {
        const fresh = await boot({
            fetchImpl: async (url, opts) => {
                const u = new URL(String(url));
                if (u.port !== '5230') return source(url, opts);
                if (u.pathname === '/api/v1/kinds') return jsonResponse({ count: 2, kinds: [{ id: 'design.page', room: 'design', name: 'Page', judge: 'human_pairwise' }, { id: 'speech.asr', room: 'speech', name: 'Speech', judge: 'automatic_grader' }] });
                if ((/^\/api\/v1\/(boards|ratings)\//.test(u.pathname))) return jsonResponse({ board: { rows: [] } });
                return jsonResponse({}, 404);
            },
            env: { OV_BENCH_INTERNAL_URL: 'http://127.0.0.1:5230' },
        });
        try {
            const r = await fresh.get('/ai');
            assert.ok(r.text.includes('AI model leaderboard') && r.text.includes('Best overall') && r.text.includes('FAQPage'), 'new hub and structured data render');
            assert.ok(!r.text.includes('No model is rated on a task kind yet'), 'old landing page copy is gone');
            const b = await fresh.get('/ai/design.page');
            assert.ok(b.text.includes('No votes yet') && b.text.includes('href="https://openvibe.design/"') && b.text.includes('Vote on Design'), 'a blind-vote job sends people to vote');
            assert.ok(!b.text.includes('class="ovk-tabs'), 'an empty board has no tabs');
            const g = await fresh.get('/ai/speech.asr');
            assert.ok(g.text.includes('No results yet') && !g.text.includes('Vote on'), 'a graded job has nothing to vote on');
        } finally { await fresh.close(); }
    });

    await check('an unjudged model does not become a rated leader', async () => {
        const unplayed = await boot({
            fetchImpl: async (url, opts) => {
                const u = new URL(String(url));
                if (u.port !== '5230') return source(url, opts);
                if (u.pathname === '/api/v1/kinds') return jsonResponse({ count: 1, kinds: [{ id: 'design.page', room: 'design', name: 'Page', judge: 'human_pairwise' }] });
                if ((/^\/api\/v1\/(boards|ratings)\//.test(u.pathname))) return jsonResponse({ board: { rows: [{ subject: 'gpt-5-nano-2025-08-07', elo: 1000, games: 0, provisional: true }] } });
                return jsonResponse({}, 404);
            },
            env: { OV_BENCH_INTERNAL_URL: 'http://127.0.0.1:5230' },
        });
        try {
            const r = await unplayed.get('/ai');
            assert.ok(r.text.includes('AI model leaderboard') && r.text.includes('Best overall'), 'hub remains available without a rating');
            const b = await unplayed.get('/ai/design.page');
            assert.ok(b.text.includes('No votes yet') && b.text.includes('Vote on Design') && !b.text.includes('class="ovk-tabs'), 'the board asks for votes');
        } finally { await unplayed.close(); }
    });

    await check('an initial Bench outage still renders an AI page', async () => {
        const empty = await boot({ fetchImpl: async (url, opts) => String(url).includes(':5230') ? Promise.reject(new Error('offline')) : source(url, opts), env: { OV_BENCH_INTERNAL_URL: 'http://127.0.0.1:5230' } });
        try {
            const r = await empty.get('/ai');
            assert.strictEqual(r.status, 200);
            assert.ok(r.text.includes('AI model leaderboard') && r.text.includes('Leaderboard'));
        } finally { await empty.close(); }
    });

    await check('comparison pages show fixture measurements, filter parameters and canonical model pairs', async () => {
        const fixture = await boot({
            aiCatalogue: { catalog: async () => ({ generated_at: '2026-11-09T00:00:00Z', models: [{ slug: 'maker/model-a', maker: 'Maker A', weights: 'open', status: 'current', offers: [{ provider: 'Provider One', price: { in: 1, out: 0.5 }, speed: { p50_ms: 120 }, uptime: 0.99, status: 'down', status_reason: 'the provider says the account is out of credit', status_since: '2026-11-09T09:00:00Z' }] }, { slug: 'maker/model-b', maker: 'Maker B', weights: 'closed', status: 'current', offers: [] }] }) },
            fetchImpl: async (url, opts) => {
                const u = new URL(String(url));
                if (u.port === '5230' && u.pathname === '/api/v1/kinds') return jsonResponse({ kinds: [{ id: 'code', name: 'Code' }] });
                if (u.port === '5230' && u.pathname === '/api/v1/ratings/code') return jsonResponse({ board: { rows: [{ subject: 'maker/model-a', elo: 1250, ci_lower: 1200, ci_upper: 1300, games: 40 }, { subject: 'maker/model-b', elo: 1270, ci_lower: 1250, ci_upper: 1300, games: 20 }] } });
                if (u.port === '5230' && u.pathname.includes('/summary')) return jsonResponse({ model: 'maker/model-a', runs: 4 });
                return source(url, opts);
            }, env: { OV_BENCH_INTERNAL_URL: 'http://127.0.0.1:5230' },
        });
        try {
            const hub = await fixture.get('/ai');
            assert.ok(hub.text.includes('AI model leaderboard — November 2026'));
            assert.ok(hub.text.includes('± 50') && hub.text.includes('40 games') && hub.text.includes('1–2') && hub.text.includes('Dataset') && hub.text.includes('FAQPage'));
            assert.ok(hub.text.includes('Maker A') && !hub.text.includes('letter-avatar'));
            const filtered = await fixture.get('/ai/leaderboard?maker=Maker%20A&weights=open&price=low&status=current&kind=code');
            assert.ok(filtered.text.includes('maker/model-a') && !filtered.text.includes('maker/model-b'));
            const provider = await fixture.get('/ai/providers');
            assert.ok(provider.text.includes('Provider One') && provider.text.includes('Not measured yet'), 'an offer without requests has no measurement');
            assert.ok(provider.text.includes('Down') && provider.text.includes('the provider says the account is out of credit') && provider.text.includes('since 2026-11-09 09:00 UTC'), 'the measured status and its reason are shown');
            assert.strictEqual((await fixture.get('/ai/compare?models=maker%2Fmodel-a,maker%2Fmodel-b')).status, 301);
            assert.strictEqual((await fixture.get('/ai/compare/maker%2Fmodel-a-vs-maker%2Fmodel-b')).status, 200);
            assert.strictEqual((await fixture.get('/ai/compare/maker%2Fmodel-b-vs-maker%2Fmodel-a')).status, 301);
        } finally { await fixture.close(); }
    });

    done();
})().catch((e) => { console.error(e); process.exit(1); });
