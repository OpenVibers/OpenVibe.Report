'use strict';
/**
 * The AI meter in Report (plan L40 and L41): the consumer of ai.call.recorded, the ledger, the roll-up job and the
 * three routes.
 */
const assert = require('assert');
const crypto = require('crypto');
const { signDeliveryV2 } = require('openvibe-sdk/events');
const { serviceAuth } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');
const { createAiUsageJobs } = require('../server/jobs/ai-usage');

const SECRET = 'test-report-events-secret-32-characters-long';
const ISSUER = 'https://openvibe.network';
const NOW = Date.parse('2026-10-31T12:00:00.000Z');
const SUBJECT = 'usr_01J0000000000000000000000A';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
});

/** A service token for the operator route. */
function token(cap) {
    const now = Math.floor(NOW / 1000);   // the app's own clock: the token is minted for it
    return serviceAuth.signServiceToken({
        iss: ISSUER, sub: 'svc:operator', actor_type: 'service', aud: ['openvibe.report'], cap, ns: ['*'],
        iat: now, exp: now + 300, jti: 'tok_aiusage_' + String(now).slice(-6),
    }, privateKey);
}

/** One ai.call.recorded event (the shape OpenVibe.AI publishes). */
function usageEvent(over = {}) {
    return {
        event_id: 'evt_AIUSAGE001',
        event_type: 'ai.call.recorded',
        source: 'ai',
        occurred_at: '2026-10-31T10:00:00.000Z',
        payload: {
            subject: SUBJECT, attribution: 'site:design', surface: 'ai.generate', system: 'ai',
            provider: 'anthropic', model: 'claude-sonnet-4-5', effort: null,
            paid_by: 'own_key', paid_by_detail: 'anthropic ...a1b2',
            input: 200, output: 80, reasoning: 0, cache_read: 800, cache_write: 0, cache_write_ttl: null,
            images: 0, audio_seconds: 0, video_seconds: 0,
            list_cost_usd: 0.0021, charged_usd: 0, fee_usd: 0, cache_saved_usd: 0.0012,
            price_source: 'models', price_date: '2026-10-31',
            latency_ms: 1200, ttft_ms: 300, attempts: 1, outcome: 'succeeded',
            run_id: 'run_01JAB2C3D4E5F6G7H8J9K0MNPQ', turn_id: null, at: '2026-10-31T10:00:00.000Z',
            ...over,
        },
    };
}

/** A signed delivery, the way OpenVibe.Events sends one. */
function delivery(event) {
    const raw = JSON.stringify({ event });
    const ts = Math.floor(NOW / 1000);
    return { raw, headers: { 'content-type': 'application/json', 'x-openvibe-timestamp': String(ts), 'x-openvibe-signature-v2': signDeliveryV2(raw, SECRET, ts) } };
}

