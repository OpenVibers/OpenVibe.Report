'use strict';
// /searches (plan 2026-11-13 §AD.13 (1)): what people search for across OpenVibe, from OpenVibe.Search's counts: the
// totals, searches a day, what is trending now (rising marked), by site, and how it is counted; a query is escaped;
// Search not answering says so, never a 500.
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const data = {
        days: 7,
        by_day: [{ day: '2026-11-14', searches: 120 }, { day: '2026-11-15', searches: 340 }],
        by_site: [{ site: 'openvibe.exchange', searches: 300 }, { site: 'openvibe.live', searches: 160 }],
        top: [{ query: 'synthesizers', searches: 42, rising: true }, { query: '<b>drum</b> machines', searches: 9, rising: false }],
    };
    const t = await boot({ searchTrends: { stats: async (d) => ({ ...data, days: d }) } });
    const down = await boot({ searchTrends: { stats: async () => null } });
    try {
        await check('the page: totals, a day, trending now, by site, how it is counted', async () => {
            const r = await t.get('/searches');
            assert.strictEqual(r.status, 200);
            const want = ['What people search for', '460', 'Searches a day', 'Trending now', 'synthesizers', 'rising', 'openvibe.exchange', 'How these are counted', 'Do Not Track'];
            assert.deepStrictEqual(want.filter((s) => !r.text.includes(s)), [], 'every part is there');
            assert.ok(!r.text.includes('<b>drum</b>') && r.text.includes('&lt;b&gt;drum&lt;/b&gt; machines'), 'a query is escaped');
            assert.ok(r.text.includes('href="/searches"'), 'in the navigation');
        });
        await check('Search not answering: the page says so', async () => {
            const r = await down.get('/searches');
            assert.strictEqual(r.status, 200);
            assert.ok(r.text.includes('not answering'));
        });
        await check('the source: Search\'s stats, days kept to 1..7, kept five minutes', async () => {
            const { createSearchTrendsClient } = require('../server/data/search-trends');
            const asked = [];
            const c = createSearchTrendsClient({ config: { searchUrl: 'http://search.test' }, log: { warn() {}, error() {} }, fetchImpl: async (url) => { asked.push(url); return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } }); } });
            assert.strictEqual((await c.stats(30)).top.length, 2);
            await c.stats(30);
            assert.deepStrictEqual(asked, ['http://search.test/api/v1/trending/stats?days=7'], 'once, with days capped at 7');
        });
    } finally { await t.close(); await down.close(); }
    await done();
})();
