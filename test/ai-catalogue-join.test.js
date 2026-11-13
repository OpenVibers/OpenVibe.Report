'use strict';

// Bench names a model as its maker's API does ("gpt-5-nano-2025-08-07"), the Exchange catalogue by maker
// and family ("openai/gpt-5-nano"). The leaderboard joins the two, and lists the catalogue's models that
// have no Bench games yet with their real prices, as not rated.
const assert = require('assert');
const { boot, check, done, stubFetch, jsonResponse } = require('./helpers/boot');

(async () => {
    const source = stubFetch();
    const fetchImpl = async (url, opts) => {
        const u = new URL(String(url));
        if (u.port === '5231' && u.pathname === '/api/v1/exchange/catalog') {
            return jsonResponse({ generated_at: '2026-11-09T19:00:00Z', models: [
                { slug: 'openai/gpt-5-nano', canonical: 'openai/gpt-5-nano', name: 'gpt-5-nano', kind: 'chat', open_weights: false,
                    offers: [{ provider: 'openai', provider_name: 'OpenAI', model: 'gpt-5-nano', price: { in: 0.05, out: 0.4 }, speed: { p50_ms: 900 } }] },
                { slug: 'deepseek/deepseek-chat', canonical: 'deepseek/deepseek-chat', name: 'deepseek-chat', kind: 'chat', open_weights: true,
                    offers: [{ provider: 'deepseek', provider_name: 'DeepSeek', model: 'deepseek-chat', price: { in: 0.28, out: 0.42 } }] },
            ] });
        }
        if (u.port !== '5230') return source(url, opts);
        if (u.pathname === '/api/v1/kinds') return jsonResponse({ count: 1, kinds: [{ id: 'design.dataviz', room: 'design', name: 'Data viz' }] });
        if (u.pathname === '/api/v1/ratings/design.dataviz') {
            return jsonResponse({ board: { kind_id: 'design.dataviz', type: 'elo', rows: [{ subject: 'gpt-5-nano-2025-08-07', elo: 1000, ci_lower: 960, ci_upper: 1040, games: 20 }, { subject: 'model-zero', elo: 1000, games: 0 }] } });
        }
        return jsonResponse({}, 404);
    };
    const t = await boot({ fetchImpl, env: { OV_BENCH_INTERNAL_URL: 'http://127.0.0.1:5230', OV_AI_INTERNAL_URL: 'http://127.0.0.1:5231' } });
    try {
        // The pages moved to OpenVibe.Compare (2026-11-13); the join is checked through the JSON API Compare reads.
        const rowsOf = async () => {
            const r = await t.get('/api/v1/ai/leaderboard?limit=100');
            assert.strictEqual(r.status, 200);
            return r.json().rows;
        };
        const prices = (row) => row.provider_offers.flatMap((o) => (o.price ? [o.price.in, o.price.out] : [])).filter((x) => x != null).map(Number);
        await check('a dated Bench name meets its catalogue model: maker and prices', async () => {
            const row = (await rowsOf()).find((x) => x.id === 'gpt-5-nano-2025-08-07');
            assert.ok(row, 'the rated model');
            assert.ok(prices(row).includes(0.4) && prices(row).includes(0.05), 'its catalogue prices');
            assert.match(String(row.maker), /openai/i, 'its maker');
        });
        await check('a catalogue model without Bench games is listed, not rated', async () => {
            const rows = await rowsOf();
            const ids = rows.map((x) => x.id);
            assert.ok(ids.includes('deepseek/deepseek-chat'), 'the unrated model is listed');
            assert.ok(ids.indexOf('gpt-5-nano-2025-08-07') < ids.indexOf('deepseek/deepseek-chat'), 'rated models come first');
            assert.ok(prices(rows.find((x) => x.id === 'deepseek/deepseek-chat')).includes(0.28), 'with its real price');
        });
        await check('a base rating with no games is not a rating', async () => {
            const zero = (await rowsOf()).find((x) => x.id === 'model-zero');
            assert.strictEqual(zero, undefined, 'a sparse Bench-only subject is withheld, including its count');
        });
        await check('the AI pages answer 301 to OpenVibe.Compare with their path and query', async () => {
            const r = await t.get('/ai/providers?x=1', { redirect: 'manual' });
            assert.strictEqual(r.status, 301);
            assert.strictEqual(r.headers.get('location'), 'https://openvibe.compare/ai/providers?x=1');
        });
    } finally {
        await t.close();
    }
    done();
})().catch((error) => { console.error(error); process.exitCode = 1; });
