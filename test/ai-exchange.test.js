'use strict';
/**
 * The AI Exchange in Report (plan G-P9): the consumer of Billing's `billing.credit.settled` event, the aggregates and
 * the staff-only page + service-token API. Aggregates only; exact BigInt money; a settlement id counts once; sandbox
 * is not money; invalid payloads are rejected; the flag off consumes nothing.
 */
const assert = require('assert');
const crypto = require('crypto');
const contracts = require('openvibe-contracts');
const { signDeliveryV2 } = require('openvibe-sdk/events');
const { serviceAuth } = require('openvibe-contracts');
const { createSsoClient } = require('openvibe-sdk/sso');
const { boot, check, done } = require('./helpers/boot');

const SECRET = 'test-report-events-secret-32-characters-long';
const ISSUER = 'https://openvibe.network';
const NOW = Date.parse('2026-11-04T12:00:00.000Z');
const MODEL_A = 'qwen/qwen3_4b:q4_k_m@3f2a1c9';
const MODEL_B = 'qwen/qwen3_coder_30b_a3b_instruct';
const MODEL_C = 'meta/llama_3_1_8b:q4_k_m@a1b2c3d';
const PERSON = 'usr_01JTESTPERSON000000000000';
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A valid ULID-shaped id for the fixtures (26 Crockford base32 characters). */
function ulid(n) {
    let s = '';
    for (let i = 0; i < 26; i += 1) { s = B32[n % 32] + s; n = Math.floor(n / 32); }
    return s;
}

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
/** A person's access token, the way OpenVibe.Network signs one (real time: the SSO verifier reads the clock). */
function personToken(claims) {
    const now = Math.floor(Date.now() / 1000);
    const head = b64({ alg: 'RS256', typ: 'JWT', kid: 'test' });
    const body = b64({ iss: ISSUER, aud: ['openvibe.network', 'openvibe.report'], iat: now, exp: now + 3600, ...claims });
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
    return `${head}.${body}.${sig}`;
}
const STAFF_PERSON = personToken({ sub: '1', subject_id: PERSON, username: 'staffer', display_name: 'Staffer', role: 'admin' });
const PLAIN_PERSON = personToken({ sub: '2', subject_id: 'usr_01JTESTPERSON000000000002', username: 'visitor', display_name: 'Visitor', role: 'user' });

/** A Network service token for the JSON endpoint (the existing report.ai_usage.read gate). */
function serviceToken(cap) {
    const now = Math.floor(NOW / 1000);
    return serviceAuth.signServiceToken({
        iss: ISSUER, sub: 'svc:operator', actor_type: 'service', aud: ['openvibe.report'], cap, ns: ['*'],
        iat: now, exp: now + 300, jti: 'tok_aiexchange_' + String(now).slice(-6),
    }, privateKey);
}
const SERVICE_STAFF = serviceToken(['report.ai_usage.read']);
const SERVICE_WRONG = serviceToken(['report.other.read']);

const sso = createSsoClient({
    site: 'report', baseUrl: 'https://openvibe.report', clientId: 'report', clientSecret: 'x',
    networkUrl: ISSUER, publicKey,
    log: { warn() {}, info() {}, log() {}, error() {} },
});

let seq = 0;
/** One `billing.credit.settled` event in the v0.287.0 payload shape. */
function settlementEvent(over = {}) {
    seq += 1;
    const { event_id, event_type, occurred_at, ...fields } = over;
    const payload = {
        settlement_id: `stl_${ulid(seq)}`,
        hold_id: `hld_${ulid(seq)}`,
        service: 'ai',
        settled_at: '2026-11-04T12:00:05.000Z',
        deployment_id: 'own:qwen/qwen3_4b:q4_k_m@3f2a1c9',
        provider_access: 'OWN_DEPLOYMENT',
        rate_version: 'rr-test-001',
        usage: { input_tokens: 1000, cached_read_tokens: 0, cache_write_tokens: 0, output_tokens: 500 },
        charge_nano_usd: '18000',
        supply_cost_nano_usd: '9000',
        shortfall_nano_usd: '0',
        released_nano_usd: '82000000',
        byok: false,
        sandbox: false,
        ...fields,
    };
    return {
        event_id: event_id || `evt_${ulid(seq)}`,
        event_type: event_type || 'billing.credit.settled',
        source: 'billing',
        occurred_at: occurred_at || payload.settled_at,
        payload,
    };
}

