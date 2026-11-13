'use strict';
/**
 * The AI model comparison moved to OpenVibe.Compare on 2026-11-13 (the owner: "This kinda shit is supposed to be a part
 * of openvibe.compare"). Every /ai page answers 301 there with its path and query; the Arena's rounds and votes and the
 * staff page /ai/exchange stay; the bar has no AI tab; the sitemap lists no /ai page; the JSON API Compare reads stays.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    try {
        await check('every /ai page answers 301 to the same path on OpenVibe.Compare', async () => {
            for (const path of ['/ai', '/ai/leaderboard?kind=chat.arena', '/ai/providers', '/ai/models/openai%2Fgpt-5-nano', '/ai/compare/a-vs-b',
                '/ai/compare?a=x&b=y', '/ai/method', '/ai/feed.xml', '/ai/chat.arena', '/ai/bmk_abc']) {
                const r = await t.get(path);
                assert.strictEqual(r.status, 301, path);
                assert.strictEqual(r.headers.get('location'), `https://openvibe.compare${path}`, path);
            }
        });
        await check('the Arena goes to Compare in one hop; the staff page stays on Report', async () => {
            const arena = await t.get('/ai/arena');
            assert.strictEqual(arena.status, 301, 'the Arena moved (11-13)');
            assert.strictEqual(arena.headers.get('location'), 'https://openvibe.compare/arena', 'straight to /arena, not /ai/arena');
            const staff = await t.get('/ai/exchange');
            assert.notStrictEqual(staff.status, 301, 'the staff page is not moved');
        });
        await check('no AI tab, no /ai page in the sitemap, the JSON API stays', async () => {
            const home = await t.get('/');
            assert.ok(!/href="\/ai"/.test(home.text), 'the bar has no AI tab');
            const map = await t.get('/sitemap.xml');
            assert.ok(!/openvibe\.report\/ai[/<]/.test(map.text), 'no /ai page in the sitemap');
            const llms = await t.get('/llms.txt');
            assert.match(llms.text, /https:\/\/openvibe\.compare\/ai/, 'llms.txt names where the comparison lives');
            const api = await t.get('/api/v1/ai/picks');
            assert.notStrictEqual(api.status, 301, 'the API is not moved');
        });
    } finally {
        await t.close();
    }
    done();
})().catch((error) => { console.error(error); process.exitCode = 1; });
