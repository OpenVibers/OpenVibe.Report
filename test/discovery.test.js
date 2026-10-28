'use strict';

/**
 * The crawl artifacts: robots.txt allows the public pages and disallows the API; sitemap.xml is the home, /stats,
 * /rundown and every topic from the Rundown; llms.txt names the site and its machine-readable answers. All three
 * are public for an hour.
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

        await check('sitemap.xml: the home, /stats, /rundown and every topic, with lastmod from STATUS.json', async () => {
            const r = await t.get('/sitemap.xml');
            assert.strictEqual(r.status, 200);
            assert.match(r.headers.get('content-type') || '', /^application\/xml/);
            assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=3600');
            for (const p of ['/', '/stats', '/rundown', '/rundown/t/seattle', '/rundown/t/ai-progress']) {
                assert.ok(r.text.includes(`<loc>https://openvibe.report${p}</loc>`), `no ${p} entry`);
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
                'https://openvibe.report/',
                'https://openvibe.report/stats',
                'https://openvibe.report/rundown',
                'https://openvibe.report/api/v1/stats?days=7',
                'https://openvibe.report/sitemap.xml',
            ]) assert.ok(r.text.includes(`(${link})`), `missing link ${link}`);
        });

        await check('a topics source that answers nothing still leaves the three static sitemap pages', async () => {
            const empty = await boot({ data: { topics: null } });
            try {
                const r = await empty.get('/sitemap.xml');
                assert.strictEqual(r.status, 200);
                for (const p of ['/', '/stats', '/rundown']) assert.ok(r.text.includes(`<loc>https://openvibe.report${p}</loc>`), p);
                assert.ok(!r.text.includes('/rundown/t/'), 'no topic should be listed');
            } finally { await empty.close(); }
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
