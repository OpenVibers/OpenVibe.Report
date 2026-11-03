'use strict';

/**
 * The shadow job: the same window from Network and from Report's tables. Equal numbers make one clean run with no
 * report_shadow_diffs rows; a changed number records exactly that difference, and GET /internal/shadow (loopback)
 * summarizes the latest run.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { stats, NOW } = require('./fixtures/analytics');

(async () => {
    const t = await boot({ db: true, now: () => NOW });
    try {
        await t.ctx.analytics.ingestStats(stats);

        await check('no difference when Network and Report answer the same numbers', async () => {
            const run = await t.ctx.shadow.compare({ days: 7, stats });
            assert.strictEqual(run.status, 'equal');
            assert.strictEqual(run.differences, 0);
            assert.ok(run.checked > 20, `checked ${run.checked}`);
            assert.strictEqual(await t.ctx.store.db.value('SELECT COUNT(*)::int AS n FROM report_shadow_diffs'), 0);
            assert.strictEqual(await t.ctx.store.db.value('SELECT COUNT(*)::int AS n FROM report_shadow_runs'), 1);
        });

        await check('a changed number is recorded once and the internal summary shows it', async () => {
            const changed = JSON.parse(JSON.stringify(stats));
            changed.totals.pageviews = 301;
            const run = await t.ctx.shadow.compare({ days: 7, stats: changed });
            assert.strictEqual(run.status, 'differences');
            assert.strictEqual(run.differences, 1);
            assert.strictEqual(run.diffs[0].metric, 'pageviews');
            assert.strictEqual(run.diffs[0].scope, 'network');
            assert.strictEqual(run.diffs[0].network_value, 301);
            assert.strictEqual(run.diffs[0].report_value, 300);
            assert.strictEqual(run.diffs[0].delta, -1);
            const r = await t.get('/internal/shadow?days=7');
            assert.strictEqual(r.status, 200);
            const body = r.json();
            assert.strictEqual(body.latest.status, 'differences');
            assert.strictEqual(body.latest.differences, 1);
            assert.strictEqual(body.diffs.length, 1);
            assert.strictEqual(body.diffs[0].metric, 'pageviews');
        });

        await check('the job compares the one Network answer it took in: a number that moved between two reads is no difference', async () => {
            const { createAnalyticsJobs } = require('../server/jobs/analytics');
            let reads = 0;
            // A rolling number moves on every read, as the last 24 hours' requests and today's pageviews do.
            const network = { stats: async () => { reads++; const s = JSON.parse(JSON.stringify(stats)); s.totals.pageviews = 300 + reads * 7; return s; } };
            const jobs = createAnalyticsJobs({ config: { jobs: { shadowWindowDays: 7 } }, analytics: t.ctx.analytics, shadow: t.ctx.shadow, network, log: { warn() {}, error() {} } });
            const run = await jobs.runShadow();
            assert.strictEqual(run.status, 'equal', JSON.stringify(run.diffs));
            assert.strictEqual(reads, 1, 'one read of Network serves both sides');
            assert.strictEqual(await t.ctx.store.db.value(`SELECT value::int AS v FROM report_metric_windows WHERE metric = 'pageviews' AND scope = 'network' AND window_days = 7`), 307, 'and Report took it in');
        });

        await check('today is still counting: its day rows are not compared; a finished day still is', async () => {
            const days = stats.pageviews_daily.map((p) => p.day);
            const today = new Date(NOW).toISOString().slice(0, 10);
            assert.strictEqual(days[days.length - 1], today, 'the fixture ends today');
            const moved = JSON.parse(JSON.stringify(stats));
            moved.pageviews_daily[moved.pageviews_daily.length - 1].n += 6;   // another window's later snapshot of today
            const same = await t.ctx.shadow.compare({ days: 7, stats: moved });
            assert.ok(!same.diffs.some((d) => d.day === today), JSON.stringify(same.diffs));
            const old = JSON.parse(JSON.stringify(stats));
            old.pageviews_daily[0].n += 1;
            const past = await t.ctx.shadow.compare({ days: 7, stats: old });
            assert.ok(past.diffs.some((d) => d.metric === 'pageviews' && d.day === days[0]), 'a finished day that differs is a difference');
        });

        await check('a Network that does not answer is a run with no differences, never a clean claim', async () => {
            const down = await t.ctx.shadow.compare({ days: 7, stats: null });
            assert.strictEqual(down.status, 'network_unavailable');
            assert.strictEqual(down.differences, 0);
            const r = await t.get('/internal/shadow');
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.json().latest.status, 'network_unavailable');
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
