'use strict';

/**
 * The crawl artifacts: robots.txt allows the public pages and disallows the API; sitemap.xml is the pages this site
 * owns (not The Rundown, which canonicalises to OpenVibe.Live); llms.txt names the site and its machine-readable
 * answers. All three are public for an hour.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, check, done } = require('./helpers/boot');

const STATUS_UPDATED = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'STATUS.json'), 'utf8')).updated;

(async () => {
    const t = await boot();
    try {
        await check('robots.txt: public pages crawlable, /api/ disallowed, the sitemap named', async () => {
            const r = await t.get('/robots.txt');
            assert.strictEqual(r.status, 200);
            assert.match(r.headers.get('content-type') || '', /^text\/plain/);
            assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=3600');
            assert.match(r.text, /^User-agent: \*$/m);
            assert.ok(r.text.includes('Disallow: /api/'));
            assert.ok(r.text.includes('Sitemap: https://openvibe.report/sitemap.xml'));
            for (const p of ['/stats', '/rundown']) assert.ok(!r.text.includes(`Disallow: ${p}`), `${p} must stay crawlable`);
        });

        await check('sitemap.xml: the site\'s own pages, never The Rundown (Live is its canonical), with lastmod from STATUS.json', async () => {
            const r = await t.get('/sitemap.xml');
            assert.strictEqual(r.status, 200);
            assert.match(r.headers.get('content-type') || '', /^application\/xml/);
            assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=3600');
            for (const p of ['/', '/stats', '/design']) {   // /ai moved to OpenVibe.Compare (2026-11-13)
                assert.ok(r.text.includes(`<loc>https://openvibe.report${p}</loc>`), `no ${p} entry`);
            }
            for (const p of ['/rundown', '/rundown/t/seattle', '/rundown/t/ai-progress']) {
                assert.ok(!r.text.includes(`<loc>https://openvibe.report${p}</loc>`), `${p} must not be listed: Live is its canonical`);
            }
            assert.ok(!r.text.includes('<loc>https://openvibe.report/api/'), 'the API must not be in the sitemap');
            const lastmods = [...r.text.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((m) => m[1]);
            assert.ok(lastmods.length > 0, 'no lastmod');
            assert.ok(lastmods.every((d) => d === STATUS_UPDATED), `lastmod must come from STATUS.json (${STATUS_UPDATED})`);
        });

        await check('llms.txt: the site, its pages and its machine-readable answers', async () => {
            const r = await t.get('/llms.txt');
            assert.strictEqual(r.status, 200);
            assert.match(r.headers.get('content-type') || '', /^text\/plain/);
            assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=3600');
            assert.ok(r.text.startsWith('# OpenVibe.Report'));
            for (const link of [
                'https://openvibe.report/index.md',
                'https://openvibe.report/stats.md',
                'https://openvibe.live/rundown',
                'https://openvibe.report/design.md',
                'https://openvibe.report/api/v1/stats?days=7',
                'https://openvibe.report/sitemap.xml',
            ]) assert.ok(r.text.includes(`(${link})`), `missing link ${link}`);
            assert.ok(r.text.includes('\n## Optional\n'), 'llms.txt has an Optional section');
            // /design and /rundown have Markdown twins; The Rundown's twin carries Live's canonical, so the two
            // representations agree about which URL is the page.
            for (const p of ['/design', '/rundown']) {
                const twin = await t.get(`${p}.md`);
                assert.strictEqual(twin.status, 200, `${p}.md`);
                assert.match(twin.headers.get('content-type') || '', /^text\/markdown/);
                assert.match((await t.get(p)).headers.get('link') || '', /text\/markdown/, `${p} names its twin`);
            }
            const rundownTwin = await t.get('/rundown.md');
            assert.ok(rundownTwin.text.includes('canonical: "https://openvibe.live/rundown"'), 'the twin canonicalises to Live');
        });

        await check('llms-full.txt (SEO-33): the site in full, every page llms.txt lists with what it holds', async () => {
            const r = await t.get('/llms-full.txt');
            assert.strictEqual(r.status, 200);
            assert.match(r.headers.get('content-type') || '', /^text\/plain/);
            assert.ok(r.text.startsWith('# OpenVibe.Report'));
            assert.ok(r.text.length > 500, `${r.text.length} characters`);
            assert.match(r.text, /## About\n\n### OpenVibe\.Report\n\nURL: https:\/\/openvibe\.report\/\n\nEvery number on OpenVibe, honest/);
            assert.match(r.text, /### Design health\n\nURL: https:\/\/openvibe\.report\/design\n\nhow closely each site follows/);
        });

        await check('a topics source that answers nothing still leaves the pages this site owns', async () => {
            const empty = await boot({ data: { topics: null } });
            try {
                const r = await empty.get('/sitemap.xml');
                assert.strictEqual(r.status, 200);
                for (const p of ['/', '/stats']) assert.ok(r.text.includes(`<loc>https://openvibe.report${p}</loc>`), p);
                assert.ok(!r.text.includes('/rundown/t/'), 'no topic should be listed');
            } finally { await empty.close(); }
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