(async () => {
    const t = await boot({ db: true, now: () => NOW, env: { REPORT_EVENTS_SECRET: SECRET, OV_NETWORK_PUBLIC_KEY: publicKey } });
    const db = t.ctx.store.db;
    try {
        await check('a signed ai.call.recorded is stored once, and a replay is a duplicate', async () => {
            const d = delivery(usageEvent());
            const first = await t.get('/internal/events', { method: 'POST', headers: d.headers, body: d.raw });
            assert.strictEqual(first.status, 200, first.text);
            assert.strictEqual(first.json().outcome, 'usage:recorded', first.text);
            assert.strictEqual(await db.value('SELECT COUNT(*)::int AS n FROM report_ai_usage'), 1);
            const again = await t.get('/internal/events', { method: 'POST', headers: d.headers, body: d.raw });
            assert.strictEqual(again.status, 200, again.text);
            assert.strictEqual(again.json().duplicate, true, again.text);
            assert.strictEqual(await db.value('SELECT COUNT(*)::int AS n FROM report_ai_usage'), 1, 'one row');
        });

        await check('the same run under another event id is still one record', async () => {
            const d = delivery(usageEvent({ input: 999 }));
            const other = { ...usageEvent({ input: 999 }), event_id: 'evt_AIUSAGE002' };
            const d2 = delivery(other);
            const r = await t.get('/internal/events', { method: 'POST', headers: d2.headers, body: d2.raw });
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.json().outcome, 'usage:duplicate', 'the run is counted once');
            assert.strictEqual(await db.value('SELECT COUNT(*)::int AS n FROM report_ai_usage'), 1);
        });

        await check('the roll-up job writes the day rows, and the job is off under drill mode', async () => {
            const jobs = createAiUsageJobs({ config: t.config, store: t.ctx.store, now: () => NOW });
            const out = await jobs.runOnce();
            assert.strictEqual(out.days, 1, 'one day rolled up');
            assert.strictEqual(await db.value('SELECT COUNT(*)::int AS n FROM report_ai_usage_days'), 1);
            const again = await jobs.runOnce();
            assert.strictEqual(await db.value('SELECT COUNT(*)::int AS n FROM report_ai_usage_days'), 1, 'the second pass counts nothing twice');
            const drilled = createAiUsageJobs({ config: { ...t.config, drill: true }, store: t.ctx.store, now: () => NOW });
            assert.strictEqual((await drilled.runOnce()).skipped, 'drill', 'a drill never changes the numbers');
        });

        await check('the open route answers the totals and names nobody', async () => {
            const r = await t.get('/api/v1/ai/usage/open');
            assert.strictEqual(r.status, 200, r.text);
            const body = r.json();
            assert.strictEqual(body.calls, 1, 'one call');
            assert.strictEqual(body.tokens.cache_read, 800, 'the cache read is counted');
            assert.strictEqual(body.own_key_calls, 1, 'the own key paid for it');
            assert.ok(body.spend_by_week.length >= 1, 'the spend by week is there');
            const text = JSON.stringify(body);
            for (const leak of ['usr_', 'site:design', 'anthropic', 'a1b2', SUBJECT]) {
                assert.ok(!text.includes(leak), 'the open route names nobody: ' + leak);
            }
        });

        await check('the operator route needs a service token with report.ai_usage.read', async () => {
            const none = await t.get('/api/v1/ai/usage');
            assert.strictEqual(none.status, 401, 'no token');
            const wrong = await t.get('/api/v1/ai/usage', { headers: { authorization: 'Bearer ' + token(['report.other.read']) } });
            assert.strictEqual(wrong.status, 403, 'the wrong capability');
            const ok = await t.get('/api/v1/ai/usage?group=site', { headers: { authorization: 'Bearer ' + token(['report.ai_usage.read']) } });
            assert.strictEqual(ok.status, 200, ok.text);
            const body = ok.json();
            assert.strictEqual(body.group, 'site');
            assert.strictEqual(body.usage.length, 1, 'one site');
            assert.strictEqual(body.usage[0].key, 'site:design');
            assert.strictEqual(body.usage[0].people, 'fewer than 10', 'a group with fewer than ten people does not count them');
            assert.strictEqual(body.totals.calls, 1);
        });

        await check('the route for a person refuses a caller with no session, privately', async () => {
            const r = await t.get('/api/v1/me/ai/usage');
            assert.strictEqual(r.status, 401, r.text);
            assert.strictEqual(r.json().code, 'auth.sign_in_required');
            assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
        });

        await check('ADR-033: the records and the roll-ups leave with the account', async () => {
            const aiUsage = require('../server/analytics/ai-usage');
            const store = t.ctx.store;
            const exported = await aiUsage.exportFor(store, SUBJECT);
            assert.strictEqual(exported.records.length, 1, 'the record is exported');
            assert.strictEqual(exported.days.length, 1, 'the roll-up is exported');
            assert.ok(!JSON.stringify(exported).includes('anthropic ...a1b2') === false, 'the export keeps what the record says');
            const erased = await aiUsage.eraseFor(store, SUBJECT);
            assert.strictEqual(erased.records, 1, 'the record is erased');
            assert.strictEqual(erased.days, 1, 'the roll-up is erased');
            assert.strictEqual(await db.value('SELECT COUNT(*)::int AS n FROM report_ai_usage'), 0);
            assert.strictEqual(await db.value('SELECT COUNT(*)::int AS n FROM report_ai_usage_days'), 0);
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
