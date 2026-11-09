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
        if (u.pathname === '/api/v1/boards/design.dataviz') {
            if (u.searchParams.get('type') !== 'elo') return jsonResponse({ board: { kind_id: 'design.dataviz', rows: [] } });
            return jsonResponse({ board: { kind_id: 'design.dataviz', type: 'elo', rows: [{ subject: 'gpt-5-nano-2025-08-07', elo: 1000, ci_lower: 960, ci_upper: 1040, games: 4 }] } });
        }
        return jsonResponse({}, 404);
    };
    const t = await boot({ fetchImpl, env: { OV_BENCH_INTERNAL_URL: 'http://127.0.0.1:5230', OV_AI_INTERNAL_URL: 'http://127.0.0.1:5231' } });
    try {
        await check('a dated Bench name meets its catalogue model: maker and prices', async () => {
            const r = await t.get('/ai/leaderboard');
            assert.strictEqual(r.status, 200);
            const row = r.text.slice(r.text.indexOf('gpt-5-nano-2025-08-07'));
            assert.ok(r.text.includes('gpt-5-nano-2025-08-07'), 'the rated model');
            assert.ok(row.includes('$0.05') && row.includes('$0.4'), 'its catalogue prices');
            assert.ok(r.text.includes('>openai<'), 'its maker from the catalogue slug');
        });
        await check('a catalogue model without Bench games is listed, not rated', async () => {
            const r = await t.get('/ai/leaderboard');
            assert.ok(r.text.includes('deepseek/deepseek-chat'), 'the unrated model is listed');
            assert.ok(r.text.indexOf('gpt-5-nano-2025-08-07') < r.text.indexOf('deepseek/deepseek-chat'), 'rated models come first');
            assert.ok(r.text.includes('$0.28'), 'with its real price');
        });
        await check('the providers page lists every offer', async () => {
            const r = await t.get('/ai/providers');
            assert.ok(r.text.includes('OpenAI') && r.text.includes('DeepSeek'), 'both providers');
        });
    } finally {
        await t.close();
    }
    done();
})().catch((error) => { console.error(error); process.exitCode = 1; });
