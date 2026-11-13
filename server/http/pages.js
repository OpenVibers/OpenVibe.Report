'use strict';

/**
 * The pages, server-rendered from a plain model (server/views/index.js):
 *
 *   GET /                       stats 7 days + the Rundown + topics
 *   GET /stats?days=            7 | 30 | 90 (anything else is 30)
 *   GET /rundown                the Rundown + topics
 *   GET /rundown/t/:slug        one topic
 *   GET /rundown/e/:streamId    one stream as an episode
 *   GET /rundown/s/:username    one streamer
 *   GET /after-show/:streamId   one after-show report
 *   GET /c/:username            one channel's after-show reports
 *   GET /ai…                    301 to OpenVibe.Compare (the AI model comparison moved there on 2026-11-13), except
 *                               the Arena's rounds and votes (http/arena.js) and the staff page /ai/exchange
 *
 * A bad path parameter is a 404 without a source request; so is a source that answers nothing. Pages are public
 * for two minutes.
 *
 * The public pages the agent layer also twins have their data and view here (createPublicPages), so a route and its
 * Markdown twin render the very same page; `agent: true` in those views adds the discovery links.
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const views = require('../views');
const { normaliseDays, isSlug, isStreamId, isUsername, streamIdOf } = require('../data/source');
const { twinPath } = require('../agent-pages');
const designViews = require('../views/design');
const designHealth = require('../data/design-health');
const sharing = require('../sharing');

const CACHE = 'public, max-age=120';
/** Where the AI model comparison lives since 2026-11-13. */
const COMPARE = 'https://openvibe.compare';

/** The pages the agent layer twins: their data, then the view. Each returns { html } or null (nothing to show). */
function createPublicPages({ sessionReports, network, live, bench, aiCatalogue = null, analytics = null, viewsData = null }) {
    const numbers = (days) => (analytics ? analytics.stats(days) : network.stats(days));

    async function home() {
        const [stats, rundown, topics] = await Promise.all([numbers(7), live.rundown(), live.topics()]);
        // Each part of the home stands alone: a source that does not answer leaves its part out, not the page.
        return { html: views.home({ stats, rundown, topics }) };
    }

    async function stats(days) {
        const [data, viewData] = await Promise.all([numbers(days), viewsData ? viewsData.top(days) : null]);
        return data ? { html: views.stats({ stats: data, days, views: viewData }) } : null;
    }

    function developers() {
        return { html: views.developers() };
    }

    function design() { return { html: designViews.designHealth(designHealth.all()) }; }

    async function rundown() {
        const [r, topics, reports] = await Promise.all([
            live.rundown(), live.topics(),
            sessionReports ? sessionReports.listPublicToday({ limit: 24 }) : [],
        ]);
        return { html: views.rundown({ rundown: r, topics, reports }) };
    }

    return { home, stats, developers, design, rundown };
}

