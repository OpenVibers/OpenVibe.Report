'use strict';
const assert = require('assert');
const { createAiCatalogue } = require('../server/data/ai-catalogue');
(async () => {
    let now = 1000; let calls = 0;
    const client = createAiCatalogue({ config: { aiUrl: 'https://ai.test/' }, now: () => now, fetchImpl: async (url) => {
        calls += 1; assert.strictEqual(url, 'https://ai.test/api/v1/exchange/catalog');
        return new Response(JSON.stringify({ models: [{ slug: 'vendor/model', offers: [] }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    } });
    const first = await client.catalog();
    await client.catalog();
    assert.strictEqual(first.models[0].slug, 'vendor/model');
    assert.strictEqual(calls, 1, 'second read uses the 2-minute cache');
    now += 120_001;
    await client.catalog();
    assert.strictEqual(calls, 2, 'expired catalogue refreshes');
    console.log('AI catalogue source tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
