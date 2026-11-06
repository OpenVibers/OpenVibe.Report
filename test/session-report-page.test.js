'use strict';
/**
 * Agent Streams S3: the report page, the Rundown's section and the Search document.
 *
 *   node test/session-report-page.test.js
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');
const { createSearchIndex } = require('../server/search-index');

const OWNER = 'usr_01JAN2C3D4E5F6G7H8J9K0MNPS';

function body(over = {}) {
    return {
        owner: OWNER,
        source: 'codes',
        task: { title: 'Ship the checkout page', ref: 'tsk_01JAN2C3D4E5F6G7H8J9K0MNPS' },
        started_at: '2026-11-06T18:00:00.000Z',
        ended_at: '2026-11-06T18:42:00.000Z',
        worked_seconds: 2520,
        outcome: 'done',
        summary: 'Asked for a checkout page; the agent built it and ran the tests.',
        timeline: [{ at: '2026-11-06T18:20:00.000Z', title: 'Run the tests', status: 'passed', tests: { passed: 12, failed: 0 } }],
        outputs: [
            { kind: 'pr', url: 'https://forgejo.example/openvibe/site/pulls/7', title: 'Checkout page', state: 'open' },
            { kind: 'vod', url: 'https://openvibe.video/v/vod_1', title: 'The recording' },
        ],
        proof: { tests: { passed: 12, failed: 0 }, screenshots: ['med_01JAN2C3D4E5F6G7H8J9K0MNPS'], review: { verdict: 'Looks good', notes: 'The mobile layout needs a wider gutter.' } },
        cost_usd: 0.31,
        models: ['claude-sonnet-4'],
        highlights: ['Found the coupon bug on the first read'],
        visibility: 'public',
        ...over,
    };
}

(async () => {
    const verifyServiceToken = async () => ({ ok: true, claims: { sub: 'svc:codes', cap: ['report.session.write'], aud: ['openvibe.report'] } });
    const t = await boot({ db: true, verifyServiceToken, now: () => Date.parse('2026-11-06T20:00:00Z') });
    try {
        const write = await t.get('/internal/session-reports', { json: body(), headers: { authorization: 'Bearer good' } });
        assert.strictEqual(write.status, 201);
        const id = write.json().id;

        await check('the page renders every part', async () => {
            const page = await t.get('/s/' + id);
            assert.strictEqual(page.status, 200);
            const text = page.text;
            for (const part of ['Ship the checkout page', 'What was asked', 'What came out', 'The proof', 'How it went', 'Watch', 'What to do']) {
                assert.ok(text.includes(part), part);
            }
            assert.ok(text.includes('Done'), 'the outcome is a status chip');
            assert.ok(text.includes('worked 42 min'), 'how long it worked');
            assert.ok(text.includes('$0.31'), 'what it cost');
            assert.ok(text.includes('12 of 12 tests passing') && text.includes('rp-proof-tests is-ok'), 'the tests, as one chip');
            assert.ok(text.includes('med_01JAN2C3D4E5F6G7H8J9K0MNPS'), 'the screenshots');
            assert.ok(text.includes('Looks good'), 'the review in one line');
            assert.ok(text.includes('The notes'), 'the notes are folded');
            assert.ok(text.includes('Checkout page'), 'the output');
            assert.ok(text.includes('Run the tests'), 'the step');
        });

        await check('the Rundown shows what agents built today, with a counted fold', async () => {
            // Nine public reports: the first eight are shown, the ninth is behind the fold, and the fold counts.
            for (let i = 2; i <= 9; i++) {
                const r = await t.get('/internal/session-reports', {
                    json: body({ task: { title: 'Report ' + i, ref: 'tsk_fold_' + i } }),
                    headers: { authorization: 'Bearer good' },
                });
                assert.strictEqual(r.status, 201);
            }
            const page = await t.get('/rundown');
            assert.strictEqual(page.status, 200);
            assert.ok(page.text.includes('What agents built today'), 'the section');
            assert.ok(page.text.includes('Ship the checkout page'), 'the report is in it');
            assert.ok(page.text.includes('/s/' + id), 'and it links to the report');
            assert.ok(page.text.includes('More (1)'), 'the fold counts what is behind it');
            assert.ok(page.text.includes('<b>9</b> reports'), 'and the section counts them all');
        });

        await check('the public report goes to Search, and only the public one', async () => {
            const searchIndex = createSearchIndex({
                config: t.config, store: t.ctx.store, live: { topics: async () => ({ topics: [] }) },
                sessionReports: t.ctx.sessionReports, log: { log() {}, warn() {} },
            });
            await searchIndex.sweep();
            const db = t.ctx.store.db;
            const outbox = (await db.many('SELECT envelope FROM event_outbox ORDER BY id')).map((r) => r.envelope);
            const docs = outbox.map((e) => e.payload).filter((p) => p && p.type === 'session');
            const doc = docs.find((d) => d.id === id);
            assert.ok(doc, 'the public report is a document');
            assert.strictEqual(doc.canonical_url, 'https://openvibe.report/s/' + id);
            assert.ok(doc.title.includes('Ship the checkout page'), 'the document says what the page says');
            const priv = await t.get('/internal/session-reports', {
                json: body({ task: { title: 'A private one', ref: 'tsk_private_1' }, visibility: 'private' }),
                headers: { authorization: 'Bearer good' },
            });
            await searchIndex.sweep();
            const docs2 = (await db.many('SELECT envelope FROM event_outbox ORDER BY id')).map((r) => r.envelope)
                .map((e) => e.payload).filter((p) => p && p.type === 'session');
            assert.ok(!docs2.some((d) => d.id === priv.json().id), 'a private report is never in Search');
            assert.ok(contracts.validate('search.index-document@1', doc).valid, 'the document fits the contract');
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