/** The new-results feed: one item per public run, with its own Bench date and no invented number. */
function rssFeed({ runs, overview, base }) {
    const xml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const list = runs && runs.data && Array.isArray(runs.data.runs) ? runs.data.runs : [];
    const titles = new Map((overview && overview.data && Array.isArray(overview.data.list) ? overview.data.list : []).map((b) => [b.id, b.title]));
    const site = String(base || 'https://openvibe.report').replace(/\/+$/, '');
    const items = list.map((r) => {
        const title = `${r.model} on ${titles.get(r.benchmark_id) || r.benchmark_id}`;
        const link = `${site}/ai/${encodeURIComponent(r.benchmark_id)}`;
        const score = r.score == null ? 'no score' : `${Math.round(Number(r.score) * 10) / 10}/100`;
        const cost = r.cost_usd == null ? 'cost not given' : `$${Number(r.cost_usd).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
        const speed = r.ms == null ? 'time not given' : `${Math.round(Number(r.ms))} ms`;
        const at = Date.parse(r.created_at);
        return `<item><title>${xml(title)}</title><link>${xml(link)}</link><guid isPermaLink="false">${xml(r.id)}</guid>${Number.isFinite(at) ? `<pubDate>${new Date(at).toUTCString()}</pubDate>` : ''}<description>${xml(`${r.model} scored ${score} on ${titles.get(r.benchmark_id) || r.benchmark_id}, for ${cost} in ${speed} (${r.provenance || 'run'}).`)}</description></item>`;
    }).join('');
    const newest = list.length ? Date.parse(list[0].created_at) : NaN;
    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>OpenVibe AI: new results</title><link>${xml(`${site}/ai`)}</link><description>Verified and submitted AI runs as OpenVibe.Bench publishes them.</description><language>en</language>${Number.isFinite(newest) ? `<lastBuildDate>${new Date(newest).toUTCString()}</lastBuildDate>` : ''}${items}</channel></rss>`;
}

function createPageRoutes(ctx) {
    const { live, bench, sessionReports, viewsData } = ctx;
    const r = express.Router();
    const publicPages = ctx.publicPages || createPublicPages(ctx);
    // The Rundown's pages canonicalise to OpenVibe.Live, and so does its Markdown twin: the generic agent layer
    // (server/agent-pages.js) would sign the twin with this site's own address. Answer it here instead, before the
    // .md hand-off, with Live's canonical.
    r.get('/rundown.md', async (_req, res) => {
        const { markdownTwin } = require('openvibe-shared/agent-layer');
        const page = await publicPages.rundown();
        const body = markdownTwin({ html: page.html, canonical: 'https://openvibe.live/rundown' });
        res.set('Content-Type', 'text/markdown; charset=utf-8').set('Cache-Control', CACHE).send(body);
    });
    // A path ending in .md is a Markdown twin (server/agent-pages.js), never a page parameter.
    r.use((req, res, next) => (req.path.endsWith('.md') ? next('router') : next()));

    function send(req, res, html, status = 200, cacheControl = CACHE) {
        // A page with a Markdown twin names it, as the agent layer's own responses do (openvibe-shared/agent-layer).
        if (status === 200 && twinPath(req.path)) {
            const site = String(ctx.config.baseUrl).replace(/\/+$/, '');
            res.set('Link', require('openvibe-shared/agent-layer').linkHeaderTags(`${site}${req.originalUrl}`, `${site}/llms.txt`).header);
        }
        res.status(status).set('Cache-Control', cacheControl).type('html').send(html);
    }
    function notFound(req, res) {
        return send(req, res, views.notFound(), 404);
    }

    r.get('/', async (req, res) => send(req, res, (await publicPages.home()).html));

    r.get('/developers', (req, res) => send(req, res, publicPages.developers().html));

    // Every site's design health (plan L45 step 6), from the snapshot (server/data/design-health.js).
    r.get('/design', (req, res) => send(req, res, designViews.designHealth(designHealth.all())));
    r.get('/design/:site', (req, res) => {
        const site = designHealth.site(req.params.site);
        if (!site) return notFound(req, res);
        return send(req, res, designViews.designSite(designHealth.all(), site));
    });

    r.get('/stats', async (req, res) => {
        const page = await publicPages.stats(normaliseDays(req.query.days));
        if (!page) return notFound(req, res);
        return send(req, res, page.html);
    });

    // The AI model comparison moved to OpenVibe.Compare (the owner, 2026-11-13: "This kinda shit is supposed to be a part
    // of openvibe.compare"). Every /ai page answers 301 there with its path and query; the Arena's rounds and votes
    // (http/arena.js, mounted before these routes) and the staff page /ai/exchange below stay here. Report keeps the
    // ledgers and the JSON API (/api/v1/ai/*) Compare reads.
    r.get(/^\/ai(?:\/.*)?$/, (req, res, next) => {
        if (/^\/ai\/(?:arena|exchange)(?:\/|$)/.test(req.path)) return next();
        return res.redirect(301, `${COMPARE}${req.originalUrl}`);
    });

    // The AI Exchange's daily aggregates (plan G-P9), staff-only, behind REPORT_AI_EXCHANGE. The gate is the signed-in
    // person's staff role (`staff.site.view`, the capability that covers analytics and money state), the same
    // openvibe-contracts staff map other staff pages use. The page is private and never cached.
    r.get('/ai/exchange', async (req, res) => {
        if (!ctx.config.aiExchange || !ctx.config.aiExchange.enabled) return notFound(req, res);
        if (!req.user) return send(req, res, views.staffOnly({ signedIn: false }), 401, 'private, no-store');
        if (!contracts.staff.can(req.user, 'staff.site.view')) return send(req, res, views.staffOnly({ signedIn: true }), 403, 'private, no-store');
        if (!ctx.aiExchange) return contracts.http.sendProblem(res, 503, 'report.no_database', { detail: 'Report has no database in this process.', ctx: req.ov });
        try {
            const body = await ctx.aiExchange.analytics({ from: req.query.from || null, to: req.query.to || null });
            return send(req, res, views.aiExchange(body), 200, 'private, no-store');
        } catch (err) {
            if (err instanceof RangeError) return contracts.http.sendProblem(res, 422, 'ai.invalid', { detail: err.message, ctx: req.ov });
            ctx.log.error('[OpenVibe.Report] the AI Exchange page failed:', err && err.message ? String(err.message).slice(0, 200) : err);
            return contracts.http.sendProblem(res, 500, 'report.ai_exchange_failed', { detail: 'The AI Exchange aggregates could not be read.', ctx: req.ov });
        }
    });

    r.get('/rundown', async (req, res) => {
        const [rundown, topics, reports] = await Promise.all([
            live.rundown(), live.topics(),
            sessionReports ? sessionReports.listPublicToday({ limit: 24 }) : [],
        ]);
        if (!rundown || !topics) return notFound(req, res);
        return send(req, res, views.rundown({ rundown, topics, reports }));
    });

    // One agent session's report (Agent Streams S3), in the sharing system's four audiences (design 2026-11-06): the
    // share row decides, through canView, and nobody else learns whether it exists — a report of Specific people is a
    // 404 for a signed-in person who is not on the list, and for everyone signed out.
    r.get('/s/:id', async (req, res) => {
        const id = String(req.params.id || '');
        const rep = sessionReports ? await sessionReports.get(id) : null;
        if (!rep) return notFound(req, res);
        const viewer = sharing.viewerOf(req.user);
        if (!(await sharing.canView(viewer, rep))) return notFound(req, res);
        const audience = await sharing.audienceOf(rep);
        const isOwner = Boolean(viewer && viewer.subject.id === rep.owner);
        const members = isOwner ? await sharing.memberSubjects(rep.id) : [];
        // Only a signed-out visitor's copy of a public report may be stored by a shared cache. A signed-in reader's
        // page carries their own parts — above all the owner's, which names the Share sheet's kind and id and the
        // people the report is shared with — and Cloudflare on our zones does not honour Vary or Authorization, so a
        // public header there could hand the owner's page to the next visitor. Signed in is always private, no-store.
        const cacheControl = audience === 'public' && !viewer ? CACHE : 'private, no-store';
        return send(req, res, views.sessionReport({ report: rep, signedIn: Boolean(viewer), isOwner, audience, members }), 200, cacheControl);
    });

    r.get('/rundown/t/:slug', async (req, res) => {
        const { slug } = req.params;
        if (!isSlug(slug)) return notFound(req, res);
        const topic = await live.topic(slug);
        if (!topic) return notFound(req, res);
        // S7: a public agent report may cite the topic when the agent worked on it (only Everyone's reports).
        const citations = sessionReports ? await sessionReports.listPublicMatchingTopic((topic.topic && topic.topic.title) || topic.title).catch(() => []) : [];
        return send(req, res, views.topic({ topic, citations }));
    });

    r.get('/rundown/e/:streamId', async (req, res) => {
        if (!isStreamId(req.params.streamId)) return notFound(req, res);
        const episode = await live.episode(streamIdOf(req.params.streamId));
        if (!episode) return notFound(req, res);
        return send(req, res, views.episode({ episode }));
    });

    r.get('/rundown/s/:username', async (req, res) => {
        const { username } = req.params;
        if (!isUsername(username)) return notFound(req, res);
        const speaker = await live.speaker(username);
        if (!speaker) return notFound(req, res);
        return send(req, res, views.speaker({ speaker, username }));
    });

    r.get('/after-show/:streamId', async (req, res) => {
        if (!isStreamId(req.params.streamId)) return notFound(req, res);
        const recap = await live.recap(streamIdOf(req.params.streamId));
        if (!recap) return notFound(req, res);
        return send(req, res, views.recap({ recap }));
    });

    // A person's stats (the owner, 2026-11-09): /me is private and signed in only, with a switch per section; /u/<name>
    // is the same document with only the sections the person made public. Both are server-rendered, so the words and
    // the numbers are crawlable when published; /me is never indexed. The public page is the owner's last snapshot,
    // dated in the page, because Network's history can only be read with the person's own token.
    r.get('/me', async (req, res) => {
        const user = req.user;
        if (!user || !isUsername(String(user.username || ''))) return send(req, res, views.meSignedOut(), 200, 'private, no-store');
        const days = normaliseDays(req.query.days);
        try {
            const doc = await ctx.meStats.compute({ user, token: req.token, days });
            return send(req, res, views.me({ user, doc, days }), 200, 'private, no-store');
        } catch (err) {
            ctx.log.error('[OpenVibe.Report] the /me page failed:', err && err.message ? String(err.message).slice(0, 200) : err);
            return send(req, res, views.meError({ user }), 500, 'private, no-store');
        }
    });

    r.get('/u/:username', async (req, res) => {
        const { username } = req.params;
        if (!isUsername(username)) return notFound(req, res);
        const doc = ctx.meStats ? await ctx.meStats.publicFor(username) : null;
        if (!doc) return notFound(req, res);
        const published = ctx.meStats.anyPublished(doc.published);
        return send(req, res, published ? views.publicStats({ doc }) : views.publicStatsPrivate({ doc }), 200, published ? CACHE : 'private, no-store');
    });

    // A person's own numbers (plan L41 R1). Signed out: what it is and a sign-in. Signed in: their channel's streams and
    // after-show reports, the payments Billing says reached them, and The Rundown, over 7, 30 or 90 days. Private.
    r.get('/you', async (req, res) => {
        const user = req.user;
        if (!user || !isUsername(String(user.username || ''))) return send(req, res, views.youSignedOut(), 200, 'private, no-store');
        const days = normaliseDays(req.query.days);
        // Your AI (plan L40/L41): the ledger's own rows for this person, read in-process, never by a query value.
        const subject = typeof user.subject_id === 'string' ? user.subject_id.trim() : '';
        const from = new Date((ctx.now ? ctx.now() : Date.now()) - (days - 1) * 86400000).toISOString().slice(0, 10);
        const [stats, recaps, speaker, ai, reports] = await Promise.all([
            ctx.analytics && typeof ctx.analytics.channel === 'function' ? ctx.analytics.channel(user.username, days).catch(() => null) : null,
            Promise.resolve(live.channelRecaps(user.username)).catch(() => null),
            Promise.resolve(live.speaker(user.username)).catch(() => null),
            subject && ctx.aiUsage ? ctx.aiUsage.forPerson({ subject, from, group: 'day' }).catch(() => null) : null,
            subject && sessionReports ? sessionReports.listForOwner(subject, { limit: 20 }).catch(() => null) : null,
        ]);
        // Their own reports, each with the audience it has now, and the default for the next one.
        const withAudience = reports ? await Promise.all(reports.map(async (r) => ({ ...r, audience: await sharing.audienceOf(r) }))) : null;
        const defaultAudience = subject && sessionReports ? (await sessionReports.defaultAudience(subject)) || 'private' : 'private';
        return send(req, res, views.you({ user, days, stats, recaps, speaker, ai, reports: withAudience, defaultAudience }), 200, 'private, no-store');
    });

    r.get('/c/:username', async (req, res) => {
        const { username } = req.params;
        if (!isUsername(username)) return notFound(req, res);
        const [recaps, viewRows] = await Promise.all([live.channelRecaps(username), viewsData ? viewsData.creator(username, 30) : null]);
        if (!recaps) return notFound(req, res);
        return send(req, res, views.channel({ username, recaps, views: viewRows }));
    });

    return r;
}

module.exports = { createPageRoutes, createPublicPages };
