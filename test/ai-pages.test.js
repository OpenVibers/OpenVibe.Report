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
        if (u.pathname === '/api/v1/boards/design.page') {
            const type = u.searchParams.get('type');
            const rows = {
                elo: [
                    { subject: 'openai/gpt-4o', elo: 1043, ci_lower: 1005, ci_upper: 1081, games: 8, win_rate: 0.75, provisional: true },
                    { subject: 'model-b', elo: 980, ci_lower: 940, ci_upper: 1020, games: 8, win_rate: 0.25, provisional: true },
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
        if (u.pathname === '/api/v1/models/openai%2Fgpt-4o') return jsonResponse({ model: 'openai/gpt-4o', ratings: [{ kind_id: 'design.page', elo: 1043, ci_lower: 1005, ci_upper: 1081, games: 8, win_rate: 0.75 }], entries: [{ kind_id: 'design.page' }], total_cost_usd: 0.8 });
        return jsonResponse({}, 404);
    };
    const t = await boot({ fetchImpl, now: () => time, env: { OV_BENCH_INTERNAL_URL: 'http://127.0.0.1:5230' } });
    try {
        await check('/ai groups kinds and links to all boards', async () => {
            const r = await t.get('/ai');
            assert.strictEqual(r.status, 200);
            for (const s of ['Design', 'Page &lt;design&gt;', 'openai/gpt-4o', '8 games', '/ai/design.page?tab=pareto', '/ai/design.page?tab=cost']) assert.ok(r.text.includes(s), s);
            assert.ok(!r.text.includes('Page <design>'));
        });

        await check('Elo shows ranks, intervals, win rates and provisional state', async () => {
            const r = await t.get('/ai/design.page');
            assert.strictEqual(r.status, 200);
            for (const s of ['1043 ± 38', '75%', 'provisional', 'Rank', '95% interval', 'dataset JSONL']) assert.ok(r.text.includes(s), s);
        });

        await check('Pareto has an inline SVG, frontier labels and an exact-value table', async () => {
            const r = await t.get('/ai/design.page?tab=pareto');
            assert.strictEqual(r.status, 200);
            for (const s of ['<svg', 'Quality against cost per solved task', 'Cost per solved task (USD', 'Frontier', 'model-b', 'dataset JSONL', '<table']) assert.ok(r.text.includes(s), s);
        });

        await check('cost and model views quote Bench numbers', async () => {
            const cost = await t.get('/ai/design.page?tab=cost');
            assert.strictEqual(cost.status, 200);
            assert.ok(cost.text.includes('Cost per solved'));
            assert.ok(cost.text.includes('$0.05'));
            const model = await t.get('/ai/models/openai%2Fgpt-4o');
            assert.strictEqual(model.status, 200);
            assert.ok(model.text.includes('design.page'));
            assert.ok(model.text.includes('1043 ± 38'));
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

        await check('a Bench outage serves the last good pages with the read time', async () => {
            down = true;
            time += 60_001;
            for (const path of ['/ai', '/ai/design.page', '/ai/design.page?tab=pareto', '/ai/models/openai%2Fgpt-4o']) {
                const r = await t.get(path);
                assert.strictEqual(r.status, 200, path);
                assert.ok(r.text.includes('Showing the last good copy, read Oct 28, 12:00 UTC'), path);
            }
        });
    } finally { await t.close(); }

    await check('an initial Bench outage still renders an AI page', async () => {
        const empty = await boot({ fetchImpl: async (url, opts) => String(url).includes(':5230') ? Promise.reject(new Error('offline')) : source(url, opts), env: { OV_BENCH_INTERNAL_URL: 'http://127.0.0.1:5230' } });
        try {
            const r = await empty.get('/ai');
            assert.strictEqual(r.status, 200);
            assert.ok(r.text.includes('temporarily unavailable'));
        } finally { await empty.close(); }
    });

    done();
})().catch((e) => { console.error(e); process.exit(1); });
