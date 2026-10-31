'use strict';
/**
 * A person's own AI usage (plan L41 R1): GET /api/v1/me/ai/usage.
 *
 * The subject is the signed-in person and only their session names it; signed out is 401, a service principal is
 * not a session and another person's records never appear. The groups, the totals, what each way of paying cost,
 * the two or three plain lines, the 30-day default and the 400-day cap, the raw records inside the 90-day
 * retention and the roll-ups beyond it, the private headers and the tighter personal limit.
 */
const assert = require('assert');
const crypto = require('crypto');
const contracts = require('openvibe-contracts');
const { createSsoClient } = require('openvibe-sdk/sso');
const { boot, check, done } = require('./helpers/boot');
const ledger = require('../server/analytics/ai-usage');

const NOW = Date.parse('2026-10-31T12:00:00.000Z');
const A = 'usr_01JTESTPERSONA0000000000000';
const B = 'usr_01JTESTPERSONB0000000000000';
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
/** A person's access token, the way OpenVibe.Network signs one. */
function token(claims) {
    const now = Math.floor(Date.now() / 1000);
    const head = b64({ alg: 'RS256', typ: 'JWT', kid: 'test' });
    const body = b64({ iss: 'https://openvibe.network', aud: ['openvibe.network', 'openvibe.report'], iat: now, exp: now + 3600, ...claims });
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
    return `${head}.${body}.${sig}`;
}
const alice = token({ sub: '1', subject_id: A, username: 'alice', display_name: 'Alice' });
const bob = token({ sub: '2', subject_id: B, username: 'bob', display_name: 'Bob' });
const service = token({ sub: 'svc:operator', actor_type: 'service', subject_id: A, username: 'operator' });

const sso = createSsoClient({
    site: 'report', baseUrl: 'https://openvibe.report', clientId: 'report', clientSecret: 'x',
    networkUrl: 'https://openvibe.network', publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    log: { warn() {}, info() {}, log() {}, error() {} },
});

const MEASURES = ['calls', 'input_tokens', 'output_tokens', 'cached_tokens', 'cache_write_tokens', 'cost_usd', 'fee_usd', 'charged_usd', 'saved_usd'];

/** The route's answer must match the published contract, not only this test's idea of it. */
function assertContract(body, label) {
    const r = contracts.validate('report.ai-usage-me-result@2', body);
    assert.ok(r.valid, `${label} does not match report.ai-usage-me-result@2: ${JSON.stringify(r.errors)}`);
}

