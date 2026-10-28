'use strict';

/**
 * The JSON API: every route answers the source's document as it came, CORS-open and public for two minutes; a bad
 * parameter or a missing source is a 404 problem+json without a source call; the per-address limit answers 429.
 */
const assert = require('assert');
const { boot, check, done, defaults } = require('./helpers/boot');

(async () => {
    const t = await boot();
    try {
        await check('every API route answers the source JSON with CORS and the two-minute cache', async () => {
            const d = defaults();
            const routes = [
                ['/api/v1/stats?days=30', d.stats],
                ['/api/v1/rundown', d.rundown],
                ['/api/v1/rundown/topics', d.topics],
                ['/api/v1/rundown/t/seattle', d.topic],
                ['/api/v1/after-show/7', d.recap],
                ['/api/v1/c/goosely', d.channel],
            ];
            for (const [path, expected] of routes) {
                const r = await t.get(path);
                assert.strictEqual(r.status, 200, path);
                assert.match(r.headers.get('content-type') || '', /^application\/json/);
                assert.strictEqual(r.headers.get('access-control-allow-origin'), '*');
                assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=120');
                assert.deepStrictEqual(r.json(), expected, path);
            }
        });

        await check('a bad parameter or an unknown route is a 404 problem+json, still CORS-open', async () => {
            const before = t.fetchImpl.calls.length;
            for (const path of ['/api/v1/rundown/t/Not_A_Slug', '/api/v1/after-show/0', '/api/v1/c/bad-name', '/api/v1/nope']) {
                const r = await t.get(path);
                assert.strictEqual(r.status, 404, path);
                assert.match(r.headers.get('content-type') || '', /^application\/problem\+json/);
                assert.strictEqual(r.headers.get('access-control-allow-origin'), '*');
                const body = r.json();
                assert.strictEqual(body.status, 404);
                assert.ok(body.code, 'no problem code');
                assert.ok(body.type, 'no problem type');
            }
            const outside = await t.get('/api/nope');
            assert.strictEqual(outside.status, 404);
            assert.match(outside.headers.get('content-type') || '', /^application\/problem\+json/);
            assert.strictEqual(t.fetchImpl.calls.length, before, 'a bad parameter reached the source');
        });

        await check('the API is read-only', async () => {
            const r = await t.get('/api/v1/stats', { method: 'POST' });
            assert.strictEqual(r.status, 405);
            assert.match(r.headers.get('content-type') || '', /^application\/problem\+json/);
            assert.strictEqual(r.headers.get('allow'), 'GET, HEAD');
        });

        await check('a source that answers nothing is a 404 problem+json', async () => {
            const empty = await boot({ data: { stats: null, recap: null } });
            try {
                for (const path of ['/api/v1/stats', '/api/v1/after-show/7']) {
                    const r = await empty.get(path);
                    assert.strictEqual(r.status, 404, path);
                    assert.match(r.headers.get('content-type') || '', /^application\/problem\+json/);
                }
            } finally { await empty.close(); }
        });
    } finally {
        await t.close();
    }

    await check('120 (or the configured number of) requests a minute per address, then a 429 problem', async () => {
        const limited = await boot({ env: { REPORT_API_RATE_LIMIT_PER_MIN: '2' } });
        try {
            assert.strictEqual((await limited.get('/api/v1/rundown/topics')).status, 200);
            assert.strictEqual((await limited.get('/api/v1/rundown/topics')).status, 200);
            const third = await limited.get('/api/v1/rundown/topics');
            assert.strictEqual(third.status, 429);
            assert.match(third.headers.get('content-type') || '', /^application\/problem\+json/);
            assert.strictEqual(third.json().code, 'rate_limited');
            assert.strictEqual(third.headers.get('access-control-allow-origin'), '*');
        } finally { await limited.close(); }
    });

    done();
})().catch((e) => { console.error(e); process.exit(1); });
