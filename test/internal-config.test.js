'use strict';
/**
 * D11 owner settings: the report.ai_exchange namespace and /internal/config.
 * Env pins win; an owner change applies live (the ingest consumer and the staff page); report.config.manage
 * is required; no KEK still works; a secret-class value never leaves a summary, snapshot or history.
 */
const assert = require('assert');
const crypto = require('crypto');
const { serviceAuth } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');

const ISSUER = 'https://openvibe.network';
const OWNER = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const SECRET = 'sk_report_d11_toppsecret_123456';
const CAP = ['report.config.manage', 'report.ai_usage.read'];
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const now = Math.floor(Date.now() / 1000);
const token = () => serviceAuth.signServiceToken({
    iss: ISSUER, sub: 'svc:network', actor_type: 'service', aud: ['openvibe.report'], cap: CAP,
    iat: now, exp: now + 300, jti: 'tok_report_config',
}, privateKey);
const bearer = () => ({ authorization: 'Bearer ' + token() });

(async () => {
    const t = await boot({ db: true, env: { REPORT_AI_EXCHANGE: '1', OV_NETWORK_PUBLIC_KEY: publicKey } });
    try {
        await check('the summary: schema, the env pin, sealed:false without a KEK', async () => {
            const r = await t.get('/internal/config/report.ai_exchange', { headers: bearer() });
            assert.strictEqual(r.status, 200, r.text.slice(0, 300));
            assert.strictEqual(r.json().namespace, 'report.ai_exchange');
            assert.strictEqual(r.json().sealed, false);
            assert.strictEqual(r.json().values.enabled, true);
            assert.deepStrictEqual(r.json().pins.enabled, { env: 'REPORT_AI_EXCHANGE', pinned: true });
            assert.ok(!r.text.includes(SECRET));
        });

        await check('a service token without report.config.manage is refused', async () => {
            const wrong = serviceAuth.signServiceToken({
                iss: ISSUER, sub: 'svc:operator', actor_type: 'service', aud: ['openvibe.report'], cap: ['report.ai_usage.read'],
                iat: now, exp: now + 300, jti: 'tok_report_wrong',
            }, privateKey);
            const r = await t.get('/internal/config/report.ai_exchange', { headers: { authorization: 'Bearer ' + wrong } });
            assert.strictEqual(r.status, 403);
            assert.strictEqual(r.json().code, 'capability.denied');
        });

        await check('an env-pinned key is read-only', async () => {
            const r = await t.get('/internal/config/report.ai_exchange', {
                method: 'POST', headers: { ...bearer(), 'x-ov-subject': OWNER }, json: { values: { enabled: false }, reason: 'off' },
            });
            assert.strictEqual(r.status, 409, r.text.slice(0, 300));
            assert.strictEqual(r.json().code, 'config.pinned_in_env');
        });
    } finally { await t.close(); }

    const live = await boot({ db: true, env: { OV_NETWORK_PUBLIC_KEY: publicKey } });
    try {
        await check('an owner change applies live: the staff page and the JSON API open', async () => {
            assert.strictEqual((await live.get('/api/v1/ai/exchange?from=2026-11-04&to=2026-11-05', { headers: bearer() })).status, 404);
            const r = await live.get('/internal/config/report.ai_exchange', {
                method: 'POST', headers: { ...bearer(), 'x-ov-subject': OWNER }, json: { values: { enabled: true }, reason: 'owner turned it on' },
            });
            assert.strictEqual(r.status, 200, r.text.slice(0, 300));
            assert.strictEqual(r.json().revision, 2);
            assert.strictEqual(live.config.aiExchange.enabled, true);
            const got = await live.get('/api/v1/ai/exchange?from=2026-11-04&to=2026-11-05', { headers: bearer() });
            assert.strictEqual(got.status, 200, got.text.slice(0, 300));
            assert.ok(live.logs().includes('by user:' + OWNER));
            assert.ok(!live.logs().includes(SECRET));
        });

        await check('with a KEK the store is sealed and boot reseals', async () => {
            const sealed = await boot({ db: true, env: { OV_NETWORK_PUBLIC_KEY: publicKey, OV_CONFIG_KEKS: 'k1:MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=', OV_CONFIG_KEK_CURRENT: 'k1' } });
            try {
                const r = await sealed.get('/internal/config/report.ai_exchange', { headers: bearer() });
                assert.strictEqual(r.status, 200, r.text.slice(0, 300));
                assert.strictEqual(r.json().sealed, true);
                assert.strictEqual(r.json().kek, 'k1');
            } finally { await sealed.close(); }
        });

        await check('a secret is write-only and never appears in a summary, snapshot or history', async () => {
            const shared = require('openvibe-shared/config');
            const extra = await shared.createConfigStore({
                db: live.ctx.store.db, service: 'report', namespace: 'report.test_secrets',
                schema: { type: 'object', additionalProperties: false, properties: { api_key: { type: 'string' } } },
                classify: () => 'secret',
            });
            const marker = await extra.setSecret('api_key', SECRET, { actor: { type: 'user', id: OWNER }, reason: 'test' });
            assert.strictEqual(marker.redacted, true);
            assert.ok(!JSON.stringify(marker).includes(SECRET));
            const summary = await extra.summary();
            assert.strictEqual(summary.values.api_key.redacted, true);
            assert.ok(!JSON.stringify(summary).includes(SECRET));
            assert.ok(!JSON.stringify(await extra.history()).includes(SECRET));
            assert.ok(!JSON.stringify(await extra.snapshot(1)).includes(SECRET));
        });
    } finally { await live.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
