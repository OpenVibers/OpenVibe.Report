'use strict';

/**
 * Crawl artifacts for openvibe.report, built with openvibe-shared/seo:
 *
 *   GET /robots.txt      the public pages are crawlable; the API is not
 *   GET /sitemap.xml     /, /stats, /rundown and every /rundown/t/<slug> from the Rundown's topics
 *   GET /llms.txt        a markdown map of the site and its machine-readable answers
 *
 * The sitemap reads topics through the same cached client as the pages, so a crawler is no heavier than a reader
 * and a source that does not answer leaves the three static pages in place.
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

function createDiscoveryRoutes({ config, live }) {
    const r = express.Router();
    const site = String(config.baseUrl || 'https://openvibe.report').replace(/\/+$/, '');
    const abs = (p) => `${site}${p}`;

    r.get('/robots.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', CACHE).send(
            '# openvibe.report: the public pages are for search and AI crawlers; the JSON API is not.\n'
            + seo.robotsTxt({ sitemaps: [abs('/sitemap.xml')], disallow: ['/api/'] }),
        );
    });

    r.get('/sitemap.xml', async (_req, res) => {
        const data = await live.topics();
        const topics = (data && Array.isArray(data.topics)) ? data.topics : [];
        const lastmod = siteUpdated();
        const pages = [
            { loc: abs('/'), changefreq: 'daily', priority: 1.0 },
            { loc: abs('/stats'), changefreq: 'daily', priority: 0.9 },
            { loc: abs('/rundown'), changefreq: 'daily', priority: 0.9 },
            ...topics.filter((t) => t && typeof t.slug === 'string').map((t) => ({
                loc: abs(`/rundown/t/${encodeURIComponent(t.slug)}`),
                changefreq: 'weekly',
                priority: 0.7,
            })),
        ].map((p) => ({ ...p, ...(lastmod ? { lastmod } : {}) }));
        res.type('application/xml').set('Cache-Control', CACHE).send(seo.sitemapXml(pages));
    });

    r.get('/llms.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', CACHE).send(seo.llmsTxt({
            name: SITE_NAME,
            summary: 'Every number on OpenVibe, honest: the network\'s open stats, The Rundown of what streamers talked about, and every stream\'s after-show report.',
            details: 'The numbers and the write-ups are read from OpenVibe.Network and OpenVibe.Live, cached in this process for a few minutes, and shown as the sources answer them. Nothing here is about a person.',
            sections: [
                { title: 'Start here', links: [
                    { title: 'OpenVibe.Report', url: abs('/'), note: 'the Report room' },
                    { title: 'Open numbers', url: abs('/stats'), note: 'page views, accounts and traffic for every OpenVibe site' },
                    { title: 'The Rundown', url: abs('/rundown'), note: 'what streamers talked about, topic by topic' },
                ] },
                { title: 'Machine-readable', links: [
                    { title: 'Open stats (JSON)', url: abs('/api/v1/stats?days=7'), note: '?days=7, 30 or 90' },
                    { title: 'The Rundown (JSON)', url: abs('/api/v1/rundown') },
                    { title: 'Topics (JSON)', url: abs('/api/v1/rundown/topics') },
                    { title: 'Sitemap', url: abs('/sitemap.xml') },
                    { title: 'Release metadata (JSON)', url: abs('/release.json') },
                ] },
                { title: 'Elsewhere', links: [
                    { title: 'OpenVibe.Network', url: 'https://openvibe.network', note: 'the network and its open stats' },
                    { title: 'OpenVibe.Live', url: 'https://openvibe.live', note: 'the streams, The Rundown and the after-show reports' },
                ] },
            ],
        }));
    });

    return r;
}

module.exports = { createDiscoveryRoutes, DESCRIPTION, SITE_NAME };
