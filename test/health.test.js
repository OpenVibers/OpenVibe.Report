'use strict';

/**
 * The plumbing: health, truthful readiness (both sources optional, so a dead source is degraded and still 200, never
 * 503), release metadata, and the content-addressed static assets.
 */
const assert = require('assert');
const { assetVersion } = require('../server/assets');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const healthy = await boot();
    try {
        await check('GET /api/health: ok, the service id and the version', async () => {
            const r = await healthy.get('/api/health');
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.headers.get('cache-control'), 'no-store');
            assert.deepStrictEqual(r.json(), { status: 'ok', service: 'openvibe-report', version: '0.1.0' });
        });

        await check('GET /api/ready: both sources answer → ready, no database check', async () => {
            const r = await healthy.get('/api/ready');
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.headers.get('cache-control'), 'no-store');
            const body = r.json();
            assert.strictEqual(body.ready, true);
            assert.strictEqual(body.status, 'ready');
            assert.strictEqual(body.service, 'report');
            assert.deepStrictEqual(body.degraded, []);
            assert.strictEqual(body.checks.network.status, 'ok');
            assert.strictEqual(body.checks.live.status, 'ok');
            assert.ok(!('db' in body.checks), 'Report has no database');
        });

        await check('GET /release.json: service report, versioned like every OpenVibe site', async () => {
            const r = await healthy.get('/release.json');
            assert.strictEqual(r.status, 200);
            assert.match(r.headers.get('content-type') || '', /^application\/json/);
            const body = r.json();
            assert.strictEqual(body.service, 'report');
            assert.strictEqual(body.release, '0000000');
            assert.ok(body.packages && body.packages['openvibe-shared'], 'no openvibe-shared version');
        });

        await check('static css and js: public, immutable only with the matching ?v=', async () => {
            for (const rel of ['css/app.css', 'js/app.js']) {
                const plain = await healthy.get(`/${rel}`);
                assert.strictEqual(plain.status, 200);
                assert.strictEqual(plain.headers.get('cache-control'), 'public, max-age=300, stale-while-revalidate=86400');
                const pinned = await healthy.get(`/${rel}?v=${assetVersion(rel)}`);
                assert.strictEqual(pinned.status, 200);
                assert.strictEqual(pinned.headers.get('cache-control'), 'public, max-age=31536000, immutable');
            }
        });
    } finally { await healthy.close(); }

    await check('GET /api/ready: a source that does not answer is degraded, not 503', async () => {
        const down = await boot({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
        try {
            const r = await down.get('/api/ready');
            assert.strictEqual(r.status, 200, 'a dead optional source must not make the service not_ready');
            const body = r.json();
            assert.strictEqual(body.ready, true);
            assert.strictEqual(body.status, 'degraded');
            assert.deepStrictEqual(body.failed, []);
            assert.deepStrictEqual(body.degraded.sort(), ['live', 'network']);
            assert.strictEqual(body.checks.network.status, 'fail');
            assert.strictEqual(body.checks.live.status, 'fail');
        } finally { await down.close(); }
    });

    await check('GET /api/ready: one source down is degraded, the other still ok', async () => {
        const partial = await boot({ stub: { health: { network: true, live: false } } });
        try {
            const body = (await partial.get('/api/ready')).json();
            assert.strictEqual(body.ready, true);
            assert.strictEqual(body.status, 'degraded');
            assert.deepStrictEqual(body.degraded, ['live']);
            assert.strictEqual(body.checks.network.status, 'ok');
        } finally { await partial.close(); }
    });

    done();
})().catch((e) => { console.error(e); process.exit(1); });
