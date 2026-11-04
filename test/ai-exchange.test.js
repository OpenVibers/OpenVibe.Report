'use strict';
/**
 * The AI Exchange in Report (plan G-P9): the consumer of Billing's settlements, the aggregates and the two
 * staff-only read routes. Aggregates only; exact BigInt money; a settlement id counts once; the flag off consumes
 * nothing.
 */
const assert = require('assert');
const crypto = require('crypto');
const { signDeliveryV2 } = require('openvibe-sdk/events');
const { serviceAuth } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');

const SECRET = 'test-report-events-secret-32-characters-long';
const ISSUER = 'https://openvibe.network';
const NOW = Date.parse('2026-10-31T12:00:00.000Z');
const MODEL_A = 'qwen/qwen3_9b_abliterated:q4_k_m@3f2a1c9';
const MODEL_B = 'mistralai/ministral_8b:q5_k_m@77bb001';
const MODEL_C = 'meta/llama_3_1_8b:q4_k_m@a1b2c3d';
const MODEL_D = 'google/gemma_3_4b:q4_0@d4e5f60';
const SUBJECT = 'usr_01JTESTSUBJECT00000000000';
const PROJECT = 'prj_01JTESTPROJECT00000000000';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
});

/** A service token for the staff gate (Report's existing report.ai_usage.read). */
function token(cap) {
    const now = Math.floor(NOW / 1000);
    return serviceAuth.signServiceToken({
        iss: ISSUER, sub: 'svc:operator', actor_type: 'service', aud: ['openvibe.report'], cap, ns: ['*'],
        iat: now, exp: now + 300, jti: 'tok_aiexchange_' + String(now).slice(-6),
    }, privateKey);
}

/** One settlement event. The v0.284.0 payload carries no model; the event adds the resolved exact id. */
function settlementEvent({ event_id, event_type, occurred_at, ...over } = {}) {
    const payload = {
        settlement_id: 'stl_AITEST0000000000000001',
        hold_id: 'hld_AITEST0000000000000001',
        subject: { type: 'user', id: SUBJECT },
        project_id: PROJECT,
        charge_nano_usd: '18000',
        released_nano_usd: '82000000',
        journal_id: 'txn_AITEST0000000000000001',
        usage: { input_tokens: 1000, cached_read_tokens: 0, cache_write_tokens: 0, output_tokens: 500 },
        retail: { version: 'rr-test-001', nano_usd_per_m: { input: '3000', cached_read: '300', cache_write: '3000', output: '15000' }, per_request_nano_usd: '0' },
        supply_cost_nano_usd: '9000',
        byok: false,
        attempts: [{ deployment_id: 'dep-test-001', provider_access: 'OWN_DEPLOYMENT', started_at: '2026-10-31T00:00:01.000Z', ended_at: '2026-10-31T00:00:05.000Z', error_code: null }],
        created_at: '2026-10-31T00:00:05.000Z',
        resolved_model: MODEL_A,
        ...over,
    };
    return {
        event_id: event_id || 'evt_AITEST0000000000000001',
        event_type: event_type || 'billing.credit.settled',
        source: 'billing',
        occurred_at: occurred_at || payload.created_at,
        payload,
    };
}

function delivery(event) {
    const raw = JSON.stringify({ event });
    const ts = Math.floor(NOW / 1000);
    return { raw, headers: { 'content-type': 'application/json', 'x-openvibe-timestamp': String(ts), 'x-openvibe-signature-v2': signDeliveryV2(raw, SECRET, ts) } };
}

const STAFF = token(['report.ai_usage.read']);
const WRONG = token(['report.other.read']);

