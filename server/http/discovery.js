'use strict';

/**
 * Crawl artifacts for openvibe.report, built with openvibe-shared/seo:
 *
 *   GET /robots.txt      the public pages are crawlable; the API is not
 *   GET /sitemap.xml     /, /stats, /design, /ai (and its benchmarks, models, method and compare), the Rundown's topics
 *   GET /llms.txt        a markdown map of the site and its machine-readable answers
 *
 * The sitemap lists only the pages this site owns; The Rundown pages carry rel=canonical to openvibe.live and are left
 * out, so the two sites never present the same page as two canonical URLs.
 */
const fs = require('fs');
const path = require('path');
const seo = require('openvibe-shared/seo');
const express = require('express');

const SITE_NAME = 'OpenVibe.Report';
const DESCRIPTION = 'OpenVibe.Report is the Report room of the OpenVibe network: the open numbers every OpenVibe site publishes, The Rundown of what streamers talked about, and each stream\'s after-show report.';
const CACHE = 'public, max-age=3600';

function dayOf(value) {
    const m = String(value == null ? '' : value).match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
}

function siteUpdated() {
    try {
        return dayOf(JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'STATUS.json'), 'utf8')).updated);
    } catch {
        return null;
    }
}

function createDiscoveryRoutes({ config, live, bench, sessionReports = null }) {
    const r = express.Router();
    const site = String(config.baseUrl || 'https://openvibe.report').replace(/\/+$/, '');
    const abs = (p) => `${site}${p}`;

    r.get('/robots.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', CACHE).send(
            '# openvibe.report: the public pages are for search and AI crawlers; the JSON API is not.\n'
            + `# Agent manifest: ${abs('/.well-known/agent.json')}\n`
            + seo.robotsTxt({ sitemaps: [abs('/sitemap.xml')], disallow: ['/api/'] }),
        );
    });

    r.get('/sitemap.xml', async (_req, res) => {
        const [ai, overview, reports] = await Promise.all([
            bench.kinds(), bench.overview(), sessionReports ? sessionReports.listPublic({ limit: 500 }) : [],
        ]);
        const kinds = (ai && Array.isArray(ai.data.kinds)) ? ai.data.kinds : [];
        const o = overview && overview.data ? overview.data : {};
        const benches = Array.isArray(o.list) ? o.list : [];
        const models = Array.isArray(o.model_list) ? o.model_list.map((m) => m.model).filter(Boolean) : [...new Set((Array.isArray(o.recent) ? o.recent : []).map((r) => r && r.model).filter(Boolean))];
        const lastmod = siteUpdated();
        // Only the pages this site owns. /rundown and its topic, episode and speaker pages carry rel=canonical to
        // OpenVibe.Live's Rundown, so listing them here would advertise a duplicate.
        const pages = [
            { loc: abs('/'), changefreq: 'daily', priority: 1.0 },
            { loc: abs('/stats'), changefreq: 'daily', priority: 0.9 },
            { loc: abs('/design'), changefreq: 'weekly', priority: 0.6 },
            { loc: abs('/ai'), changefreq: 'daily', priority: 0.9 },
            { loc: abs('/ai/leaderboard'), changefreq: 'daily', priority: 0.9 },
            { loc: abs('/ai/providers'), changefreq: 'daily', priority: 0.7 },
            { loc: abs('/ai/arena'), changefreq: 'daily', priority: 0.6 },
            { loc: abs('/ai/method'), changefreq: 'weekly', priority: 0.6 },
            { loc: abs('/ai/compare'), changefreq: 'weekly', priority: 0.6 },
            ...reports.map((rep) => ({ loc: abs('/s/' + encodeURIComponent(rep.id)), changefreq: 'daily', priority: 0.6 })),
            ...kinds.filter((k) => k && bench.isKindId(k.id)).map((k) => ({
                loc: abs(`/ai/${encodeURIComponent(k.id)}`), changefreq: 'daily', priority: 0.7,
            })),
            ...benches.filter((b) => b && bench.isBenchmarkId(b.id)).map((b) => ({
                loc: abs(`/ai/${encodeURIComponent(b.id)}`), changefreq: 'daily', priority: 0.8,
                ...(dayOf(b.last_run) ? { lastmod: dayOf(b.last_run) } : {}),
            })),
            ...models.filter((m) => bench.isModelName(m)).map((m) => ({
                loc: abs(`/ai/models/${encodeURIComponent(m)}`), changefreq: 'daily', priority: 0.6,
            })),
            ...models.filter((m) => bench.isModelName(m)).slice(0, 200).flatMap((a, i, list) => list.slice(i + 1).map((b) => ({
                loc: abs(`/ai/compare/${encodeURIComponent(a)}-vs-${encodeURIComponent(b)}`), changefreq: 'weekly', priority: 0.5,
            }))).slice(0, 200),
        ].map((p) => ({ ...p, ...(lastmod && !p.lastmod ? { lastmod } : {}) }));
        res.type('application/xml').set('Cache-Control', CACHE).send(seo.sitemapXml(pages));
    });

    // The site as llms.txt describes it, shared by /llms.txt and /llms-full.txt (SEO-33).
    const llmsSite = () => ({
            name: SITE_NAME,
            summary: 'Every number on OpenVibe, honest: the network\'s open stats, The Rundown of what streamers talked about, every stream\'s after-show report, and the AI results Bench publishes.',
            details: 'The numbers and the write-ups are read from OpenVibe.Network, OpenVibe.Live and OpenVibe.Bench, cached in this process for a few minutes, and shown as the sources answer them. Nothing here is about a person.',
            markdown: true,
            base: site,
            sections: [
                { title: 'Start here', links: [
                    { title: 'OpenVibe.Report', url: abs('/'), note: 'the Report room' },
                    { title: 'Open numbers', url: abs('/stats'), note: 'page views, accounts and traffic for every OpenVibe site' },
                    { title: 'Design health', url: abs('/design'), note: 'how closely each site follows the shared design kit, read from its code; per site at /design/<site>' },
                    { title: 'The Rundown', url: 'https://openvibe.live/rundown', note: 'what streamers talked about, topic by topic (OpenVibe.Live is its canonical home)' },
                    { title: 'AI', url: abs('/ai'), note: 'OpenVibe.Bench results: quality, price and speed for every task kind and benchmark' },
                    { title: 'How AI results are judged', url: abs('/ai/method'), note: 'scores, verified runs, cost per solved, speed and the frontier' },
                    { title: 'Compare AI models', url: abs('/ai/compare'), note: 'two or three models on the same benchmarks' },
                ] },
                // A JSON API is what an agent came for, not something to skip (AGT-5 review).
                { title: 'API', links: [
                    { title: 'Open stats (JSON)', url: abs('/api/v1/stats?days=7'), note: '?days=7, 30 or 90' },
                    { title: 'Design health (JSON)', url: abs('/api/v1/design-health'), note: 'every site; /api/v1/design-health/<site> for one' },
                    { title: 'The Rundown (JSON)', url: abs('/api/v1/rundown') },
                    { title: 'Topics (JSON)', url: abs('/api/v1/rundown/topics') },
                    { title: 'New AI results (RSS)', url: abs('/ai/feed.xml') },
                    { title: 'New AI results (JSON)', url: abs('/api/v1/ai/results') },
                ] },
            ],
            optional: [
                { title: 'Sitemap', url: abs('/sitemap.xml') },
                { title: 'Full text for language models', url: abs('/llms-full.txt') },
                { title: 'Release metadata (JSON)', url: abs('/release.json') },
                { title: 'OpenVibe.Network', url: 'https://openvibe.network', note: 'the network and its open stats' },
                { title: 'OpenVibe.Live', url: 'https://openvibe.live', note: 'the streams, The Rundown and the after-show reports' },
            ],
        });
    r.get('/llms.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', CACHE).send(seo.llmsTxt(llmsSite()));
    });
    // The same, in full (SEO-33): what the site is, then every page llms.txt lists with what it holds.
    r.get('/llms-full.txt', (_req, res) => {
        const d = llmsSite();
        res.type('text/plain').set('Cache-Control', CACHE).send(seo.llmsFull({
            site: d.name, summary: d.summary, base: abs('/'),
            sections: [
                { title: 'About', pages: [{ title: d.name, url: abs('/'), text: [d.summary, d.details].filter(Boolean).join('\n\n') }] },
                ...(d.sections || []).map((x) => ({ title: x.title, pages: (x.links || []).map((l) => ({ title: l.title, url: l.url, text: l.note || '' })) })),
            ],
        }));
    });

    return r;
}

module.exports = { createDiscoveryRoutes, DESCRIPTION, SITE_NAME };