(async () => {
    const t = await boot({ db: true, now: () => NOW, sso });
    const store = t.ctx.store;
    let seq = 0;
    async function addCall(p = {}) {
        seq += 1;
        await store.tx((tx) => ledger.recordUsage(tx, {
            system: 'ai', run_id: `run_${String(seq).padStart(4, '0')}`, subject: A,
            attribution: 'site:design', surface: 'ai.generate', provider: 'anthropic', model: 'claude-sonnet-4-5',
            paid_by: 'own_key', input: 100, output: 10, reasoning: 0, cache_read: 0, cache_write: 0,
            list_cost_usd: 0.01, charged_usd: 0, fee_usd: 0, cache_saved_usd: 0,
            price_source: 'models', outcome: 'succeeded', at: '2026-10-31T10:00:00.000Z',
            ...p,
        }));
    }
    try {
        // Alice: three October calls on three days plus a September one, one of them on the OpenVibe key; an older call
        // (March 2026), the first day a 400-day window reaching back from 2026-10-31 keeps (2025-09-27), and the day
        // before it. Bob has one call of his own, and must never be in Alice's answer.
        await addCall({ at: '2026-10-31T10:00:00.000Z', input: 200, output: 80, cache_read: 800, list_cost_usd: 0.0021, cache_saved_usd: 0.0012 });
        await addCall({ at: '2026-10-30T10:00:00.000Z', provider: 'openai', model: 'gpt-5', surface: 'codes.turn', paid_by: 'openvibe_key', input: 1000, output: 500, cache_write: 100, list_cost_usd: 0.05, charged_usd: 0.06, fee_usd: 0.01 });
        await addCall({ at: '2026-10-26T10:00:00.000Z', input: 50, output: 10, list_cost_usd: 0.001, cache_saved_usd: 0.0005 });
        await addCall({ at: '2026-09-15T10:00:00.000Z', provider: 'openai', model: 'gpt-5', input: 300, output: 30, cache_read: 100, list_cost_usd: 0.004, cache_saved_usd: 0.0002 });
        await addCall({ at: '2026-03-01T10:00:00.000Z', provider: 'oldprov', model: 'old-model', surface: 'old.surface', input: 7, output: 3, list_cost_usd: 0.0007 });
        await addCall({ at: '2025-09-27T10:00:00.000Z', provider: 'capprov', model: 'cap-model', surface: 'cap.surface', input: 11, output: 1, list_cost_usd: 0.0011 });
        await addCall({ at: '2025-09-26T10:00:00.000Z', provider: 'beyondprov', model: 'beyond-model', surface: 'beyond.surface', input: 13, output: 1, list_cost_usd: 0.0013 });
        await addCall({ subject: B, at: '2026-10-31T11:00:00.000Z', provider: 'google', model: 'gemini-bob', surface: 'bobs.surface', paid_by: 'org_key', input: 9000, output: 9000, list_cost_usd: 9, charged_usd: 9, fee_usd: 9 });
        // Roll the records up, then prune the raw ones the 90-day retention drops: the old range is answered from
        // the roll-ups, and the recent one from the raw records.
        await ledger.rollup(store, { days: 500 });
        await ledger.prune(store, { now: NOW });

        await check('signed out is a private 401, and a service token is not a session', async () => {
            const out = await t.get('/api/v1/me/ai/usage');
            assert.strictEqual(out.status, 401, out.text);
            assert.strictEqual(out.json().code, 'auth.sign_in_required');
            assert.strictEqual(out.headers.get('cache-control'), 'private, no-store');
            const svc = await t.get('/api/v1/me/ai/usage', { headers: { authorization: 'Bearer ' + service } });
            assert.strictEqual(svc.status, 401, 'a service principal is not a person');
        });

        await check('the last 30 days by default, only the person in the session, raw records', async () => {
            const r = await t.get('/api/v1/me/ai/usage', { headers: { cookie: `ov_token=${alice}` } });
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
            const body = r.json();
            assert.strictEqual(body.group, 'day');
            assert.strictEqual(body.source, 'raw', 'a recent range reads the raw records');
            assert.deepStrictEqual(body.rows.map((x) => x.key), ['2026-10-26', '2026-10-30', '2026-10-31'], 'the default window starts on 2026-10-02');
            assert.strictEqual(body.totals.calls, 3, 'three calls in the last 30 days');
            const text = JSON.stringify(body);
            for (const leak of ['gemini-bob', 'org_key', 'bobs.surface', 'google', B]) assert.ok(!text.includes(leak), 'another person must not be named: ' + leak);
            const asked = await t.get('/api/v1/me/ai/usage?subject=' + B, { headers: { cookie: `ov_token=${alice}` } });
            assert.strictEqual(asked.status, 200, asked.text);
            assert.strictEqual(asked.json().totals.calls, 3, 'the query cannot name another subject');
            const bearer = await t.get('/api/v1/me/ai/usage', { headers: { authorization: 'Bearer ' + alice } });
            assert.strictEqual(bearer.status, 200, 'a bearer session is a session too');
            assert.deepStrictEqual(bearer.json().totals, body.totals);
            const other = await t.get('/api/v1/me/ai/usage', { headers: { cookie: `ov_token=${bob}` } });
            assert.strictEqual(other.json().totals.calls, 1, 'Bob reads only Bob');
            assert.strictEqual(other.json().rows[0].key, '2026-10-31');
        });

        await check('the seven groups bucket the person’s own rows', async () => {
            const expected = {
                day: ['2026-09-15', '2026-10-26', '2026-10-30', '2026-10-31'],
                week: ['2026-09-14', '2026-10-26'],
                month: ['2026-09', '2026-10'],
                provider: ['anthropic', 'openai'],
                model: ['claude-sonnet-4-5', 'gpt-5'],
                surface: ['ai.generate', 'codes.turn'],
                paid_by: ['openvibe_key', 'own_key'],
            };
            for (const [group, keys] of Object.entries(expected)) {
                const r = await t.get(`/api/v1/me/ai/usage?group=${group}&from=2026-09-01&to=2026-10-31`, { headers: { cookie: `ov_token=${alice}` } });
                assert.strictEqual(r.status, 200, group + ': ' + r.text);
                const body = r.json();
                assert.strictEqual(body.group, group);
                assert.deepStrictEqual(body.rows.map((x) => x.key), keys, group);
                for (const row of body.rows) for (const k of MEASURES) assert.strictEqual(typeof row[k], 'number', `${group}.${k}`);
            }
        });

        await check('a real answer matches report.ai-usage-me-result@2', async () => {
            const headers = { cookie: `ov_token=${alice}` };
            for (const [label, query] of [
                ['default', ''],
                ['paid_by', '?group=paid_by&from=2026-09-01&to=2026-10-31'],
                ['empty', '?from=2026-01-01&to=2026-01-02'],
                ['rollups', '?group=surface&from=2026-01-01&to=2026-06-30'],
                ['straddle', '?group=provider&from=2026-01-01&to=2026-10-31'],
            ]) {
                const r = await t.get('/api/v1/me/ai/usage' + query, { headers });
                assert.strictEqual(r.status, 200, label + ': ' + r.text);
                assertContract(r.json(), label);
            }
            const bobAnswer = await t.get('/api/v1/me/ai/usage', { headers: { cookie: `ov_token=${bob}` } });
            assert.strictEqual(bobAnswer.status, 200, bobAnswer.text);
            assertContract(bobAnswer.json(), 'bob (org_key)');
        });

        await check('the totals and by_paid_by add up to the rows', async () => {
            for (const group of ['day', 'week', 'month', 'provider', 'model', 'surface', 'paid_by', 'week']) {
                const body = (await t.get(`/api/v1/me/ai/usage?group=${group}&from=2026-09-01&to=2026-10-31`, { headers: { cookie: `ov_token=${alice}` } })).json();
                for (const k of MEASURES) {
                    const sum = body.rows.reduce((n, row) => n + row[k], 0);
                    assert.ok(Math.abs(sum - body.totals[k]) < 1e-6, `${group}.${k}: ${sum} vs ${body.totals[k]}`);
                    const paid = Object.values(body.by_paid_by).reduce((n, row) => n + row[k], 0);
                    assert.ok(Math.abs(paid - body.totals[k]) < 1e-6, `by_paid_by.${k}: ${paid} vs ${body.totals[k]}`);
                }
            }
        });

        await check('two or three plain lines, worked out from the numbers', async () => {
            const body = (await t.get('/api/v1/me/ai/usage?from=2026-09-01&to=2026-10-31', { headers: { cookie: `ov_token=${alice}` } })).json();
            const lines = body.insights;
            assert.ok(Array.isArray(lines) && lines.length >= 2 && lines.length <= 3, JSON.stringify(lines));
            assert.ok(lines.some((l) => /75% of your calls ran on your own keys/.test(l)), lines.join(' | '));
            assert.ok(lines.some((l) => /cache saved you/.test(l)), lines.join(' | '));
            assert.ok(lines.some((l) => /cost|charged you/.test(l)), lines.join(' | '));
            const empty = (await t.get('/api/v1/me/ai/usage?from=2026-01-01&to=2026-01-02', { headers: { cookie: `ov_token=${alice}` } })).json();
            assert.deepStrictEqual(empty.insights, ['No AI calls in this window.']);
            assert.deepStrictEqual(empty.rows, []);
        });

        await check('the roll-ups answer a range beyond 90 days, and the split is named', async () => {
            const old = (await t.get('/api/v1/me/ai/usage?group=surface&from=2026-01-01&to=2026-06-30', { headers: { cookie: `ov_token=${alice}` } })).json();
            assert.strictEqual(old.source, 'rollups');
            assert.deepStrictEqual(old.rows.map((x) => x.key), ['old.surface'], 'the roll-up keeps the surface');
            assert.strictEqual(old.totals.calls, 1);
            const straddle = (await t.get('/api/v1/me/ai/usage?group=provider&from=2026-01-01&to=2026-10-31', { headers: { cookie: `ov_token=${alice}` } })).json();
            assert.strictEqual(straddle.source, 'raw+rollups');
            assert.deepStrictEqual(straddle.rows.map((x) => x.key), ['anthropic', 'oldprov', 'openai']);
            assert.strictEqual(straddle.totals.calls, 5, 'the March call from the roll-ups and the four raw calls since');
            const weeks = (await t.get('/api/v1/me/ai/usage?group=week&from=2026-01-01&to=2026-10-31', { headers: { cookie: `ov_token=${alice}` } })).json();
            assert.strictEqual(weeks.source, 'raw+rollups');
            assert.deepStrictEqual(weeks.rows.map((x) => x.key), ['2026-02-23', '2026-09-14', '2026-10-26'], 'a week combines both sources');
            assert.strictEqual(weeks.totals.calls, 5);
        });

        await check('at most 400 days back: the first day in, the day before out', async () => {
            const body = (await t.get('/api/v1/me/ai/usage?group=day&from=2024-01-01&to=2026-10-31', { headers: { cookie: `ov_token=${alice}` } })).json();
            assert.strictEqual(body.source, 'raw+rollups');
            const keys = body.rows.map((x) => x.key);
            assert.ok(keys.includes('2025-09-27'), 'the first day of the 400-day window is in');
            assert.ok(!keys.includes('2025-09-26'), 'the day before it is out');
            assert.strictEqual(body.totals.calls, 6, 'the cap row, March, September and the three October calls');
        });

        await check('an impossible range or group is a 422 problem+json', async () => {
            for (const q of ['group=year', 'from=2026-02-31&to=2026-10-31', 'from=2026-11-01&to=2026-10-01', 'from=nope']) {
                const r = await t.get('/api/v1/me/ai/usage?' + q, { headers: { cookie: `ov_token=${alice}` } });
                assert.strictEqual(r.status, 422, q);
                assert.match(r.headers.get('content-type') || '', /^application\/problem\+json/);
                assert.strictEqual(r.json().code, 'ai.invalid', q);
                assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
            }
        });
    } finally { await t.close(); }

    await check('the personal route has its own limit, then a 429 problem', async () => {
        const limited = await boot({ db: true, now: () => NOW, sso, env: { REPORT_ME_RATE_LIMIT_PER_MIN: '2' } });
        try {
            const headers = { cookie: `ov_token=${alice}` };
            assert.strictEqual((await limited.get('/api/v1/me/ai/usage', { headers })).status, 200);
            assert.strictEqual((await limited.get('/api/v1/me/ai/usage', { headers })).status, 200);
            const third = await limited.get('/api/v1/me/ai/usage', { headers });
            assert.strictEqual(third.status, 429);
            assert.match(third.headers.get('content-type') || '', /^application\/problem\+json/);
            assert.strictEqual(third.json().code, 'rate_limited');
            assert.strictEqual(third.headers.get('cache-control'), 'private, no-store');
        } finally { await limited.close(); }
    });

    done();
})().catch((e) => { console.error(e); process.exit(1); });