function delivery(event) {
    const raw = JSON.stringify({ event });
    const ts = Math.floor(NOW / 1000);
    return { raw, headers: { 'content-type': 'application/json', 'x-openvibe-timestamp': String(ts), 'x-openvibe-signature-v2': signDeliveryV2(raw, SECRET, ts) } };
}

(async () => {
    const t = await boot({ db: true, now: () => NOW, sso, env: { REPORT_AI_EXCHANGE: '1', REPORT_EVENTS_SECRET: SECRET, OV_NETWORK_PUBLIC_KEY: publicKey } });
    const db = t.ctx.store.db;
    const send = async (event) => {
        const d = delivery(event);
        return await t.get('/internal/events', { method: 'POST', headers: d.headers, body: d.raw });
    };
    try {
        await check('a v0.287.0 fixture aggregates by day, model and provider access, with exact money', async () => {
            assert.ok(contracts.validate('billing.credit.settled@1', settlementEvent().payload).valid, 'the test fixture matches the contract');
            const first = await send(settlementEvent());
            assert.strictEqual(first.status, 200, first.text);
            assert.strictEqual(first.json().outcome, 'settlement:recorded', first.text);

            const second = await send(settlementEvent({
                charge_nano_usd: '41000', supply_cost_nano_usd: '21000', shortfall_nano_usd: '7',
                usage: { input_tokens: 2000, cached_read_tokens: 100, cache_write_tokens: 50, output_tokens: 100 },
            }));
            assert.strictEqual(second.json().outcome, 'settlement:recorded', second.text);

            const third = await send(settlementEvent({
                deployment_id: `deepinfra:${MODEL_B}`, provider_access: 'AUTHORIZED_WHOLESALE',
                charge_nano_usd: '300', supply_cost_nano_usd: '100',
                usage: { input_tokens: 10, cached_read_tokens: 0, cache_write_tokens: 0, output_tokens: 20 },
            }));
            assert.strictEqual(third.json().outcome, 'settlement:recorded', third.text);

            // The v0.287.0 byok-sandbox fixture: counted apart, never money.
            const sandbox = await send(settlementEvent({
                settled_at: '2026-11-05T12:00:07.000Z', deployment_id: null, provider_access: null, byok: true, sandbox: true,
                usage: { input_tokens: 0, cached_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0 },
                charge_nano_usd: '0', supply_cost_nano_usd: '0', shortfall_nano_usd: '0',
            }));
            assert.strictEqual(sandbox.json().outcome, 'settlement:recorded', sandbox.text);

            const r = await t.get('/api/v1/ai/exchange?from=2026-11-04&to=2026-11-05', { headers: { authorization: 'Bearer ' + SERVICE_STAFF } });
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.headers.get('cache-control'), 'no-store');
            const body = r.json();
            assert.deepStrictEqual(body.range, { from: '2026-11-04', to: '2026-11-05', days: 2 });
            assert.strictEqual(body.rejected.count, 0, 'nothing invalid yet');
            const a = body.rows.find((x) => x.day === '2026-11-04' && x.model === MODEL_A && x.provider_access === 'OWN_DEPLOYMENT');
            assert.ok(a, 'the main bucket, keyed by the model after the deployment id\'s first colon');
            assert.strictEqual(a.requests, 2);
            assert.strictEqual(a.sandbox_requests, 0);
            assert.deepStrictEqual(a.tokens, { input: 3000, cached_read: 100, cache_write: 50, output: 600 });
            assert.strictEqual(a.retail_nano_usd, '59000');
            assert.strictEqual(a.shortfall_nano_usd, '7');
            assert.strictEqual(a.supply_nano_usd, '30000');
            assert.strictEqual(a.margin_nano_usd, '29000');
            const b = body.rows.find((x) => x.model === MODEL_B);
            assert.strictEqual(b.provider_access, 'AUTHORIZED_WHOLESALE');
            assert.strictEqual(b.margin_nano_usd, '200');
            const sandboxRow = body.rows.find((x) => x.day === '2026-11-05' && x.model === 'unknown' && x.provider_access === 'unknown');
            assert.ok(sandboxRow, 'the sandbox row is counted apart');
            assert.strictEqual(sandboxRow.sandbox_requests, 1);
            assert.strictEqual(sandboxRow.requests, 0, 'sandbox is not a money request');
            assert.strictEqual(sandboxRow.retail_nano_usd, '0');
            assert.strictEqual(sandboxRow.tokens.input, 0);
            assert.strictEqual(body.totals.requests, 3);
            assert.strictEqual(body.totals.sandbox_requests, 1);
            assert.strictEqual(body.totals.retail_nano_usd, '59300');
            assert.strictEqual(body.totals.shortfall_nano_usd, '7');
            assert.strictEqual(body.totals.supply_nano_usd, '30100');
            assert.strictEqual(body.totals.margin_nano_usd, '29200');
            assert.strictEqual(body.daily.length, 2, 'the chart has a day series');
            const text = JSON.stringify(body);
            for (const leak of ['usr_', 'prj_', 'subject']) assert.ok(!text.includes(leak), 'the aggregate names nobody: ' + leak);
            const cols = await db.many("SELECT column_name FROM information_schema.columns WHERE table_name = 'report_ai_exchange_days'");
            const names = cols.map((c) => c.column_name);
            for (const banned of ['subject', 'project_id', 'prompt', 'output_text']) assert.ok(!names.includes(banned), 'no column ' + banned);
            assert.strictEqual(await db.value("SELECT COUNT(*)::int AS n FROM report_events WHERE topic = 'billing.credit.settled'"), 0, 'the raw settlement is not stored');
        });

        await check('an invalid payload is counted as rejected, never aggregated', async () => {
            const rows = await db.value('SELECT COUNT(*)::int AS n FROM report_ai_exchange_days');
            const seen = await db.value('SELECT COUNT(*)::int AS n FROM report_ai_exchange_seen');
            const bad = settlementEvent({ charge_nano_usd: 11 });
            const r = await send(bad);
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.json().outcome, 'settlement:rejected', 'a money number is invalid');
            assert.strictEqual(await db.value('SELECT COUNT(*)::int AS n FROM report_ai_exchange_days'), rows, 'nothing aggregated');
            assert.strictEqual(await db.value('SELECT COUNT(*)::int AS n FROM report_ai_exchange_seen'), seen, 'the invalid settlement id is not claimed');
            assert.strictEqual(await db.value('SELECT SUM(events)::int AS n FROM report_ai_exchange_rejected'), 1);
            const api = await t.get('/api/v1/ai/exchange?from=2026-11-04&to=2026-11-04', { headers: { authorization: 'Bearer ' + SERVICE_STAFF } });
            assert.strictEqual(api.json().rejected.count, 1);
            assert.deepStrictEqual(api.json().rejected.by_day, [{ day: '2026-11-04', events: 1 }]);
        });

        await check('a replayed settlement counts once, by its settlement id, even under a new event id', async () => {
            const before = await db.value("SELECT requests::text AS n FROM report_ai_exchange_days WHERE model = $1 AND provider_access = 'OWN_DEPLOYMENT'", [MODEL_A]);
            const event = settlementEvent({ settlement_id: `stl_${ulid(900)}`, hold_id: `hld_${ulid(900)}` });
            assert.strictEqual((await send(event)).json().outcome, 'settlement:recorded');
            const same = await send(event);
            assert.strictEqual(same.status, 200, same.text);
            assert.strictEqual(same.json().duplicate, true, 'the same event id is a duplicate');
            const otherEvent = await send({ ...event, event_id: `evt_${ulid(901)}` });
            assert.strictEqual(otherEvent.json().outcome, 'settlement:duplicate', 'the same settlement under a new event id is a duplicate');
            const after = await db.value("SELECT requests::text AS n FROM report_ai_exchange_days WHERE model = $1 AND provider_access = 'OWN_DEPLOYMENT'", [MODEL_A]);
            assert.strictEqual(Number(after) - Number(before), 1, 'the replay added exactly the new settlement');
        });

        await check('money stays exact beyond 2^53, as decimal strings', async () => {
            await send(settlementEvent({
                settled_at: '2026-11-06T01:00:00.000Z', deployment_id: `own:${MODEL_C}`, charge_nano_usd: '9007199254740993',
                supply_cost_nano_usd: '1', shortfall_nano_usd: '2',
                usage: { input_tokens: 1, cached_read_tokens: 0, cache_write_tokens: 0, output_tokens: 1 },
            }));
            await send(settlementEvent({
                settled_at: '2026-11-06T02:00:00.000Z', deployment_id: `own:${MODEL_C}`, charge_nano_usd: '1',
                supply_cost_nano_usd: '1', shortfall_nano_usd: '0',
                usage: { input_tokens: 0, cached_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0 },
            }));
            const r = await t.get('/api/v1/ai/exchange?from=2026-11-06&to=2026-11-06', { headers: { authorization: 'Bearer ' + SERVICE_STAFF } });
            const row = r.json().rows.find((x) => x.model === MODEL_C);
            assert.strictEqual(row.retail_nano_usd, '9007199254740994');
            assert.strictEqual(row.supply_nano_usd, '2');
            assert.strictEqual(row.shortfall_nano_usd, '2');
            assert.strictEqual(row.margin_nano_usd, '9007199254740992');
            assert.strictEqual(typeof row.retail_nano_usd, 'string', 'money is a decimal string, never a float');
        });

        await check('the page is for signed-in staff; the JSON endpoint keeps its service-token gate', async () => {
            const anonymous = await t.get('/ai/exchange');
            assert.strictEqual(anonymous.status, 401, 'no session');
            assert.match(anonymous.text, /Staff only/);
            const plain = await t.get('/ai/exchange', { headers: { cookie: `ov_token=${PLAIN_PERSON}` } });
            assert.strictEqual(plain.status, 403, 'a signed-in non-staff person');
            const bearerOnly = await t.get('/ai/exchange', { headers: { authorization: 'Bearer ' + SERVICE_STAFF } });
            assert.strictEqual(bearerOnly.status, 401, 'the page does not accept the service token');
            const staff = await t.get('/ai/exchange?from=2026-11-04&to=2026-11-05', { headers: { cookie: `ov_token=${STAFF_PERSON}` } });
            assert.strictEqual(staff.status, 200, staff.text.slice(0, 300));
            assert.strictEqual(staff.headers.get('cache-control'), 'private, no-store');
            assert.match(staff.text, /AI Exchange/);
            assert.match(staff.text, /qwen\/qwen3_4b/);
            assert.match(staff.text, /<svg/);
            assert.match(staff.text, /\$0\.0000002/, 'the exact margin of the second model is printed');
            assert.match(staff.text, /200 nano-USD from Billing/, 'the exact nano amount is in the title');

            const noToken = await t.get('/api/v1/ai/exchange');
            assert.strictEqual(noToken.status, 401, 'the endpoint without a service token');
            const wrong = await t.get('/api/v1/ai/exchange', { headers: { authorization: 'Bearer ' + SERVICE_WRONG } });
            assert.strictEqual(wrong.status, 403, 'the endpoint with the wrong capability');
        });
    } finally { await t.close(); }

    // ── The flag is off: a settlement delivery is consumed by nothing, not even its event id ──
    const off = await boot({ db: true, now: () => NOW, sso, env: { REPORT_EVENTS_SECRET: SECRET } });
    try {
        await check('flag off consumes nothing and exposes no page or endpoint', async () => {
            const d = delivery(settlementEvent({ event_id: 'evt_AITEST0000000000000100' }));
            const r = await off.get('/internal/events', { method: 'POST', headers: d.headers, body: d.raw });
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.json().outcome, 'ignored:flag');
            for (const table of ['report_ai_exchange_days', 'report_ai_exchange_seen', 'report_ai_exchange_rejected', 'report_events', 'report_inbox']) {
                assert.strictEqual(await off.ctx.store.db.value(`SELECT COUNT(*)::int AS n FROM ${table}`), 0, table + ' stays empty');
            }
            const api = await off.get('/api/v1/ai/exchange', { headers: { authorization: 'Bearer ' + SERVICE_STAFF } });
            assert.strictEqual(api.status, 404, 'the endpoint does not exist while the flag is off');
            const page = await off.get('/ai/exchange', { headers: { cookie: `ov_token=${STAFF_PERSON}` } });
            assert.strictEqual(page.status, 404, 'the page does not exist while the flag is off');
        });
    } finally { await off.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
