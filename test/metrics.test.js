'use strict';

/**
 * Every metric the Report pages and openvibe.network/stats show, computed from a fixture and compared with the
 * fixture's own expected numbers: the network totals, the day series, every site, every channel by day, and the
 * Billing revenue read (stubbed) that Report quotes rather than calculates.
 */
const assert = require('assert');
const { testDb } = require('./helpers/db');
const { createStore } = require('../server/db');
const { recordEvent, ingestStats } = require('../server/analytics/ingest');
const { reportStats, channelStats, metrics } = require('../server/analytics/query');
const { streams, stats, expected, expectedChannel, NOW, SUBJECT, billingTransactions } = require('./fixtures/analytics');
const { check, done } = require('./helpers/boot');

function billingStub() {
    const calls = [];
    return {
        calls,
        async revenue({ subject, days }) {
            calls.push({ subject, days });
            let settled = 0; let refunded = 0; let transactions = 0;
            for (const txn of billingTransactions.transactions) {
                if (txn.test) continue;
                let seen = false;
                for (const e of txn.entries) {
                    if (e.account.kind !== 'creator_payable') continue;
                    seen = true;
                    if (e.amount > 0) settled += e.amount; else refunded += -e.amount;
                }
                if (seen) transactions++;
            }
            return { source: 'billing', capability: 'billing.balance.read', subject, days, currency: 'vibes-bits', settled_bits: settled, refunded_bits: refunded, net_bits: settled - refunded, transactions };
        },
    };
}

(async () => {
    const testdatabase = await testDb();
    const store = createStore(testdatabase.db, { now: () => NOW });
    const billing = billingStub();
    try {
        await ingestStats(store, stats);
        for (const event of streams) await recordEvent(store, event);

        await check('network stats: totals, day series, accounts, coins, live and busiest pages match the fixture', async () => {
            const got = await reportStats(store, 7, { now: () => NOW });
            assert.ok(got, 'no stats computed');
            assert.strictEqual(got.generated_at, expected.generated_at);
            assert.strictEqual(got.window_days, 7);
            assert.deepStrictEqual(got.totals, expected.totals);
            assert.deepStrictEqual(got.pageviews_daily, expected.pageviews_daily);
            assert.deepStrictEqual(got.accounts, expected.accounts);
            assert.deepStrictEqual(got.coins, expected.coins);
            assert.deepStrictEqual(got.live, expected.live);
            assert.deepStrictEqual(got.busiest_pages_24h, expected.busiest_pages_24h);
        });

        await check('every site: page views, change, daily series, visitors and 24-hour traffic', async () => {
            const got = await reportStats(store, 7, { now: () => NOW });
            assert.strictEqual(got.sites.length, 2);
            const network = got.sites.find((s) => s.id === 'network');
            const live = got.sites.find((s) => s.id === 'live');
            assert.strictEqual(network.pageviews, 200);
            assert.strictEqual(network.pageviews_prev, 150);
            assert.strictEqual(network.change_pct, 33);
            assert.strictEqual(network.unique_visitors, 20);
            assert.deepStrictEqual(network.traffic_24h, { requests: 800, server_errors: 2, p95_ms: 120 });
            assert.strictEqual(network.daily.length, 7);
            assert.deepStrictEqual(network.daily.map((d) => d.n), [20, 20, 20, 20, 20, 40, 60]);
            assert.strictEqual(live.pageviews, 100);
            assert.strictEqual(live.pageviews_prev, 50);
            assert.strictEqual(live.unique_visitors, 30);
            assert.strictEqual(live.signed_in_people, 10);
            assert.strictEqual(live.daily, null, 'Live counts its own visits: no navbar day series');
            assert.strictEqual(live.traffic_24h, null);
        });

        await check('a channel by day: streams, seconds, peak, chatters, messages, watch minutes and weighted average', async () => {
            const got = await channelStats(store, 'goosely', 7, { now: () => NOW, billing });
            assert.ok(got, 'no channel analytics');
            assert.strictEqual(got.creator, SUBJECT);
            assert.strictEqual(got.channel, 'goosely');
            assert.deepStrictEqual(got.totals, expectedChannel.totals);
            assert.deepStrictEqual(got.daily, expectedChannel.daily);
            assert.deepStrictEqual(got.streams.map((s) => s.stream_id), [102, 101]);
        });

        await check('Billing revenue is quoted with its capability and never derived from an event', async () => {
            const before = billing.calls.length;
            const got = await channelStats(store, 'goosely', 7, { now: () => NOW, billing });
            assert.deepStrictEqual(got.revenue, {
                source: 'billing', capability: 'billing.balance.read', subject: SUBJECT, days: 7, currency: 'vibes-bits',
                settled_bits: 500, refunded_bits: 100, net_bits: 400, transactions: 2,
            });
            assert.strictEqual(billing.calls.length, before + 1);
        });

        await check('the flat report.metric@1 view exposes the same numbers in windows and days', async () => {
            const got = await metrics(store, { scope: 'network', scopeId: 'network', days: 7, now: () => NOW });
            assert.strictEqual(got.window_days, 7);
            const pageviews = got.windows.find((m) => m.metric === 'pageviews');
            assert.strictEqual(pageviews.value, 300);
            assert.strictEqual(pageviews.unit, 'count');
            const daily = got.metrics.filter((m) => m.metric === 'pageviews');
            assert.strictEqual(daily.length, 7);
            assert.strictEqual(daily[daily.length - 1].value, 60);
            const channel = await metrics(store, { scope: 'channel', scopeId: 'goosely', days: 7, now: () => NOW });
            assert.strictEqual(channel.metrics.find((m) => m.metric === 'streams' && m.day === '2026-10-26').value, 1);
        });

        await check('a window with no numbers is null, not zeroes', async () => {
            assert.strictEqual(await reportStats(store, 90, { now: () => Date.parse('2025-01-01T00:00:00Z') }), null);
        });
    } finally {
        await testdatabase.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
