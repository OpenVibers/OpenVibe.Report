'use strict';
/**
 * AI performance (plan L40/L41, ai-metrics.md): the per-call roll-ups the ingest adds, the time/cost histograms, the
 * 20-call public floor, the staff groups, the task cost and time, and every row against report.ai-performance@1.
 */
const assert = require('assert');
const crypto = require('crypto');
const contracts = require('openvibe-contracts');
const { signDeliveryV2 } = require('openvibe-sdk/events');
const { serviceAuth } = require('openvibe-contracts');
const { createSsoClient } = require('openvibe-sdk/sso');
const { boot, check, done } = require('./helpers/boot');
const perf = require('../server/analytics/ai-performance');

const SECRET = 'test-report-events-secret-32-characters-long';
const ISSUER = 'https://openvibe.network';
const NOW = Date.parse('2026-10-31T12:00:00.000Z');
const AT = '2026-10-31T10:00:00.000Z';
const PERSON = 'usr_01JTESTPERF00000000000000';

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
const STAFF = personToken({ sub: '1', subject_id: PERSON, username: 'staffer', display_name: 'Staffer', role: 'admin' });
const PLAIN = personToken({ sub: '2', subject_id: 'usr_01JTESTPERF00000000000001', username: 'visitor', display_name: 'Visitor', role: 'user' });

/** A Network service token (the JSON operator gate). */
function serviceToken(cap) {
    const now = Math.floor(NOW / 1000);
    return serviceAuth.signServiceToken({
        iss: ISSUER, sub: 'svc:operator', actor_type: 'service', aud: ['openvibe.report'], cap, ns: ['*'],
        iat: now, exp: now + 300, jti: 'tok_aiperf_' + String(now).slice(-6),
    }, privateKey);
}

const sso = createSsoClient({
    site: 'report', baseUrl: 'https://openvibe.report', clientId: 'report', clientSecret: 'x',
    networkUrl: ISSUER, publicKey,
    log: { warn() {}, info() {}, log() {}, error() {} },
});

let seq = 0;
/** One ai.call.recorded@1 event with the 1.1.0 fields. */
function usageEvent(over = {}) {
    seq += 1;
    return {
        event_id: 'evt_AIPERF_' + String(seq).padStart(6, '0'),
        event_type: 'ai.call.recorded',
        source: 'ai',
        occurred_at: AT,
        payload: {
            subject: null, attribution: 'site:design', surface: 'ai.generate', system: 'ai',
            provider: 'anthropic', model: 'public-model', effort: null,
            paid_by: 'openvibe_key', paid_by_detail: null,
            input: 200, output: 100, reasoning: 0, cache_read: 800, cache_write: 0, cache_write_ttl: null,
            images: 0, audio_seconds: 0, video_seconds: 0,
            list_cost_usd: 0.001, charged_usd: 0.001, fee_usd: 0, cache_saved_usd: 0.0005,
            price_source: 'models', price_date: '2026-10-31',
            latency_ms: 1000, ttft_ms: 300, attempts: 1, outcome: 'succeeded',
            run_id: 'run_aiperf_' + String(seq), turn_id: null, at: AT,
            operation: 'chat', streamed: true, tps: 50, queue_ms: 5, task: 'chat.reply', task_id: null,
            task_ms: null, harness: 'openvibe', place: 'provider', error_class: null, fallbacks: 0,
            cache_hit: false, tool_calls: 1, region: 'us-east',
            ...over,
        },
    };
}

function delivery(event) {
    const raw = JSON.stringify({ event });
    const ts = Math.floor(NOW / 1000);
    return { raw, headers: { 'content-type': 'application/json', 'x-openvibe-timestamp': String(ts), 'x-openvibe-signature-v2': signDeliveryV2(raw, SECRET, ts) } };
}

const upper = (hist, bounds, p) => perf.percentile(hist, bounds, p);

