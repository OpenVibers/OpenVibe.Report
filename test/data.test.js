'use strict';

/**
 * The two source clients: a cache hit is one fetch, an expiry is another, a failure is null with one short log
 * line, and a path parameter that cannot exist is refused before any fetch. The clock is injected; no test waits.
 */
const assert = require('assert');
const { createNetworkClient } = require('../server/data/network');
const { createLiveClient } = require('../server/data/live');
const { isSlug, isStreamId, isUsername, normaliseDays } = require('../server/data/source');
const { jsonResponse, check, done } = require('./helpers/boot');

const quiet = () => ({ warn() {}, error() {} });

(async () => {
    await check('network stats: the same window twice is one fetch, and the entry expires after five minutes', async () => {
        let now = 1_000_000;
        let calls = 0;
        const client = createNetworkClient({
            config: { networkUrl: 'http://network' },
            fetchImpl: async () => { calls++; return jsonResponse({ window_days: 7, totals: { pageviews: 1 } }); },
            now: () => now,
            log: quiet(),
        });
        const first = await client.stats(7);
        const second = await client.stats(7);
        assert.deepStrictEqual(first, { window_days: 7, totals: { pageviews: 1 } });
        assert.strictEqual(first, second);
        assert.strictEqual(calls, 1, 'a cache hit must not fetch');
        now += 5 * 60_000 + 1;
        await client.stats(7);
        assert.strictEqual(calls, 2, 'an expired entry must fetch again');
    });

    await check('network stats: days other than 7, 30 or 90 become 30, in the request and in the cache key', async () => {
        const urls = [];
        const client = createNetworkClient({
            config: { networkUrl: 'http://network' },
            fetchImpl: async (url) => { urls.push(String(url)); return jsonResponse({ window_days: 30 }); },
            now: () => 0,
            log: quiet(),
        });
        await client.stats('90');
        await client.stats(31);
        await client.stats('nonsense');
        assert.deepStrictEqual(urls, ['http://network/api/v1/stats?days=90', 'http://network/api/v1/stats?days=30']);
        assert.strictEqual(normaliseDays('7'), 7);
        assert.strictEqual(normaliseDays(30), 30);
        assert.strictEqual(normaliseDays('31'), 30);
    });

    await check('a source failure is null, never a throw, with one short log line', async () => {
        const lines = [];
        const client = createLiveClient({
            config: { liveUrl: 'http://live' },
            fetchImpl: async () => new Response('down', { status: 503 }),
            log: { warn: (line) => lines.push(String(line)), error: (line) => lines.push(String(line)) },
        });
        assert.strictEqual(await client.rundown(), null);
        assert.strictEqual(lines.length, 1);
        assert.match(lines[0], /\[OpenVibe\.Report\] live rundown failed: HTTP 503/);

        const thrown = createLiveClient({
            config: { liveUrl: 'http://live' },
            fetchImpl: async () => { throw new Error('connect ECONNREFUSED'); },
            log: { warn: (line) => lines.push(String(line)) },
        });
        assert.strictEqual(await thrown.recap(12), null);
        assert.strictEqual(lines.length, 2);
        assert.match(lines[1], /live recap failed: connect ECONNREFUSED/);
    });

    await check('live: a slug, stream id or username that cannot exist is refused before any fetch', async () => {
        let calls = 0;
        const client = createLiveClient({
            config: { liveUrl: 'http://live' },
            fetchImpl: async () => { calls++; return jsonResponse({}); },
            log: quiet(),
        });
        assert.strictEqual(await client.topic('UPPER'), null);
        assert.strictEqual(await client.topic(''), null);
        assert.strictEqual(await client.topic('a/b'), null);
        assert.strictEqual(await client.topic('a'.repeat(81)), null);
        assert.strictEqual(await client.episode(0), null);
        assert.strictEqual(await client.episode(-1), null);
        assert.strictEqual(await client.episode('1.5'), null);
        assert.strictEqual(await client.episode('abc'), null);
        assert.strictEqual(await client.episode(null), null);
        assert.strictEqual(await client.speaker('bad name'), null);
        assert.strictEqual(await client.speaker('a'.repeat(33)), null);
        assert.strictEqual(await client.speaker('émile'), null);
        assert.strictEqual(await client.recap(0), null);
        assert.strictEqual(await client.recap('x'), null);
        assert.strictEqual(await client.channelRecaps('bad!'), null);
        assert.strictEqual(calls, 0, 'a bad parameter must never reach the source');
        assert.strictEqual(isSlug('a-valid-slug'), true);
        assert.strictEqual(isStreamId('42'), true);
        assert.strictEqual(isStreamId('0'), false);
        assert.strictEqual(isUsername('goosely'), true);
    });

    await check('live: each endpoint has its own TTL and its own URL', async () => {
        let now = 0;
        const urls = [];
        const client = createLiveClient({
            config: { liveUrl: 'http://live' },
            fetchImpl: async (url) => { urls.push(String(url)); return jsonResponse({ n: urls.length }); },
            now: () => now,
            log: quiet(),
        });
        await client.rundown();
        now += 2 * 60_000 + 1;
        await client.rundown();
        assert.strictEqual(urls.filter((u) => u.endsWith('/api/rundown/')).length, 2, 'the home is held for two minutes');

        await client.recap(7);
        now += 9 * 60_000;
        await client.recap(7);
        assert.strictEqual(urls.filter((u) => u.endsWith('/api/recap/7')).length, 1, 'a recap is held for ten minutes');
        now += 2 * 60_000;
        await client.recap(7);
        assert.strictEqual(urls.filter((u) => u.endsWith('/api/recap/7')).length, 2);

        await client.topic('seattle');
        await client.episode('007');
        await client.speaker('Goosely');
        await client.channelRecaps('goosely');
        assert.ok(urls.includes('http://live/api/rundown/t/seattle'));
        assert.ok(urls.includes('http://live/api/rundown/e/7'), 'a stream id is normalised to a positive integer');
        assert.ok(urls.includes('http://live/api/rundown/s/Goosely'));
        assert.ok(urls.includes('http://live/api/recap/channel/goosely'));

        // speaker is cached by the lower-cased name: the same person under another case is one fetch.
        const before = urls.filter((u) => u.includes('/api/rundown/s/')).length;
        await client.speaker('goosely');
        assert.strictEqual(urls.filter((u) => u.includes('/api/rundown/s/')).length, before);
    });

    await check('the cache keeps 1000 entries and drops the oldest first', async () => {
        let calls = 0;
        const client = createLiveClient({
            config: { liveUrl: 'http://live' },
            fetchImpl: async () => { calls++; return jsonResponse({ topic: { slug: 'x' }, takes: [] }); },
            now: () => 0,
            log: quiet(),
            cacheMax: 2,
        });
        await client.topic('one');
        await client.topic('two');
        await client.topic('three');
        assert.strictEqual(client.cache.size, 2);
        assert.strictEqual(client.cache.get('rundown:topic:one'), undefined);
        assert.notStrictEqual(client.cache.get('rundown:topic:two'), undefined);
        assert.notStrictEqual(client.cache.get('rundown:topic:three'), undefined);
        assert.strictEqual(calls, 3);
    });

    done();
})().catch((e) => { console.error(e); process.exit(1); });
