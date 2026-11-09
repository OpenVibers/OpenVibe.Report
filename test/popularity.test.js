'use strict';

/**
 * The front door's popularity read and "Try next"'s co-usage (plan L43): Report's own tables answer the ranked
 * destinations, a tool is a destination beside a site, the co-usage answer only reads people who published their
 * site list, and both are held five minutes. A pair below the small-group floor is never returned.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { createPopularity, TTL_MS, MIN_PEOPLE } = require('../server/popularity');

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-09T12:00:00Z');
const day = (back) => new Date(NOW - back * DAY).toISOString().slice(0, 10);
const series = (values) => values.map((n, i) => ({ day: day(values.length - 1 - i), n }));

function statsFixture() {
    return {
        generated_at: new Date(NOW).toISOString(),
        window_days: 7,
        sites: [
            { id: 'live', name: 'OpenVibe.Live', short: 'Live', host: 'openvibe.live', url: 'https://openvibe.live/', icon: 'live', pageviews: 700, pageviews_prev: 500, change_pct: 40, opens_24h: 100, opens_7d: 700, opens_prev_7d: 500, uses_24h: 12, uses_7d: 40, daily: series([100, 100, 100, 100, 100, 100, 100]) },
            { id: 'tools', name: 'OpenVibe.Tools', short: 'Tools', host: 'openvibe.tools', url: 'https://openvibe.tools/', icon: 'tools', pageviews: 500, pageviews_prev: 400, change_pct: 25, opens_24h: 80, opens_7d: 500, opens_prev_7d: 400, uses_24h: 8, uses_7d: 20, daily: series([70, 70, 70, 70, 70, 75, 75]) },
            { id: 'chat', name: 'OpenVibe.Chat', short: 'Chat', host: 'openvibe.chat', url: 'https://openvibe.chat/', icon: 'chat', pageviews: 100, pageviews_prev: 110, change_pct: -9, opens_24h: 10, opens_7d: 100, opens_prev_7d: 110, daily: series([15, 15, 15, 15, 15, 15, 10]) },
            { id: 'network', name: 'OpenVibe.Network', short: 'Network', host: 'openvibe.network', url: 'https://openvibe.network/', icon: 'network', pageviews: 9999, change_pct: 999 },
        ],
        tools: [
            { id: 'yt', name: 'YouTube downloader', short: 'yt', host: 'yt.openvibe.tools', url: 'https://yt.openvibe.tools/', icon: 'yt', opens_24h: 200, opens_7d: 900, opens_prev_7d: 300, uses_24h: 4, uses_7d: 11, daily: series([100, 100, 100, 100, 100, 200, 200]) },
            { id: 'dns', name: 'DNS lookup', short: 'dns', host: 'dns.openvibe.tools', url: 'https://dns.openvibe.tools/', icon: 'dns', opens_24h: 20, opens_7d: 150, opens_prev_7d: 100, daily: series([20, 20, 20, 20, 25, 25, 20]) },
        ],
    };
}

(async () => {
    await check('the ranked list is sites and tools from Report\'s numbers, with a reason and the icon id', async () => {
        const t = await boot({ db: true, now: () => NOW });
        try {
            const ingest = await t.ctx.analytics.ingestStats(statsFixture(), { now: () => NOW });
            assert.ok(ingest.ok, 'the stats fixture is ingested');
            const stats = await t.ctx.analytics.reportStats(7);
            assert.deepStrictEqual(stats.tools.map((tool) => tool.id), ['yt', 'dns'], 'tools are in the stats shape, ranked');
            assert.strictEqual(stats.tools[0].opens_7d, 900);
            assert.strictEqual(stats.sites.find((s) => s.id === 'live').uses_7d, 40, 'the people count is kept');
            const body = await t.ctx.popularity.popular({ limit: 5 });
            assert.strictEqual(body.source, 'report');
            assert.ok(body.items.length >= 4, 'four destinations with numbers');
            assert.strictEqual(body.items[0].id, 'yt', 'the most opened destination leads');
            assert.strictEqual(body.items[0].kind, 'tool', 'a tool is a destination');
            assert.strictEqual(body.items[0].reason, 'Most used today');
            assert.ok(body.items.every((i) => i.url.startsWith('https://') && i.icon && i.reason && i.name), 'every item has a URL, icon id, reason and name');
            assert.ok(!body.items.some((i) => i.id === 'network'), 'the account desk is not a destination');
            const live = body.items.find((i) => i.id === 'live');
            assert.strictEqual(live.kind, 'site');
            assert.strictEqual(live.opens_7d, 700);
            assert.strictEqual(live.opens_24h, 100);
            assert.strictEqual(live.uses_7d, 40);
            assert.strictEqual(live.reason, 'Rising this week');

            const api = await t.get('/api/v1/popular?limit=2');
            assert.strictEqual(api.status, 200);
            assert.strictEqual(api.headers.get('cache-control'), 'public, max-age=300', 'held five minutes');
            assert.strictEqual(api.headers.get('access-control-allow-origin'), '*');
            const json = api.json();
            assert.strictEqual(json.items.length, 2);
            assert.deepStrictEqual(json.items.map((i) => i.id), ['yt', 'live']);
            assert.ok(json.window && /00:00 UTC/.test(json.window.opens_24h));
        } finally { await t.close(); }
    });

    await check('the co-usage list reads only published site lists, aggregates pairs, and hides a small group', async () => {
        const t = await boot({ db: true, now: () => NOW });
        try {
            const db = t.ctx.store.db;
            const insert = db.prepare(`INSERT INTO report_me_stats (subject, username, display_name, published, snapshot, snapshot_at, updated_at)
                VALUES (?, ?, ?, ?::jsonb, ?::jsonb, now(), now())`);
            const row = (id, month, published = true) => insert.run(`usr_${id}`, `person${id}`, `Person ${id}`,
                JSON.stringify({ sites: published }), JSON.stringify({ sites: { month: month.map((service) => ({ service, visits: 2 })) } }));
            await row('a', ['live', 'tools', 'chat']);
            await row('b', ['live', 'tools']);
            await row('c', ['live', 'tools', 'games']);
            await row('d', ['live', 'tools', 'chat']);
            await row('e', ['live', 'tools']);
            await row('f', ['live', 'tools'], false);

            const body = await t.ctx.popularity.coUsage();
            assert.strictEqual(body.source, 'report');
            assert.strictEqual(body.sample_people, 5, 'the unpublished row is not read');
            assert.strictEqual(body.min_people, MIN_PEOPLE);
            assert.deepStrictEqual(body.pairs, [{ a: 'live', b: 'tools', people: 5 }], 'only a pair with enough people is returned');
            assert.ok(!JSON.stringify(body).includes('person'), 'no username or display name leaves the request');
            const r = await t.get('/api/v1/popular/co-usage');
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=300');
            assert.deepStrictEqual(r.json().pairs, body.pairs);
        } finally { await t.close(); }
    });

    await check('both reads are memoized for five minutes', async () => {
        let at = NOW;
        let calls = 0;
        const pop = createPopularity({ now: () => at, statsOf: async () => { calls++; return statsFixture(); } });
        await pop.popular({ limit: 5 });
        await pop.popular({ limit: 5 });
        assert.strictEqual(calls, 1, 'the second read inside five minutes is the memo');
        at += TTL_MS;
        await pop.popular({ limit: 5 });
        assert.strictEqual(calls, 2, 'after five minutes it is read again');
    });

    await check('a stats answer with no destinations is an empty list, never a made-up one', async () => {
        const pop = createPopularity({ now: () => NOW, statsOf: async () => ({ generated_at: new Date(NOW).toISOString(), window_days: 7, sites: [], tools: [] }) });
        const body = await pop.popular();
        assert.deepStrictEqual(body.items, []);
    });

    done();
})().catch((e) => { console.error(e); process.exit(1); });
