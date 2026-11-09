'use strict';
const assert = require('assert');
const { boot, check } = require('./helpers/boot');

(async () => {
    const bench = {
        kinds: async () => ({ at: '2026-11-08T00:00:00.000Z', data: { kinds: [{ id: 'chat.arena' }] } }),
        board: async () => ({ at: '2026-11-08T00:00:00.000Z', data: { board: { kind_id: 'chat.arena', rows: [{ subject: 'm/a', elo: 1200, ci_lower: 1180, ci_upper: 1220, games: 40 }, { subject: 'vendor/new', elo: null, games: 0 }] } } }),
        modelDetail: async (id) => id === 'm/a' ? ({ at: '2026-11-08T00:00:00.000Z', data: { model: id, runs: 40 } }) : null,
    };
    const aiCatalogue = { catalog: async () => ({ generated_at: '2026-11-08T00:00:00.000Z', models: [{ slug: 'm/a', uncensored: true, offers: [{ provider: 'p', free_tier: true, price: { out: 0 }, requests_7d: 40, speed: { p50_ms: 90 }, uptime: 1 }] }] }) };
    const t = await boot({ bench, aiCatalogue });
    try {
        await check('AI comparison endpoints use public source stand-ins and CORS without credentials', async () => {
            for (const path of ['/api/v1/ai/leaderboard?kind=chat.arena', '/api/v1/ai/models/m%2Fa', '/api/v1/ai/providers', '/api/v1/ai/compare?models=m%2Fa', '/api/v1/ai/picks']) {
                const response = await t.get(path);
                assert.strictEqual(response.status, 200, path);
                assert.match(response.headers.get('access-control-allow-origin') || '', /^\*$/);
                assert.strictEqual(response.headers.get('access-control-allow-credentials'), null);
                assert.match(response.headers.get('cache-control') || '', /max-age=120/);
                assert.match(response.headers.get('content-type') || '', /^application\/json/);
            }
            const result = await t.get('/api/v1/ai/leaderboard?uncensored=true');
            assert.strictEqual(result.json().rows.length, 1);
            assert.deepStrictEqual(result.json().rows[0].rank, { min: 1, max: 1, position: 1, source: 'OpenVibe.Bench', date: '2026-11-08T00:00:00.000Z', sample_size: 40 });
            const filtered = await t.get('/api/v1/ai/leaderboard?maker=m&price=free&kind=chat.arena');
            assert.strictEqual(filtered.json().rows.length, 1);
            const notEnough = await t.get('/api/v1/ai/leaderboard?maker=vendor');
            assert.strictEqual(notEnough.json().rows[0].rating.value, null);
            assert.match(notEnough.json().rows[0].rating.reason, /no rating/i);
            const picks = await t.get('/api/v1/ai/picks');
            assert.match(picks.json().picks.find((x) => x.id === 'open').why, /not enough source data/i);
            assert.strictEqual((await t.get('/api/v1/ai/leaderboard?limit=1&cursor=1')).json().rows.length, 1);
        });
    } finally { await t.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
