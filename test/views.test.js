'use strict';
// Views in Report: the room quotes OpenVibe.Media's one view store (GET /api/v1/views/aggregate), never derives a
// number. Per item, per creator and per site, with the Feed-preview share and a live stream's peak concurrent.
const assert = require('assert');
const http = require('http');
const express = require('express');
const { createViewsClient } = require('../server/data/views');
const views = require('../server/views');

(async () => {
    const calls = [];
    const source = {
        scope: 'item', days: 7, from: '2026-11-06', to: '2026-11-12',
        rows: [{ id: 'media:vod:42', service: 'media', kind: 'vod', item_id: '42', site: 'network', creator: 'nadia', views: 120, engaged: 40, previews: 60, preview_share: 0.5, peak_concurrent: null }],
        totals: { views: 120, engaged: 40, previews: 60, preview_share: 0.5, peak_concurrent: null },
    };
    const fetchImpl = async (url) => {
        calls.push(String(url));
        if (String(url).includes('offline.test')) return { ok: false };
        return { ok: true, json: async () => source };
    };
    const client = createViewsClient({ config: { mediaUrl: 'http://media.test' }, fetchImpl });
    const out = await client.item({ service: 'media', kind: 'vod', id: '42', days: 7 });
    assert.strictEqual(out.rows[0].views, 120);
    assert.ok(calls[0].startsWith('http://media.test/api/v1/views/aggregate?'));
    assert.ok(calls[0].includes('scope=item') && calls[0].includes('days=7'));
    await client.item({ service: 'media', kind: 'vod', id: '42', days: 7 });
    assert.strictEqual(calls.length, 1, 'a second read is cached');
    const top = await client.top(7);
    assert.strictEqual(top.items.rows.length, 1);
    assert.ok(calls.length >= 2);
    const down = createViewsClient({ config: { mediaUrl: 'http://offline.test' }, fetchImpl });
    assert.strictEqual(await down.creator('nadia', 7), null, 'a source that does not answer is null, not a zero');

    // The room's tables show each dimension's numbers and the preview share.
    const html = views.stats({
        stats: { totals: { pageviews: 10 }, window_days: 7, sites: [] },
        days: 7,
        views: {
            items: source,
            creators: { rows: [{ id: 'nadia', creator: 'nadia', views: 120, engaged: 40, previews: 60, preview_share: 0.5, peak_concurrent: null }] },
            sites: { rows: [{ id: 'network', site: 'network', views: 120, engaged: 40, previews: 60, preview_share: 0.5, peak_concurrent: 3 }] },
        },
    });
    assert.ok(html.includes('Views and engaged viewers'), 'the room has a views section');
    assert.ok(html.includes('Top items') && html.includes('Top creators') && html.includes('By site'));
    assert.ok(html.includes('From previews') && html.includes('50%'), 'the Feed share is the number Media gave');
    assert.ok(html.includes('Peak live'));

    const channel = views.channel({ username: 'nadia', recaps: { recaps: [] }, views: { scope: 'creator', id: 'nadia', rows: source.rows } });
    assert.ok(channel.includes('Views and engaged viewers'), 'a creator page shows their numbers');

    // The API answers from the same source.
    const fake = { item: async () => source, creator: async () => source, site: async () => source, top: async () => ({ items: source, creators: source, sites: source }) };
    const app = express();
    app.use('/api/v1', require('../server/http/api').createApi({ viewsData: fake, network: null, live: null, config: {} }));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    let r = await fetch(`${base}/views?scope=item&service=media&kind=vod&id=42&days=7`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await r.json()).rows[0].views, 120);
    r = await fetch(`${base}/views?scope=creator&id=nadia&days=30`);
    assert.strictEqual(r.status, 200);
    r = await fetch(`${base}/views/top?days=30`);
    assert.strictEqual(r.status, 200);
    r = await fetch(`${base}/views?scope=item&id=42`);
    assert.strictEqual(r.status, 404);
    server.close();
    console.log('report views: ok');
})().catch((error) => { console.error(error); process.exit(1); });
