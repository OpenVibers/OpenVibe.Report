'use strict';

/**
 * REPORT_SOURCE switches the answer: `network` (default) keeps today's Network numbers; `report` answers the same
 * route and the same page from Report's tables. A report source with no data is a 404, not a made-up zero.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { stats, expected, NOW } = require('./fixtures/analytics');

(async () => {
    const network = await boot({ now: () => NOW });
    try {
        await check('the default source is network: GET /api/v1/stats and /stats stay on Network', async () => {
            assert.strictEqual(network.config.source, 'network');
            const api = await network.get('/api/v1/stats?days=7');
            assert.strictEqual(api.status, 200);
            assert.strictEqual(api.json().totals.pageviews, 77408);
            const page = await network.get('/stats?days=7');
            assert.strictEqual(page.status, 200);
            assert.ok(page.text.includes('77,408'));
        });
    } finally { await network.close(); }

    const report = await boot({ db: true, now: () => NOW, env: { REPORT_SOURCE: 'report' } });
    try {
        await report.ctx.analytics.ingestStats(stats);
        await check('REPORT_SOURCE=report answers the stats API from Report', async () => {
            assert.strictEqual(report.config.source, 'report');
            const r = await report.get('/api/v1/stats?days=7');
            assert.strictEqual(r.status, 200);
            assert.deepStrictEqual(r.json().totals, expected.totals);
            assert.strictEqual(r.json().totals.pageviews, 300);
            assert.notStrictEqual(r.json().totals.pageviews, 77408);
        });
        await check('REPORT_SOURCE=report answers the /stats page from Report', async () => {
            const r = await report.get('/stats?days=7');
            assert.strictEqual(r.status, 200);
            assert.ok(r.text.includes('300'), 'the report page views are on the page');
            assert.ok(!r.text.includes('77,408'), 'the Network stub must not be read when the source is report');
        });
    } finally { await report.close(); }

    const empty = await boot({ db: true, now: () => NOW, env: { REPORT_SOURCE: 'report' } });
    try {
        await check('a report source with no rows is 404, not zeroes', async () => {
            const r = await empty.get('/api/v1/stats?days=7');
            assert.strictEqual(r.status, 404);
            assert.match(r.headers.get('content-type') || '', /^application\/problem\+json/);
        });
    } finally { await empty.close(); }

    done();
})().catch((e) => { console.error(e); process.exit(1); });