(async () => {
    const t = await boot({ db: true, now: () => NOW, env: { REPORT_EVENTS_SECRET: SECRET, OV_NETWORK_PUBLIC_KEY: publicKey }, sso });
    const db = t.ctx.store.db;
    try {
        await check('a percentile is the upper bound of the bucket the call lands in, and empty is null', async () => {
            const hist = perf.zeroHist();
            hist[perf.bucketOf(300, perf.HISTOGRAM_BOUNDS.ttft)] = 10;
            assert.strictEqual(perf.percentile(hist, perf.HISTOGRAM_BOUNDS.ttft, 50), perf.HISTOGRAM_BOUNDS.ttft[perf.bucketOf(300, perf.HISTOGRAM_BOUNDS.ttft)]);
            assert.strictEqual(perf.percentile(perf.zeroHist(), perf.HISTOGRAM_BOUNDS.ttft, 50), null);
            const spread = perf.zeroHist();
            spread[perf.bucketOf(100, perf.HISTOGRAM_BOUNDS.latency)] = 90;
            spread[perf.bucketOf(5000, perf.HISTOGRAM_BOUNDS.latency)] = 10;
            assert.strictEqual(perf.percentile(spread, perf.HISTOGRAM_BOUNDS.latency, 90), perf.HISTOGRAM_BOUNDS.latency[perf.bucketOf(100, perf.HISTOGRAM_BOUNDS.latency)]);
            assert.strictEqual(perf.percentile(spread, perf.HISTOGRAM_BOUNDS.latency, 95), perf.HISTOGRAM_BOUNDS.latency[perf.bucketOf(5000, perf.HISTOGRAM_BOUNDS.latency)]);
        });

        await check('the ingest adds to the performance roll-up in the same transaction, and a replay changes nothing', async () => {
            const events = [];
            for (let i = 0; i < 20; i += 1) {
                const failed = i < 2;
                events.push(usageEvent(failed
                    ? { outcome: 'failed', error_class: i === 0 ? 'timeout' : 'rate_limited', ttft_ms: null, tps: null, latency_ms: 2000, streamed: true }
                    : { cache_hit: i === 19 }));
            }
            for (const e of events) {
                const d = delivery(e);
                const r = await t.get('/internal/events', { method: 'POST', headers: d.headers, body: d.raw });
                assert.strictEqual(r.status, 200, r.text);
                assert.strictEqual(r.json().outcome, 'usage:recorded', r.text);
            }
            const row = (await db.query("SELECT * FROM report_ai_perf_days WHERE model = 'public-model'")).rows[0];
            assert.strictEqual(Number(row.calls), 20);
            assert.strictEqual(Number(row.succeeded), 18);
            assert.strictEqual(Number(row.errors), 2);
            assert.strictEqual(Number(row.streamed), 20);
            assert.strictEqual(Number(row.cache_hits), 1);
            assert.strictEqual(Number(row.tool_calls), 20);
            assert.strictEqual(Number(row.tokens_input), 4000);
            assert.strictEqual(Number(row.tokens_output), 2000);
            assert.deepStrictEqual(row.errors_by_class, { timeout: 1, rate_limited: 1 });
            const ttft = perf.asHist(row.ttft_hist);
            assert.strictEqual(ttft.reduce((a, b) => a + b, 0), 18, 'the two failures measured no TTFT');
            assert.strictEqual(ttft[perf.bucketOf(300, perf.HISTOGRAM_BOUNDS.ttft)], 18);
            const replay = delivery(events[0]);
            const again = await t.get('/internal/events', { method: 'POST', headers: replay.headers, body: replay.raw });
            assert.strictEqual(again.json().duplicate, true);
            assert.strictEqual(Number((await db.query("SELECT calls FROM report_ai_perf_days WHERE model = 'public-model'")).rows[0].calls), 20, 'the replay counted nothing twice');
            assert.strictEqual(await db.value('SELECT COUNT(*)::int AS n FROM report_ai_usage'), 20);        });

        await check('19 calls are below the public floor, 20 are shown and every row matches report.ai-performance@1', async () => {
            for (let i = 0; i < 19; i += 1) {
                const e = usageEvent({ model: 'floor-model' });
                const d = delivery(e);
                const r = await t.get('/internal/events', { method: 'POST', headers: d.headers, body: d.raw });
                assert.strictEqual(r.status, 200, r.text);
            }
            const publicRows = (await t.get('/api/v1/ai/performance?group=model&days=7')).json();
            assert.strictEqual(publicRows.group, 'model');
            assert.strictEqual(publicRows.rows.length, 1, 'only the 20-call model is public');
            assert.strictEqual(publicRows.rows[0].key, 'public-model');
            assert.strictEqual(publicRows.rows[0].calls, 20);
            assert.strictEqual(publicRows.rows[0].succeeded, 18);
            assert.strictEqual(publicRows.rows[0].success_rate, 0.9);
            assert.strictEqual(publicRows.rows[0].cache_read_share, 0.8);
            assert.strictEqual(publicRows.rows[0].ttft_ms.p50, perf.HISTOGRAM_BOUNDS.ttft[perf.bucketOf(300, perf.HISTOGRAM_BOUNDS.ttft)]);
            assert.strictEqual(publicRows.rows[0].latency_ms.p95, perf.HISTOGRAM_BOUNDS.latency[perf.bucketOf(2000, perf.HISTOGRAM_BOUNDS.latency)]);
            assert.deepStrictEqual(publicRows.rows[0].top_errors.map((e) => e.error_class).sort(), ['rate_limited', 'timeout']);
            for (const row of publicRows.rows) {
                const v = contracts.validate('report.ai-performance@1', row);
                assert.strictEqual(v.valid, true, JSON.stringify(v.errors));
                assert.ok(!('system' in row) && !('task' in row) && !('subject' in row), 'a public row names no system, task or person');
            }
            for (const group of ['provider', 'operation']) {
                const answer = await t.get(`/api/v1/ai/performance?group=${group}&days=7`);
                assert.strictEqual(answer.status, 200, answer.text);
                assert.ok(answer.json().rows.length >= 1, group);
                for (const row of answer.json().rows) {
                    const v = contracts.validate('report.ai-performance@1', row);
                    assert.strictEqual(v.valid, true, group + ' ' + JSON.stringify(v.errors));
                    assert.ok(!('system' in row) && !('task' in row) && !('subject' in row), group + ' names no system, task or person');
                }
            }
        });

        await check('the staff groups are refused to the public and the service gate', async () => {
            const none = await t.get('/api/v1/ai/performance?group=system&days=7');
            assert.strictEqual(none.status, 401, none.text);
            assert.strictEqual(none.json().code, 'auth.sign_in_required');
            assert.strictEqual(none.headers.get('cache-control'), 'private, no-store');
            const plain = await t.get('/api/v1/ai/performance?group=system&days=7', { headers: { cookie: `ov_token=${PLAIN}` } });
            assert.strictEqual(plain.status, 403, plain.text);
            assert.strictEqual(plain.json().code, 'capability.denied');
            const wrong = await t.get('/api/v1/ai/performance?group=system&days=7', { headers: { authorization: 'Bearer ' + serviceToken(['report.other.read']) } });
            assert.strictEqual(wrong.status, 403, wrong.text);
            assert.strictEqual(wrong.json().code, 'capability.denied');
            const publicFilter = await t.get('/api/v1/ai/performance?group=model&days=7&system=ai');
            assert.strictEqual(publicFilter.status, 403, 'system is a staff filter');
            assert.strictEqual((await t.get('/api/v1/ai/performance?group=nope')).status, 422);
            assert.strictEqual((await t.get('/api/v1/ai/performance?group=model&days=8')).status, 422);
        });

        await check('staff see system, place and harness, each row valid, and the service token reads them too', async () => {
            const cookie = { headers: { cookie: `ov_token=${STAFF}` } };
            for (const group of ['system', 'place', 'harness']) {
                const r = await t.get(`/api/v1/ai/performance?group=${group}&days=30`, cookie);
                assert.strictEqual(r.status, 200, r.text);
                assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
                assert.ok(r.json().rows.length >= 1, group);
                for (const row of r.json().rows) {
                    const v = contracts.validate('report.ai-performance@1', row);
                    assert.strictEqual(v.valid, true, group + ' ' + JSON.stringify(v.errors));
                }
            }
            const systems = (await t.get('/api/v1/ai/performance?group=system&days=30', cookie)).json().rows;
            const ai = systems.find((r) => r.key === 'ai');
            assert.strictEqual(ai.calls, 39, 'the 20 public-model and 19 floor-model calls are in the ai system');
            const service = await t.get('/api/v1/ai/performance?group=place&days=30', { headers: { authorization: 'Bearer ' + serviceToken(['report.ai_usage.read']) } });
            assert.strictEqual(service.status, 200, service.text);
            assert.strictEqual(service.headers.get('cache-control'), 'private, no-store');
            assert.ok(service.json().rows.some((r) => r.key === 'provider'));
        });

        await check('a task is its calls: count, cost and time from task_ms when given, else the summed latency', async () => {
            const add = async (over) => {
                const e = usageEvent(over);
                const d = delivery(e);
                const r = await t.get('/internal/events', { method: 'POST', headers: d.headers, body: d.raw });
                assert.strictEqual(r.status, 200, r.text);
            };
            await add({ model: 'task-model', system: 'harness:codex', harness: 'codex', task: 'code.turn', task_id: 'task_A', task_ms: null, latency_ms: 700, charged_usd: 0.01 });
            await add({ model: 'task-model', system: 'harness:codex', harness: 'codex', task: 'code.turn', task_id: 'task_A', task_ms: 1500, latency_ms: 800, charged_usd: 0.02 });
            await add({ model: 'task-model', system: 'harness:codex', harness: 'codex', task: 'code.turn', task_id: 'task_B', task_ms: 900, latency_ms: 500, charged_usd: 0.005 });
            const stored = (await db.query("SELECT * FROM report_ai_task_days WHERE task = 'code.turn'")).rows[0];
            assert.strictEqual(Number(stored.tasks), 2, 'two task ids');
            const cost = perf.asHist(stored.cost_hist);
            const time = perf.asHist(stored.time_hist);
            assert.strictEqual(cost.reduce((a, b) => a + b, 0), 2);
            assert.strictEqual(time.reduce((a, b) => a + b, 0), 2);
            assert.strictEqual(cost[perf.bucketOf(0.005, perf.HISTOGRAM_BOUNDS.task_cost_usd)], 1);
            assert.strictEqual(cost[perf.bucketOf(0.03, perf.HISTOGRAM_BOUNDS.task_cost_usd)], 1);
            assert.strictEqual(time[perf.bucketOf(900, perf.HISTOGRAM_BOUNDS.task_time_ms)], 1);
            assert.strictEqual(time[perf.bucketOf(1500, perf.HISTOGRAM_BOUNDS.task_time_ms)], 1);
            const r = await t.get('/api/v1/ai/performance?group=task&days=30', { headers: { cookie: `ov_token=${STAFF}` } });
            assert.strictEqual(r.status, 200, r.text);
            const row = r.json().rows.find((x) => x.key === 'code.turn');
            assert.ok(row, 'the task kind is answered');
            assert.strictEqual(row.tasks.count, 2);
            assert.strictEqual(row.tasks.time_per_task_ms.p50, perf.HISTOGRAM_BOUNDS.task_time_ms[perf.bucketOf(900, perf.HISTOGRAM_BOUNDS.task_time_ms)], 'the middle task is 900 ms, answered as its bucket upper bound');
            assert.strictEqual(row.tasks.time_per_task_ms.p95, perf.HISTOGRAM_BOUNDS.task_time_ms[perf.bucketOf(1500, perf.HISTOGRAM_BOUNDS.task_time_ms)]);
            assert.strictEqual(row.tasks.cost_per_task_usd.p50, perf.HISTOGRAM_BOUNDS.task_cost_usd[perf.bucketOf(0.005, perf.HISTOGRAM_BOUNDS.task_cost_usd)]);
            const v = contracts.validate('report.ai-performance@1', row);
            assert.strictEqual(v.valid, true, JSON.stringify(v.errors));
            const systems = (await t.get('/api/v1/ai/performance?group=system&days=30', { headers: { cookie: `ov_token=${STAFF}` } })).json().rows;
            const codex = systems.find((x) => x.key === 'harness:codex');
            assert.strictEqual(codex.calls, 3);
            assert.strictEqual(codex.tasks.count, 2);
            assert.strictEqual(codex.tasks.time_per_task_ms.p50, perf.HISTOGRAM_BOUNDS.task_time_ms[perf.bucketOf(900, perf.HISTOGRAM_BOUNDS.task_time_ms)]);
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
