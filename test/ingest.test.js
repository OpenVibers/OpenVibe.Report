'use strict';

/**
 * Ingest is idempotent: a repeated event id and a repeated stats snapshot change no row. The stream event writes
 * its own facts and its channel/day counts; the frame beacon is a daily total, not a page view per request.
 */
const assert = require('assert');
const { testDb } = require('./helpers/db');
const { createStore } = require('../server/db');
const { recordEvent, ingestStats } = require('../server/analytics/ingest');
const { streams, stats, NOW, DAYS } = require('./fixtures/analytics');
const { check, done } = require('./helpers/boot');

(async () => {
    const testdatabase = await testDb();
    const store = createStore(testdatabase.db, { now: () => NOW });
    try {
        await check('a repeated live.stream.ended changes nothing: one inbox row, one stream, one stream count', async () => {
            const a = await recordEvent(store, streams[0]);
            const b = await recordEvent(store, streams[0]);
            assert.strictEqual(a.duplicate, false);
            assert.strictEqual(b.duplicate, true);
            assert.strictEqual(await store.db.value('SELECT COUNT(*)::int AS n FROM report_inbox WHERE consumer = $1', ['report-events']), 1);
            assert.strictEqual(await store.db.value('SELECT COUNT(*)::int AS n FROM report_events'), 1);
            assert.strictEqual(await store.db.value('SELECT COUNT(*)::int AS n FROM report_streams'), 1);
            assert.strictEqual(await store.db.value("SELECT value::int AS n FROM report_metric_days WHERE scope = 'channel' AND scope_id = 'goosely' AND metric = 'streams' AND day = '2026-10-26'"), 1);
            assert.strictEqual(await store.db.value("SELECT value::int AS n FROM report_metric_days WHERE scope = 'channel' AND scope_id = 'goosely' AND metric = 'messages' AND day = '2026-10-26'"), 120);
        });

        await check('a second stream adds to the channel day but a redelivery with a new event id does not', async () => {
            await recordEvent(store, streams[1]);
            assert.strictEqual(await store.db.value("SELECT value::int AS n FROM report_metric_days WHERE scope = 'channel' AND scope_id = 'goosely' AND metric = 'streams' AND day = '2026-10-27'"), 1);
            const corrected = JSON.parse(JSON.stringify(streams[1]));
            corrected.event_id = 'evt_TESTSTREAM102CORRECTED';
            const out = await recordEvent(store, corrected);
            assert.strictEqual(out.outcome, 'stream:updated');
            assert.strictEqual(await store.db.value("SELECT value::int AS n FROM report_metric_days WHERE scope = 'channel' AND scope_id = 'goosely' AND metric = 'streams' AND day = '2026-10-27'"), 1, 'a corrected stream must not be counted twice');
            assert.strictEqual(await store.db.value('SELECT COUNT(*)::int AS n FROM report_streams'), 2);
        });

        await check('a repeated stats snapshot is a no-op; the first one writes every day and window', async () => {
            const a = await ingestStats(store, stats);
            const b = await ingestStats(store, stats);
            assert.strictEqual(a.duplicate, false);
            assert.strictEqual(b.duplicate, true);
            assert.ok(a.rows > 20, `expected many metric rows, got ${a.rows}`);
            const dayRows = await store.db.value("SELECT COUNT(*)::int AS n FROM report_metric_days WHERE scope = 'network' AND metric IN ('pageviews', 'accounts_new', 'coins_earned')");
            assert.strictEqual(dayRows, DAYS.length * 3);
            assert.strictEqual(await store.db.value("SELECT value::int AS n FROM report_metric_windows WHERE scope = 'network' AND metric = 'pageviews' AND window_days = 7"), 300);
            assert.strictEqual(await store.db.value("SELECT value::int AS n FROM report_metric_days WHERE scope = 'site' AND scope_id = 'network' AND metric = 'pageviews' AND day = '2026-10-28'"), 60);
            assert.strictEqual(await store.db.value("SELECT SUM(hits)::int AS n FROM report_frame_days WHERE host = 'openvibe.network'"), 200);
        });

        await check('the frame beacon stays one daily total, while a single hit adds once', async () => {
            const day = { event_id: 'evt_TESTFRAME1', event_type: 'network.frame.day', source: 'network', occurred_at: '2026-10-28T12:00:00.000Z', payload: { day: '2026-10-28', host: 'openvibe.tools', hits: 40 } };
            await recordEvent(store, day);
            await recordEvent(store, day);
            assert.strictEqual(await store.db.value("SELECT hits::int AS n FROM report_frame_days WHERE day = '2026-10-28' AND host = 'openvibe.tools'"), 40);
            const hit = { event_id: 'evt_TESTFRAME2', event_type: 'network.frame.hit', source: 'network', occurred_at: '2026-10-28T12:00:01.000Z', payload: { day: '2026-10-28', host: 'openvibe.tools' } };
            await recordEvent(store, hit);
            await recordEvent(store, hit);
            assert.strictEqual(await store.db.value("SELECT hits::int AS n FROM report_frame_days WHERE day = '2026-10-28' AND host = 'openvibe.tools'"), 41);
        });
    } finally {
        await testdatabase.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
