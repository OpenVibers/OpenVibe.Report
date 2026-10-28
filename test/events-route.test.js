'use strict';

/**
 * POST /internal/events is loopback-only and verifies the OpenVibe.Events v2 signature. A signed delivery is
 * ingested once; a replay returns duplicate and writes nothing; a forged signature is refused.
 */
const assert = require('assert');
const { signDeliveryV2 } = require('openvibe-sdk/events');
const { boot, check, done } = require('./helpers/boot');
const { streams, NOW } = require('./fixtures/analytics');

const SECRET = 'test-report-events-secret-32-characters-long';

(async () => {
    const t = await boot({ db: true, now: () => NOW, env: { REPORT_EVENTS_SECRET: SECRET } });
    try {
        const raw = JSON.stringify({ event: streams[0] });
        const ts = Math.floor(NOW / 1000);
        const headers = {
            'content-type': 'application/json',
            'x-openvibe-timestamp': String(ts),
            'x-openvibe-signature-v2': signDeliveryV2(raw, SECRET, ts),
        };

        await check('a signed live.stream.ended is ingested once, and a replay is a duplicate', async () => {
            const first = await t.get('/internal/events', { method: 'POST', headers, body: raw });
            assert.strictEqual(first.status, 200, first.text);
            assert.strictEqual(first.json().ok, true);
            assert.strictEqual(first.json().duplicate, false);
            assert.strictEqual(await t.ctx.store.db.value('SELECT COUNT(*)::int AS n FROM report_streams'), 1);
            const again = await t.get('/internal/events', { method: 'POST', headers, body: raw });
            assert.strictEqual(again.status, 200, again.text);
            assert.strictEqual(again.json().duplicate, true);
            assert.strictEqual(await t.ctx.store.db.value('SELECT COUNT(*)::int AS n FROM report_streams'), 1);
        });

        await check('a forged signature is refused before any write', async () => {
            const bad = { ...headers, 'x-openvibe-signature-v2': signDeliveryV2(raw, 'another-secret-32-characters-long!!', ts) };
            const r = await t.get('/internal/events', { method: 'POST', headers: bad, body: raw });
            assert.strictEqual(r.status, 401);
            assert.strictEqual(r.json().code, 'report.bad_signature');
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
