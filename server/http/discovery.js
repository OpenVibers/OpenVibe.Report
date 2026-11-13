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

function createDiscoveryRoutes({ config, live, bench, sessionReports = null, meStats = null }) {
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
        // The /ai pages moved to OpenVibe.Compare on 2026-11-13; its sitemap lists them.
        const [reports, people] = await Promise.all([
            sessionReports ? sessionReports.listPublic({ limit: 500 }) : [],
            meStats ? meStats.listPublished({ limit: 500 }).catch(() => []) : [],
        ]);
        const lastmod = siteUpdated();
        // Only the pages this site owns. /rundown and its topic, episode and speaker pages carry rel=canonical to
        // OpenVibe.Live's Rundown, so listing them here would advertise a duplicate.
        const pages = [
            { loc: abs('/'), changefreq: 'daily', priority: 1.0 },
            { loc: abs('/stats'), changefreq: 'daily', priority: 0.9 },
            { loc: abs('/design'), changefreq: 'weekly', priority: 0.6 },
            ...reports.map((rep) => ({ loc: abs('/s/' + encodeURIComponent(rep.id)), changefreq: 'daily', priority: 0.6 })),
            // A person's public stats page is crawlable only when they published a section; the private default is
            // never in the sitemap. The last modification is the snapshot they last computed.
            ...people.filter((p) => p && p.username).map((p) => ({
                loc: abs(`/u/${encodeURIComponent(p.username)}`), changefreq: 'weekly', priority: 0.5,
                ...(dayOf(p.generated_at) ? { lastmod: dayOf(p.generated_at) } : {}),
            })),
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
                    { title: 'AI model comparison', url: 'https://openvibe.compare/ai', note: 'the leaderboard, ratings, prices and measured speed of every AI model now live on OpenVibe.Compare' },
                    { title: 'The AI Arena', url: abs('/ai/arena'), note: 'two anonymous answers to one prompt; your vote moves the ratings' },
                ] },
                // A JSON API is what an agent came for, not something to skip (AGT-5 review).
                { title: 'API', links: [
                    { title: 'Open stats (JSON)', url: abs('/api/v1/stats?days=7'), note: '?days=7, 30 or 90' },
                    { title: 'Design health (JSON)', url: abs('/api/v1/design-health'), note: 'every site; /api/v1/design-health/<site> for one' },
                    { title: 'The Rundown (JSON)', url: abs('/api/v1/rundown') },
                    { title: 'Topics (JSON)', url: abs('/api/v1/rundown/topics') },
                    { title: 'New AI results (RSS)', url: 'https://openvibe.compare/ai/feed.xml' },
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
