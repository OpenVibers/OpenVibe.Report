'use strict';
/**
 * Agent Streams S3: the report of every agent session.
 *
 *   node test/session-reports.test.js
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const OWNER = 'usr_01JAN2C3D4E5F6G7H8J9K0MNPS';
const TASK = { title: 'Ship the checkout page', ref: 'tsk_01JAN2C3D4E5F6G7H8J9K0MNPS' };

function body(over = {}) {
    return {
        owner: OWNER,
        source: 'codes',
        task: TASK,
        started_at: '2026-11-06T18:00:00.000Z',
        ended_at: '2026-11-06T18:42:00.000Z',
        worked_seconds: 2520,
        outcome: 'done',
        summary: 'Asked for a checkout page; the agent built it and ran the tests.',
        timeline: [{ at: '2026-11-06T18:20:00.000Z', title: 'Run the tests', status: 'passed' }],
        outputs: [{ kind: 'pr', url: 'https://forgejo.example/openvibe/site/pulls/7', title: 'Checkout page' }],
        proof: { tests: { passed: 12, failed: 0 }, screenshots: [], review: null },
        cost_usd: 0.31,
        models: ['claude-sonnet-4'],
        highlights: ['Found the coupon bug on the first read'],
        visibility: 'private',
        ...over,
    };
}

(async () => {
    const tokens = { good: null, weak: null, none: null };
    const verifyServiceToken = async (token) => {
        if (!token) return { ok: false, code: 'token.required', reason: 'no token' };
        if (token === 'weak') return { ok: true, claims: { sub: 'svc:codes', cap: ['live.agent_stream.publish'], aud: ['openvibe.report'] } };
        return { ok: true, claims: { sub: 'svc:codes', cap: ['report.session.write'], aud: ['openvibe.report'] } };
    };
    const t = await boot({ db: true, verifyServiceToken, now: () => Date.parse('2026-11-06T20:00:00Z') });
    try {
        await check('the door needs a service token', async () => {
            const r = await t.get('/internal/session-reports', { json: body() });
            assert.strictEqual(r.status, 401);
        });

        await check('a token without the capability is refused', async () => {
            const r = await t.get('/internal/session-reports', { json: body(), headers: { authorization: 'Bearer weak' } });
            assert.strictEqual(r.status, 403);
            assert.strictEqual(r.json().error, 'capability.forbidden');
        });

        await check('a service with the capability writes the report', async () => {
            const r = await t.get('/internal/session-reports', { json: body(), headers: { authorization: 'Bearer good' } });
            assert.strictEqual(r.status, 201);
            const out = r.json();
            assert.ok(/^rps_[0-9A-HJKMNP-TV-Z]{26}$/.test(out.id), out.id);
            assert.strictEqual(out.url, 'https://openvibe.report/s/' + out.id);
            assert.strictEqual(out.created, true);
            tokens.good = out.id;
        });

        await check('the write is idempotent per source and task ref', async () => {
            const r = await t.get('/internal/session-reports', { json: body(), headers: { authorization: 'Bearer good' } });
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.json().id, tokens.good, 'the same task answers the same report');
            assert.strictEqual(r.json().created, false);
        });

        await check('the house redactor runs over every text field', async () => {
            const secret = 'sk-ant-api03-REALSECRETVALUE1234567890';
            const r = await t.get('/internal/session-reports', {
                json: body({
                    task: { title: 'Ship it', ref: 'tsk_redact_1' },
                    summary: 'It ran with ' + secret + ' and read OPENAI_API_KEY=sk-live-abcdefghijklmnop from the .env file.',
                    highlights: ['key ' + secret],
                    timeline: [{ at: '2026-11-06T18:00:00.000Z', title: 'Read ' + secret, status: 'passed' }],
                }),
                headers: { authorization: 'Bearer good' },
            });
            assert.strictEqual(r.status, 201);
            const rep = await t.ctx.sessionReports.get(r.json().id);
            assert.ok(rep, 'the report is stored');
            assert.ok(!rep.summary.includes(secret), 'the secret is not in the summary');
            assert.ok(!/sk-live-abcdefghijklmnop/.test(rep.summary), 'the .env value is not in the summary');
            assert.ok(!rep.highlights.join(' ').includes(secret), 'the secret is not in the highlights');
            assert.ok(!rep.timeline.map((s) => s.title).join(' ').includes(secret), 'the secret is not in the steps');
        });

        await check('a private report is never listed', async () => {
            const listed = await t.ctx.sessionReports.listPublic({ limit: 50 });
            assert.ok(!listed.some((rep) => rep.id === tokens.good), 'a private report is not public');
            const page = await t.get('/s/' + tokens.good);
            assert.strictEqual(page.status, 404, 'a private report is not a page for anyone else');
        });

        await check('an unlisted report opens for anyone with the link', async () => {
            const r = await t.get('/internal/session-reports', {
                json: body({ task: { title: 'Unlisted one', ref: 'tsk_unlisted_1' }, visibility: 'unlisted' }),
                headers: { authorization: 'Bearer good' },
            });
            assert.strictEqual(r.status, 201);
            const page = await t.get('/s/' + r.json().id);
            assert.strictEqual(page.status, 200);
            assert.ok(page.text.includes('Unlisted one'), 'the page shows the task');
            assert.ok(page.text.includes('What was asked'), 'the page has the summary part');
            assert.ok(page.text.includes('The proof'), 'the page has the proof part');
            assert.ok(page.text.includes('How it went'), 'the page has the steps part');
            assert.ok(page.text.includes('What to do'), 'the page has the actions part');
            const listed = await t.ctx.sessionReports.listPublic({ limit: 50 });
            assert.ok(!listed.some((rep) => rep.id === r.json().id), 'an unlisted report is not listed');
        });

        await check('a public report is in the Rundown section and the sitemap', async () => {
            const r = await t.get('/internal/session-reports', {
                json: body({ task: { title: 'Public one', ref: 'tsk_public_1' }, visibility: 'public' }),
                headers: { authorization: 'Bearer good' },
            });
            assert.strictEqual(r.status, 201);
            const id = r.json().id;
            const rundown = await t.get('/rundown');
            const sm = await t.get('/sitemap.xml');
            assert.ok(sm.text.includes('/s/' + id), 'the sitemap has the public report');
            const listed = await t.ctx.sessionReports.listPublic({ limit: 50 });
            assert.ok(listed.some((rep) => rep.id === id), 'the public report is listed');
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