(async () => {
    const t = await boot({ db: true, now: () => NOW, env: { REPORT_AI_EXCHANGE: '1', REPORT_EVENTS_SECRET: SECRET, OV_NETWORK_PUBLIC_KEY: publicKey } });
    const db = t.ctx.store.db;
    const send = async (event) => {
        const d = delivery(event);
        return await t.get('/internal/events', { method: 'POST', headers: d.headers, body: d.raw });
    };
    try {
        await check('settlements aggregate by day, model and provider access, with exact money', async () => {
            const first = await send(settlementEvent());
            assert.strictEqual(first.status, 200, first.text);
            assert.strictEqual(first.json().outcome, 'settlement:recorded', first.text);

            // The same bucket again: two requests, the tokens and the money summed.
            const second = await send(settlementEvent({
                event_id: 'evt_AITEST0000000000000002', settlement_id: 'stl_AITEST0000000000000002',
                charge_nano_usd: '41000', supply_cost_nano_usd: '21000',
                usage: { input_tokens: 2000, cached_read_tokens: 100, cache_write_tokens: 50, output_tokens: 100 },
            }));
            assert.strictEqual(second.json().outcome, 'settlement:recorded', second.text);

            // Another model and another access on the same day, then a BYOK request on the next day.
            const third = await send(settlementEvent({
                event_id: 'evt_AITEST0000000000000003', settlement_id: 'stl_AITEST0000000000000003', resolved_model: MODEL_B,
                charge_nano_usd: '300', supply_cost_nano_usd: '100',
                usage: { input_tokens: 10, cached_read_tokens: 0, cache_write_tokens: 0, output_tokens: 20 },
                attempts: [{ deployment_id: 'dep-test-002', provider_access: 'AUTHORIZED_WHOLESALE', started_at: '2026-10-31T00:00:01.000Z', ended_at: '2026-10-31T00:00:05.000Z', error_code: null }],
            }));
            assert.strictEqual(third.json().outcome, 'settlement:recorded', third.text);
            const fourth = await send(settlementEvent({
                event_id: 'evt_AITEST0000000000000004', settlement_id: 'stl_AITEST0000000000000004', byok: true,
                charge_nano_usd: '0', supply_cost_nano_usd: '0', created_at: '2026-11-01T00:00:05.000Z',
                usage: { input_tokens: 500, cached_read_tokens: 0, cache_write_tokens: 0, output_tokens: 200 },
                attempts: [{ deployment_id: 'dep-owner-byok', provider_access: 'CUSTOMER_BYOK', started_at: '2026-11-01T00:00:01.000Z', ended_at: '2026-11-01T00:00:04.000Z', error_code: null }],
            }));
            assert.strictEqual(fourth.json().outcome, 'settlement:recorded', fourth.text);

            const r = await t.get('/api/v1/ai/exchange?from=2026-10-31&to=2026-11-01', { headers: { authorization: 'Bearer ' + STAFF } });
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.headers.get('cache-control'), 'no-store');
            const body = r.json();
            assert.deepStrictEqual(body.range, { from: '2026-10-31', to: '2026-11-01', days: 2 });
            assert.strictEqual(body.rows.length, 3, 'the two days and three model/access pairs');
            const a = body.rows.find((x) => x.day === '2026-10-31' && x.model === MODEL_A && x.provider_access === 'OWN_DEPLOYMENT');
            assert.ok(a, 'the main bucket');
            assert.strictEqual(a.requests, 2);
            assert.deepStrictEqual(a.tokens, { input: 3000, cached_read: 100, cache_write: 50, output: 600 });
            assert.strictEqual(a.retail_nano_usd, '59000');
            assert.strictEqual(a.supply_nano_usd, '30000');
            assert.strictEqual(a.margin_nano_usd, '29000');
            const b = body.rows.find((x) => x.model === MODEL_B);
            assert.strictEqual(b.provider_access, 'AUTHORIZED_WHOLESALE');
            assert.strictEqual(b.margin_nano_usd, '200');
            const byok = body.rows.find((x) => x.provider_access === 'CUSTOMER_BYOK');
            assert.strictEqual(byok.retail_nano_usd, '0');
            assert.strictEqual(byok.margin_nano_usd, '0');
            assert.strictEqual(body.totals.requests, 4);
            assert.strictEqual(body.totals.retail_nano_usd, '59300');
            assert.strictEqual(body.totals.supply_nano_usd, '30100');
            assert.strictEqual(body.totals.margin_nano_usd, '29200');
            assert.strictEqual(body.totals.supply_complete, true);
            assert.strictEqual(body.daily.length, 2, 'the chart has a day series');

            // Aggregates only: no person, no project, no prompt in the answer or in the table's columns.
            const text = JSON.stringify(body);
            for (const leak of [SUBJECT, PROJECT, 'usr_', 'prj_']) assert.ok(!text.includes(leak), 'the aggregate names nobody: ' + leak);
            const cols = await db.many("SELECT column_name FROM information_schema.columns WHERE table_name = 'report_ai_exchange_days'");
            const names = cols.map((c) => c.column_name);
            for (const banned of ['subject', 'project_id', 'prompt', 'output_text']) assert.ok(!names.includes(banned), 'no column ' + banned);
            assert.strictEqual(await db.value("SELECT COUNT(*)::int AS n FROM report_events WHERE topic LIKE 'billing.credit%'"), 0, 'the raw settlement is not stored');
        });

        await check('a replayed settlement counts once, by its settlement id, even under a new event id', async () => {
            const before = await db.value("SELECT requests::text AS n FROM report_ai_exchange_days WHERE model = $1 AND provider_access = 'OWN_DEPLOYMENT'", [MODEL_A]);
            const same = await send(settlementEvent());
            assert.strictEqual(same.status, 200, same.text);
            assert.strictEqual(same.json().duplicate, true, 'the same event id is a duplicate');
            const otherEvent = await send(settlementEvent({ event_id: 'evt_AITEST0000000000000009' }));
            assert.strictEqual(otherEvent.json().outcome, 'settlement:duplicate', 'the same settlement under a new event id is a duplicate');
            const after = await db.value("SELECT requests::text AS n FROM report_ai_exchange_days WHERE model = $1 AND provider_access = 'OWN_DEPLOYMENT'", [MODEL_A]);
            assert.strictEqual(after, before, 'the request count did not move');
        });

        await check('money stays exact beyond 2^53, as decimal strings', async () => {
            await send(settlementEvent({
                event_id: 'evt_AITEST0000000000000010', settlement_id: 'stl_AITEST0000000000000010', resolved_model: MODEL_C,
                charge_nano_usd: '9007199254740993', supply_cost_nano_usd: '1', created_at: '2026-11-01T01:00:00.000Z',
                usage: { input_tokens: 1, cached_read_tokens: 0, cache_write_tokens: 0, output_tokens: 1 },
            }));
            await send(settlementEvent({
                event_id: 'evt_AITEST0000000000000011', settlement_id: 'stl_AITEST0000000000000011', resolved_model: MODEL_C,
                charge_nano_usd: '1', supply_cost_nano_usd: '1', created_at: '2026-11-01T02:00:00.000Z',
                usage: { input_tokens: 0, cached_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0 },
            }));
            const r = await t.get('/api/v1/ai/exchange?from=2026-11-01&to=2026-11-01', { headers: { authorization: 'Bearer ' + STAFF } });
            const row = r.json().rows.find((x) => x.model === MODEL_C);
            assert.strictEqual(row.retail_nano_usd, '9007199254740994');
            assert.strictEqual(row.supply_nano_usd, '2');
            assert.strictEqual(row.margin_nano_usd, '9007199254740992');
            assert.strictEqual(typeof row.retail_nano_usd, 'string', 'money is a decimal string, never a float');
            assert.strictEqual(typeof row.margin_nano_usd, 'string');
        });

        await check('a settlement without a supply cost has no margin, and the total says so', async () => {
            const r = await send(settlementEvent({
                event_id: 'evt_AITEST0000000000000012', settlement_id: 'stl_AITEST0000000000000012', resolved_model: MODEL_D,
                supply_cost_nano_usd: undefined, charge_nano_usd: '500', created_at: '2026-11-01T03:00:00.000Z',
                usage: { input_tokens: 5, cached_read_tokens: 0, cache_write_tokens: 0, output_tokens: 5 },
            }));
            assert.strictEqual(r.json().outcome, 'settlement:recorded', r.text);
            const api = await t.get('/api/v1/ai/exchange?from=2026-11-01&to=2026-11-01', { headers: { authorization: 'Bearer ' + STAFF } });
            const body = api.json();
            const row = body.rows.find((x) => x.model === MODEL_D);
            assert.strictEqual(row.supply_nano_usd, null, 'a missing supply is not zero');
            assert.strictEqual(row.margin_nano_usd, null, 'no margin without supply');
            assert.strictEqual(body.totals.supply_complete, false);
            assert.strictEqual(body.totals.supply_nano_usd, null);
            assert.strictEqual(body.totals.margin_nano_usd, null);
        });

        await check('the page and the endpoint refuse non-staff, and the page draws the table and a chart', async () => {
            for (const path of ['/api/v1/ai/exchange', '/ai/exchange']) {
                const none = await t.get(path);
                assert.strictEqual(none.status, 401, path + ' without a token');
                const wrong = await t.get(path, { headers: { authorization: 'Bearer ' + WRONG } });
                assert.strictEqual(wrong.status, 403, path + ' with the wrong capability');
            }
            const page = await t.get('/ai/exchange?from=2026-10-31&to=2026-11-01', { headers: { authorization: 'Bearer ' + STAFF } });
            assert.strictEqual(page.status, 200, page.text.slice(0, 300));
            assert.strictEqual(page.headers.get('cache-control'), 'private, no-store');
            assert.match(page.text, /AI Exchange/);
            assert.match(page.text, /qwen\/qwen3_9b_abliterated/);
            assert.match(page.text, /<svg/);
            assert.match(page.text, /\$0\.000059/, 'the exact retail amount is printed');
            assert.match(page.text, /29000 nano-USD from Billing/, 'the exact nano amount is in the title');
            for (const leak of [SUBJECT, PROJECT, 'usr_', 'prj_']) assert.ok(!page.text.includes(leak), 'the staff page names nobody: ' + leak);
        });

        await check('a malformed amount is ignored, never summed as zero', async () => {
            const before = await db.value('SELECT COUNT(*)::int AS n FROM report_ai_exchange_seen');
            let n = 20;
            for (const bad of ['18.5', 18000, '1e3', '-1']) {
                n += 1;
                const r = await send(settlementEvent({
                    event_id: 'evt_AITEST0000000000000' + String(n).padStart(3, '0'), settlement_id: 'stl_BAD' + String(n),
                    charge_nano_usd: bad,
                }));
                assert.strictEqual(r.json().outcome, 'ignored:payload', 'bad amount ' + String(bad));
            }
            assert.strictEqual(await db.value('SELECT COUNT(*)::int AS n FROM report_ai_exchange_seen'), before, 'nothing was claimed');
        });
    } finally { await t.close(); }

    // ── The flag is off: a settlement delivery is consumed by nothing, not even its event id ──
    const off = await boot({ db: true, now: () => NOW, env: { REPORT_EVENTS_SECRET: SECRET } });
    try {
        await check('flag off consumes nothing and exposes no page or endpoint', async () => {
            const d = delivery(settlementEvent({ event_id: 'evt_AITEST0000000000000100' }));
            const r = await off.get('/internal/events', { method: 'POST', headers: d.headers, body: d.raw });
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.json().outcome, 'ignored:flag');
            for (const table of ['report_ai_exchange_days', 'report_ai_exchange_seen', 'report_events', 'report_inbox']) {
                assert.strictEqual(await off.ctx.store.db.value(`SELECT COUNT(*)::int AS n FROM ${table}`), 0, table + ' stays empty');
            }
            const api = await off.get('/api/v1/ai/exchange', { headers: { authorization: 'Bearer ' + STAFF } });
            assert.strictEqual(api.status, 404, 'the endpoint does not exist while the flag is off');
            const page = await off.get('/ai/exchange', { headers: { authorization: 'Bearer ' + STAFF } });
            assert.strictEqual(page.status, 404, 'the page does not exist while the flag is off');
        });
    } finally { await off.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
