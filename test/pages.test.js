'use strict';

/**
 * Every page route: 200 with stub data, its own canonical and the two-minute public cache; a bad path parameter is a
 * 404 without a source call; a source that answers nothing is a 404 (the home leaves that part out); every dynamic value is escaped.
 */
const assert = require('assert');
const { boot, check, done, defaults } = require('./helpers/boot');

(async () => {
    const t = await boot();
    try {
        const pages = [
            ['/', ['OpenVibe.Report', '77,408', 'A lead take', 'Seattle']],
            ['/stats?days=30', ['Every OpenVibe site', '30 days', '77,408', 'OpenVibe.Live']],
            ['/rundown', ['The Rundown', 'goosely', 'AI progress', 'A written-up stream']],
            ['/rundown/t/seattle', ['Seattle', 'A headline', 'A take']],
            ['/rundown/e/7', ['A written-up stream', 'The logline.', 'A segment']],
            ['/rundown/s/goosely', ['goosely', 'A written-up stream', 'Seattle']],
            ['/after-show/7', ['Seattle Today', 'After-show report']],
            ['/c/goosely', ['goosely', 'Seattle Today', 'A tiny but mighty vibe', 'Grade A']],
        ];
        for (const [path, expected] of pages) {
            await check(`GET ${path}: 200 text/html, public for two minutes, the model in the page`, async () => {
                const r = await t.get(path);
                assert.strictEqual(r.status, 200);
                assert.match(r.headers.get('content-type') || '', /^text\/html/);
                assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=120');
                assert.ok(r.text.startsWith('<!doctype html>'), 'not a whole document');
                assert.match(r.text, /<meta name="robots" content="index, follow">/);
                for (const value of expected) assert.ok(r.text.includes(value), `missing ${value}`);
            });
        }

        await check('the home has WebSite and Organization JSON-LD', async () => {
            const r = await t.get('/');
            const ld = [...r.text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1])).flatMap((b) => b['@graph'] || [b]);
            assert.ok(ld.some((x) => x['@type'] === 'WebSite'), 'WebSite');
            const org = ld.find((x) => x['@type'] === 'Organization');
            assert.ok(org && Array.isArray(org.sameAs) && org.sameAs.includes('https://github.com/OpenVibers'), 'Organization');
        });

        await check('a page names its canonical and mounts the Frame for service report', async () => {
            const r = await t.get('/rundown/t/seattle');
            assert.ok(r.text.includes('<link rel="canonical" href="https://openvibe.report/rundown/t/seattle">'));
            assert.ok(r.text.includes('<div id="navbar-mount"></div>'), 'no navbar mount');
            assert.ok(r.text.includes('id="ov-footer"'), 'no Shared footer');
            assert.ok(r.text.includes('"service":"report"'), 'the Frame is not initialised for report');
            assert.ok(r.text.includes('theme-loader.js'), 'no theme loader');
            assert.ok(r.text.includes('navbar.js') && r.text.includes('footer.js'), 'no Shared Frame scripts');
            assert.ok(r.text.includes('OpenVibeFooter.init'), 'no footer init');
        });

        await check('unknown paths are the 404 view with noindex and the page cache', async () => {
            const r = await t.get('/not-a-page');
            assert.strictEqual(r.status, 404);
            assert.match(r.headers.get('content-type') || '', /^text\/html/);
            assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=120');
            assert.ok(r.text.includes('<h1>Nothing here</h1>'));
            assert.match(r.text, /<meta name="robots" content="noindex[^"]*">/);
        });

        await check('a bad slug, stream id or username is a 404 before the source is called', async () => {
            const before = t.fetchImpl.calls.length;
            for (const path of ['/rundown/t/Not_A_Slug', '/rundown/t/' + 'a'.repeat(81), '/rundown/e/0', '/rundown/e/abc', '/rundown/s/bad-name', '/after-show/-1', '/c/bad!']) {
                const r = await t.get(path);
                assert.strictEqual(r.status, 404, path);
            }
            const after = t.fetchImpl.calls.slice(before);
            assert.strictEqual(after.length, 0, `a bad parameter reached the source: ${after.join(', ')}`);
        });

        await check('days other than 7, 30 or 90 render the 30-day page', async () => {
            const r = await t.get('/stats?days=365');
            assert.strictEqual(r.status, 200);
            assert.ok(r.text.includes('aria-current="page">30 days'), 'the 30-day tab is the open one');
            const request = t.fetchImpl.calls.filter((u) => u.includes('/api/v1/stats')).pop();
            assert.ok(request.endsWith('?days=30'), request);
        });
    } finally {
        await t.close();
    }

    await check('a source that answers nothing makes the page a 404', async () => {
        const empty = await boot({ data: { rundown: null, topic: null } });
        try {
            assert.strictEqual((await empty.get('/rundown')).status, 404);
            assert.strictEqual((await empty.get('/rundown/t/seattle')).status, 404);
            // The home stands on its parts: with the Rundown down it still answers, without that part.
            const home = await empty.get('/');
            assert.strictEqual(home.status, 200);
            assert.ok(!home.text.includes('What streamers talked about') || home.text.includes('rp-topics'), 'no empty Rundown part');
            assert.strictEqual((await empty.get('/stats')).status, 200, 'an unrelated page still serves');
        } finally { await empty.close(); }
    });

    await check('every dynamic value is escaped', async () => {
        const data = defaults();
        data.topic.topic.title = '<script>alert(1)</script>';
        data.topic.topic.headline = '"quoted" & <b>bold</b>';
        const xss = await boot({ data });
        try {
            const r = await xss.get('/rundown/t/seattle');
            assert.strictEqual(r.status, 200);
            assert.ok(!r.text.includes('<script>alert(1)</script>'), 'an unescaped script reached the page');
            assert.ok(r.text.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
            assert.ok(r.text.includes('&quot;quoted&quot; &amp; &lt;b&gt;bold&lt;/b&gt;'));
        } finally { await xss.close(); }
    });

    done();
})().catch((e) => { console.error(e); process.exit(1); });
