'use strict';
/**
 * The Report room's pages (plan 2026-10-28 §5.4). Server-rendered and whole without JavaScript; the Frame (navbar,
 * theme, footer) comes from openvibe-shared/shell, the front door from sc.room() and the accent from rooms.js.
 * server/http/pages.js builds each model from Network's open stats and Live's Rundown and after-show reports. Every
 * number shown is one a source gave, with its window or date; a missing one is left out, never shown as 0.
 *
 * AI-written text (headlines, summaries, takes) is labelled. The after-show report never prints the raw speech sample
 * or quotes of the transcript: it shows the AI's titles and topics and links to the moment in the recording.
 */
const shell = require('openvibe-shared/shell');
const ovServe = require('openvibe-shared/serve');
const appIcon = require('openvibe-shared/app-icon');
const kit = require('openvibe-shared/kit');
const seo = require('openvibe-shared/seo');
// The short home (the owner's rule, 2026-10-30): pick blocks and folds.
const { pickList, pickListRules, foldAround } = require('./short');
// A short name for a chip: the title, cut where it stops saying anything.
const clip = (s, n = 40) => { const x = String(s == null ? '' : s); return x.length > n ? `${x.slice(0, n - 1).trimEnd()}…` : x; };
const sc = require('openvibe-shared/showcase');
const rooms = require('openvibe-shared/rooms');
const { asset } = require('../assets');

const NAME = 'OpenVibe.Report';
const NETWORK = 'https://openvibe.network';
const BENCH = 'https://bench.openvibe.services';
const ROOM = rooms.get('report');
const esc = kit.esc;
let RELEASE = 'dev';
let BASE = 'https://openvibe.report';
function setRelease(id) { if (id) RELEASE = String(id); }
function configure({ baseUrl } = {}) { if (baseUrl) BASE = String(baseUrl).replace(/\/+$/, ''); }
const canon = (path) => `${BASE}${path}`;

// ── Formatting: numbers as people read them; dates in UTC (Live stores "YYYY-MM-DD hh:mm:ss" in UTC) ──
const n = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const fmt = (v) => { const x = n(v); if (x == null) return '—'; return Math.abs(x) >= 1e6 ? `${(x / 1e6).toFixed(1).replace(/\.0$/, '')}M` : Math.abs(x) >= 1e4 ? `${Math.round(x / 1e3)}k` : x.toLocaleString('en-US'); };
const exact = (v) => { const x = n(v); return x == null ? '—' : x.toLocaleString('en-US'); };
const ts = (s) => { const str = String(s || ''); const t = Date.parse(/[TZ]/.test(str) || !str.includes(' ') ? str : `${str.replace(' ', 'T')}Z`); return Number.isFinite(t) ? t : null; };
const day = (s) => { const t = ts(s); return t == null ? '' : new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); };
const dayTime = (s) => { const t = ts(s); return t == null ? '' : `${new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}, ${new Date(t).toISOString().slice(11, 16)} UTC`; };
const mins = (sec) => { const s = n(sec); if (s == null) return ''; const m = Math.round(s / 60); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };
const pct = (v) => { const x = n(v); if (x == null) return ''; return `<span class="rp-pill ${x > 0 ? 'is-up' : x < 0 ? 'is-down' : 'is-flat'}">${x > 0 ? '▲' : x < 0 ? '▼' : '•'} ${Math.abs(x)}%</span>`; };
const who = (u) => (u ? u.display_name || u.username || '' : '');
const AI = '<span class="rp-ai" title="Written by AI from the stream\'s own speech, chat and numbers">Written by AI</span>';

// ── The AI boards (OpenVibe.Bench, plan 2026-10-28 §4.12): every number is Bench's; Report renders it ──
/** Money as Bench quotes it (Report never derives a price): dollars, cents, or fractions of a cent. */
const usd = (v) => {
    const x = n(v);
    if (x == null) return '—';
    if (!x) return '$0';
    const a = Math.abs(x);
    if (a >= 1000) return `$${x.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
    if (a >= 1) return `$${x.toFixed(2)}`;
    if (a >= 0.01) return Math.abs(x - Math.round(x * 100) / 100) < 1e-9 ? `$${x.toFixed(2)}` : `$${Number(x.toPrecision(2))}`;
    return `$${Number(x.toPrecision(2))}`;
};
/** A share of games won or tasks passed: 0.8333 → 83%. */
const share = (v) => { const x = n(v); return x == null ? '—' : `${Math.round(x * 100)}%`; };
/** The rating with its 95% interval as text — "1043 ± 38" — the exact bounds in the title. */
function rating(r) {
    const elo = n(r && r.elo);
    if (elo == null) return '—';
    const lo = n(r && r.ci_lower), hi = n(r && r.ci_upper);
    if (lo == null || hi == null) return `${Math.round(elo)}`;
    const half = Math.round(Math.max(Math.abs(hi - elo), Math.abs(elo - lo)));
    return `<span title="95% interval ${Math.round(lo)}–${Math.round(hi)} Elo">${Math.round(elo)} ± ${half}</span>`;
}
/** Provisional: Bench marks it on the boards; a summary's games say the same thing (fewer than ten). */
const provisional = (r) => Boolean(r && (r.provisional != null ? r.provisional : n(r.games) != null && Number(r.games) < 10));
const flag = (r) => (provisional(r) ? ' <span class="rp-flag" title="Fewer than ten games: this rating can still move a lot">provisional</span>' : '');
const roomName = (id) => { const s = String(id || ''); return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; };
const judgeWord = (j) => ({ human_pairwise: 'voted on blind, two at a time', rubric: 'scored on a rubric', automatic_grader: 'graded automatically', test_suite: 'judged by a test suite', game_outcome: 'judged by the game outcome' }[j] || j || '—');
/** A kind's game count: every model's games added and halved, because two models play each game. */
const gamesOf = (rows) => Math.round((rows || []).reduce((sum, r) => sum + (n(r && r.games) || 0), 0) / 2);

const NAV = [
    { label: 'You', href: '/you', icon: 'fa-user' },
    { label: 'Numbers', href: '/stats', icon: 'fa-chart-line' },
    { label: 'The Rundown', href: '/rundown', icon: 'fa-newspaper' },
    { label: 'AI boards', href: '/ai', icon: 'fa-robot' },
    { label: 'API', href: '/developers', icon: 'fa-code', more: true },
];

function layout({ title, description, canonical = null, path = null, robots = 'index, follow', body, active = '/', jsonLd = [], agent = false, inlineStyles = [] }) {
    canonical = canonical || (path ? canon(path) : undefined);
    const navbar = {
        service: 'report',
        apiBase: NETWORK,
        links: NAV.map((l) => ({ ...l, active: l.href === active || (l.href !== '/' && active.startsWith(l.href)) })),
        appBar: [{ label: 'Home', href: '/', icon: 'fa-house' }, { label: 'Numbers', href: '/stats', icon: 'fa-chart-line' }, { label: 'Rundown', href: '/rundown', icon: 'fa-newspaper' }, { label: 'AI boards', href: '/ai', icon: 'fa-robot' }],
        history: { type: 'page', title: title || NAME },
        // Sign-in is this site's own (openvibe-sdk/sso at /auth): the navbar's buttons and its silent check use it.
        silentLogin: `${BASE}/auth/login?silent=1&next={url}`,
        loginUrl: '/auth/login?next={path}',
        logoutUrl: '/auth/logout?next={path}',
    };
    const footer = { service: 'report', variant: 'full', mount: '#ov-footer', brandName: NAME };
    return shell.page({
        name: NAME,
        lang: 'en',
        title: title || `${NAME}: ${ROOM.line}`,
        titleSuffix: title ? ` · ${NAME}` : '',
        siteName: NAME,
        description: description || 'The network\'s numbers open to everyone, what streamers talked about in The Rundown, and every stream\'s after-show report.',
        canonical,
        // A page with a Markdown twin (server/agent-pages.js) names it in the head; only twinned pages set agent.
        agentLayer: agent,
        llms: `${BASE}/llms.txt`,
        robots,
        jsonLd,
        home: '/',
        navLinks: NAV,
        navbar,
        footer,
        head: `${appIcon.headTags({ site: 'report' })}
<link rel="stylesheet" href="${esc(ovServe.url('kit.css'))}">
<link rel="stylesheet" href="${esc(ovServe.url('kit-data.css'))}">
<link rel="stylesheet" href="${esc(ovServe.url('room.css'))}">
<link rel="stylesheet" href="${esc(ovServe.url('showcase.css'))}">
<link rel="stylesheet" href="${esc(asset('css/app.css'))}">
<script src="${esc(ovServe.url('kit-web.js'))}" defer></script>
<script src="${esc(ovServe.url('kit-data-web.js'))}" defer></script>
<script src="${esc(ovServe.url('motion.js'))}" defer></script>
${(inlineStyles || []).map((css) => `<style>${css}</style>`).join('\n')}
<meta name="ov-boost" content="report@${esc(RELEASE)}">`,
        body: `<a class="skip" href="#main">Skip to content</a>
<div id="navbar-mount"></div>
<main id="main" class="rp ov-room" style="${rooms.style('report')}"><div class="rp-wrap">${body}</div></main>
<script>window.__OV_PAGE = ${JSON.stringify({ navbar, footer }).replace(/</g, '\\u003c')};
document.addEventListener('DOMContentLoaded', function () { try { if (window.OpenVibeFooter) OpenVibeFooter.init(window.__OV_PAGE.footer); } catch (e) { /* optional */ } });</script>`,
    });
}

// ── Charts: server-drawn SVG, crisp at any size, each with its numbers for screen readers ──
function bars(points, label, { h = 140 } = {}) {
    const pts = (points || []).filter((p) => p && n(p.n) != null);
    if (pts.length < 2) return '';
    const max = Math.max(1, ...pts.map((p) => Number(p.n)));
    const w = 100 / pts.length;
    const cols = pts.map((p, i) => { const v = Number(p.n); const bh = Math.max(1.5, (v / max) * (h - 18)); return `<rect x="${(i * w + w * 0.14).toFixed(2)}%" y="${(h - bh).toFixed(1)}" width="${(w * 0.72).toFixed(2)}%" height="${bh.toFixed(1)}" rx="3"><title>${esc(day(p.day))}: ${exact(v)}</title></rect>`; }).join('');
    const first = pts[0], last = pts[pts.length - 1];
    return `<figure class="rp-bars"><svg viewBox="0 0 100 ${h}" preserveAspectRatio="none" role="img" aria-label="${esc(`${label}: ${pts.map((p) => `${day(p.day)} ${exact(p.n)}`).join(', ')}`)}">${cols}</svg>`
        + `<figcaption><span>${esc(day(first.day))}</span><span>${esc(day(last.day))}</span></figcaption></figure>`;
}
function spark(points) {
    const vals = (points || []).map((p) => n(p && p.n)).filter((v) => v != null);
    if (vals.length < 2) return '';
    const max = Math.max(1, ...vals), W = 240, H = 56;
    const xy = vals.map((v, i) => [(i / (vals.length - 1)) * W, H - 4 - (v / max) * (H - 10)]);
    const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
    return `<svg class="rp-spark" viewBox="0 0 ${W} ${H}" aria-hidden="true"><path class="rp-spark-area" d="${line} L${W} ${H} L0 ${H}Z"/><path class="rp-spark-line" d="${line}"/></svg>`;
}
/** A stream's viewers minute by minute (Live's curve: [time, viewers, chat messages]). */
function curve(points) {
    const pts = (points || []).filter((p) => Array.isArray(p) && ts(p[0]) != null);
    if (pts.length < 2) return '';
    const W = 600, H = 150, t0 = ts(pts[0][0]), t1 = ts(pts[pts.length - 1][0]);
    const maxV = Math.max(1, ...pts.map((p) => Number(p[1]) || 0)), maxC = Math.max(1, ...pts.map((p) => Number(p[2]) || 0));
    const X = (t) => ((t - t0) / Math.max(1, t1 - t0)) * W;
    const view = pts.map((p, i) => `${i ? 'L' : 'M'}${X(ts(p[0])).toFixed(1)} ${(H - 8 - ((Number(p[1]) || 0) / maxV) * (H - 24)).toFixed(1)}`).join(' ');
    const chat = pts.map((p) => { const c = Number(p[2]) || 0; if (!c) return ''; const bh = (c / maxC) * 36; return `<rect x="${(X(ts(p[0])) - 1.5).toFixed(1)}" y="${(H - bh).toFixed(1)}" width="3" height="${bh.toFixed(1)}" rx="1"/>`; }).join('');
    return `<figure class="rp-curve"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(`Viewers over the stream, peak ${exact(maxV)}; chat messages as bars`)}"><g class="rp-curve-chat">${chat}</g><path class="rp-curve-area" d="${view} L${W} ${H} L0 ${H}Z"/><path class="rp-curve-line" d="${view}"/></svg>`
        + `<figcaption><span>${esc(dayTime(pts[0][0]))}</span><span class="rp-legend"><i class="is-v"></i>viewers <i class="is-c"></i>chat</span><span>${esc(new Date(t1).toISOString().slice(11, 16))} UTC</span></figcaption></figure>`;
}

const tile = (label, value, sub = '', extra = '') => (value == null || value === '' ? '' : `<div class="rp-tile"><span class="rp-tile-l">${esc(label)}</span><b class="rp-tile-v">${value}</b>${sub ? `<span class="rp-tile-s">${sub}</span>` : ''}${extra}</div>`);
const KIND = { games: 'Games', chat: 'Chat', irl: 'IRL', news: 'News', tech: 'Tech', music: 'Music', art: 'Art' };

/** A Rundown take or segment as a row: the AI's title, what was said (AI), the streamer and when. */
function takeRow(t) {
    if (!t) return '';
    const sid = t.stream_id || (t.stream && t.stream.id);
    const by = who(t.user || (t.stream && t.stream.user));
    return `<li class="rp-take"><h3>${sid ? `<a href="/rundown/e/${encodeURIComponent(sid)}">${esc(t.title)}</a>` : esc(t.title)}</h3>${t.what ? `<p>${esc(t.what)}</p>` : ''}`
        + `<p class="rp-meta">${by ? `<a href="/rundown/s/${encodeURIComponent((t.user || (t.stream && t.stream.user) || {}).username || '')}">${esc(by)}</a>` : ''}${t.at || t.started_at ? `<time>${esc(dayTime(t.at || t.started_at))}</time>` : ''}</p></li>`;
}
function topicCard(t, i) {
    if (!t || !t.slug) return '';
    return `<li${i == null ? '' : ` data-i="${i}"`}><a class="rp-topic" href="/rundown/t/${encodeURIComponent(t.slug)}"><span class="rp-kind">${esc(KIND[t.kind] || t.kind || 'Topic')}</span><b>${esc(t.title)}</b>${t.headline ? `<span class="rp-topic-h">${esc(t.headline)}</span>` : ''}`
        + `<span class="rp-meta">${[n(t.takes) ? `${exact(t.takes)} takes` : '', n(t.streamers) ? `${exact(t.streamers)} streamer${Number(t.streamers) === 1 ? '' : 's'}` : '', t.last_seen_at ? day(t.last_seen_at) : ''].filter(Boolean).map(esc).join(' · ')}</span></a></li>`;
}
function streamCard(s) {
    if (!s || !s.stream_id) return '';
    const ep = s.episode && s.episode.title ? s.episode : null;
    return kit.card({ href: `/after-show/${s.stream_id}`, title: ep ? ep.title : s.title || 'Stream', peek: ep ? (ep.logline || s.title || '') : '', type: 'stream', live: !!s.live, corner: n(s.minutes) ? `${s.minutes} min` : '', who: who(s.user), avatar: s.user && s.user.avatar_url, when: s.started_at ? ts(s.started_at) : null, image: s.thumbnail_url || '', count: n(s.takes_total) ? [s.takes_total, 'takes'] : null });
}

// ── Pages ──
function home({ stats, rundown, topics } = {}) {
    const T = (stats && stats.totals) || {};
    const L = (stats && stats.live) || {};
    const R = rundown || {};
    const streams = (R.streams || []).slice(0, 10).map(streamCard).filter(Boolean);
    const trending = ((topics && topics.topics) || R.trending || []).slice(0, 6);
    const lead = R.lead;
    const leadHTML = lead ? `<section class="rp-lead" aria-labelledby="rp-lead-h"><p class="rp-kicker">The Rundown · lead</p><h2 id="rp-lead-h">${lead.stream_id || (lead.stream && lead.stream.id) ? `<a href="/rundown/e/${encodeURIComponent(lead.stream_id || lead.stream.id)}">${esc(lead.title)}</a>` : esc(lead.title)}</h2>`
        + `${lead.what ? `<p class="rp-lead-what">${esc(lead.what)}</p>` : ''}${lead.take ? `<p class="rp-lead-take">${esc(lead.take)}</p>` : ''}<p class="rp-meta">${AI}${who(lead.user) ? ` · ${esc(who(lead.user))}` : ''}</p></section>` : '';
    const topicsHTML = trending.length ? `<section aria-labelledby="rp-tr-h"><div class="rp-head-row"><h2 id="rp-tr-h">What streamers talked about</h2><a class="rp-more" href="/rundown">The Rundown${kit.icon('chevron')}</a></div><ul class="rp-topics pick-list">${trending.map((t, i) => topicCard(t, i)).join('')}</ul></section>` : '';
    // The short home (the owner's rule, 2026-10-30): the topics are one pick block, a row of chips picks one of them,
    // and the parts a reader rarely needs are folds.
    const topicsBlock = trending.length ? pickList({
        key: 'topics',
        label: 'What streamers talked about',
        head: 'What streamers talked about',
        labels: trending.map((t) => clip(t.title, 40)),
        html: topicsHTML,
    }) : '';
    const pv = stats && stats.pageviews_daily;
    const numbersScene = pv && pv.length > 1 ? {
        title: 'Every number says what it counts',
        text: `${stats.note || 'Counts only, never about a person.'} The same numbers are open JSON for anyone to reuse.`,
        html: `<div class="rp-scene-num"><span class="rp-tile-l">Page views, last ${esc(stats.window_days || 7)} days</span><b>${exact(T.pageviews)}</b>${pct(T.change_pct)}${spark(pv)}</div>`,
        action: { href: '/stats', label: 'All the numbers' },
    } : null;
    const body = sc.room({
        room: 'report',
        hero: {
            title: ROOM.line,
            lede: 'The network\'s numbers, open to everyone. What streamers talked about, written up. Every stream\'s after-show report. Each number with what it counts and when.',
            start: { href: '/stats', label: 'See the numbers' },
            chips: [{ label: 'Last 7 days', href: '/stats?days=7' }, { label: 'Last 30 days', href: '/stats?days=30' }, { label: 'The Rundown', href: '/rundown' }],
        },
        proof: [
            { value: n(T.pageviews), label: 'page views this week', asOf: stats && stats.generated_at ? day(stats.generated_at) : null },
            { value: n(T.accounts), label: 'accounts' },
            { value: n(L.streams), label: 'streams so far' },
            { value: n(R.counts && R.counts.takes), label: 'takes written up' },
        ].filter((p) => p.value),
        rails: streams.length ? [{ id: 'after-show', title: 'After-show reports', more: { href: '/rundown', label: 'The Rundown' }, items: streams }] : [],
        html: leadHTML + topicsBlock,
        scenes: [numbersScene].filter(Boolean),
        explore: { title: 'More on Report', items: [
            { title: 'Every site\'s numbers', text: 'Page views, people, streams and how fast each service answers', href: '/stats', icon: 'ov:gauge' },
            { title: 'The Rundown', text: 'What streamers talked about, topic by topic', href: '/rundown', icon: 'ov:news' },
            { title: 'AI boards', text: 'Every benchmark kind, its leader, quality against cost and cost per solved task', href: '/ai', icon: 'ov:ai' },
            { title: 'Status', text: 'Whether every OpenVibe service is up right now', href: 'https://openvibe.network/status', icon: 'ov:ping' },
        ] },
        dev: { title: 'For developers', lede: 'Every number here is open JSON, readable from any site.', samples: [
            { label: 'The network, last 30 days', lang: 'bash', code: 'curl "https://openvibe.report/api/v1/stats?days=30"' },
            { label: 'The Rundown', lang: 'bash', code: 'curl https://openvibe.report/api/v1/rundown/topics' },
        ], links: [{ label: 'The API', href: '/developers' }, { label: 'llms.txt', href: '/llms.txt' }] },
        faq: { items: [
            ['Where do these numbers come from?', 'From the services themselves: page views from the shared navbar\'s anonymous counter and OpenVibe.Live\'s own analytics, traffic from the servers\' metrics, streams and chat from Live. Each page says what a number counts and when it was read.'],
            ['Is anything here about me?', 'No. Every number is a count. The Rundown and the after-show reports are about public streams, and a streamer can opt out of The Rundown.'],
            ['Who writes the after-show reports?', 'An AI, from the stream\'s own numbers, chat and speech, and it says so on every report. It describes what happened, people included.'],
        ] },
    });
    // The numbers, the code samples and the questions are the parts a reader rarely needs on a phone.
    let out = foldAround(body, '>Every number says what it counts</h2>', 'numbers', '<h2 id="rp-numbers-h">Every number says what it counts</h2>');
    out = foldAround(out, '>For developers</h2>', 'dev', '<h2 id="rp-dev-h">For developers</h2>');
    out = foldAround(out, '>Questions</h2>', 'faq', '<h2 id="rp-faq-h">Questions</h2>');
    return layout({
        title: null, body: out, active: '/', path: '/', agent: true,
        jsonLd: [seo.jsonLd.website({ name: 'OpenVibe.Report', url: 'https://openvibe.report/', description: "The network's numbers open to everyone, what streamers talked about in The Rundown, and every stream's after-show report." }), seo.jsonLd.organization()],
        // The rule that shows the picked topic of the pick list: one per topic, written for this page.
        inlineStyles: [`@supports selector(:has(*)){@media (max-width:640px){${pickListRules('topics', trending.length)}}}`],
    });
}

function stats({ stats: d, days = 30 } = {}) {
    const T = d.totals || {}, L = d.live, C = d.coins, A = d.accounts;
    const tabs = [7, 30, 90].map((x) => `<a href="/stats?days=${x}"${Number(days) === x ? ' aria-current="page"' : ''}>${x} days</a>`).join('');
    const sites = (d.sites || []).filter((s) => s && s.name).map((s) => `<div class="rp-tr" role="row"><span role="cell" class="rp-site"><a href="${esc(s.url || '#')}">${esc(s.name || s.short)}</a><small>${esc(s.host || '')}</small></span>`
        + `<span role="cell" data-l="Page views">${s.pageviews == null ? '—' : exact(s.pageviews)} ${pct(s.change_pct)}</span>`
        + `<span role="cell" data-l="Visitors">${s.unique_visitors == null ? '—' : exact(s.unique_visitors)}</span>`
        + `<span role="cell" data-l="Requests, 24 h">${s.traffic_24h && s.traffic_24h.requests != null ? fmt(s.traffic_24h.requests) : '—'}</span>`
        + `<span role="cell" data-l="95% answered in">${s.traffic_24h && s.traffic_24h.p95_ms != null ? `${exact(s.traffic_24h.p95_ms)} ms` : '—'}</span></div>`).join('');
    const body = `<header class="rp-page-h"><p class="rp-kicker">Open numbers</p><h1>Every OpenVibe site's numbers</h1>
<p class="rp-lede">Public for everyone, counts only, never about a person.${d.generated_at ? ` Read ${esc(dayTime(d.generated_at))}.` : ''}</p><nav class="rp-tabs" aria-label="Time range">${tabs}</nav></header>
<section class="rp-tiles" aria-label="Across the network">
${tile(`Page views, ${d.window_days || days} days`, exact(T.pageviews), pct(T.change_pct), spark(d.pageviews_daily))}
${A ? tile('Accounts', exact(A.total), A.new != null ? `+${exact(A.new)} in ${d.window_days || days} days` : '') : ''}
${T.services ? tile('Services up', `${exact(T.services.up)}<small> of ${exact(T.services.checked)}</small>`, '<a href="https://openvibe.network/status">Status</a>') : ''}
${T.requests_24h != null ? tile('Requests, 24 h', fmt(T.requests_24h), T.sites_open ? `${exact(T.sites_open)} sites` : '') : ''}
${L ? tile('Live right now', exact(L.live_now), L.watching != null ? `${exact(L.watching)} watching` : '') : ''}
${C ? tile('OpenCoins earned', fmt(C.earned), C.earned_window != null ? `+${fmt(C.earned_window)} in ${d.window_days || days} days` : '') : ''}
</section>
${d.pageviews_daily && d.pageviews_daily.length > 1 ? `<section aria-labelledby="rp-pv-h"><h2 id="rp-pv-h">Page views a day</h2>${bars(d.pageviews_daily, 'Page views a day')}</section>` : ''}
${sites ? `<section aria-labelledby="rp-sites-h"><h2 id="rp-sites-h">Every site</h2><p class="rp-fine">Most visited first over ${esc(d.window_days || days)} days; requests and speed (95% of answers were at least this fast) over the last 24 hours.</p>
<div class="rp-table" role="table" aria-label="Every site"><div class="rp-tr rp-th" role="row"><span role="columnheader">Site</span><span role="columnheader">Page views</span><span role="columnheader">Visitors</span><span role="columnheader">Requests, 24 h</span><span role="columnheader">95% answered in</span></div>${sites}</div></section>` : ''}
${L ? `<section aria-labelledby="rp-live-h"><h2 id="rp-live-h">OpenVibe.Live</h2><div class="rp-minis">${[['Streamers', L.streamers], ['Streams', L.streams], ['Hours watched', L.hours_watched], ['Chat messages', L.messages], ['Recordings', L.vods], ['Clips', L.clips], ['AI moments', L.ai_moments]].filter(([, v]) => n(v)).map(([l, v]) => `<div><b>${fmt(v)}</b><span>${esc(l)}</span></div>`).join('')}</div></section>` : ''}
${A && A.daily && A.daily.length > 1 ? `<section aria-labelledby="rp-acc-h"><h2 id="rp-acc-h">New accounts a day</h2>${bars(A.daily, 'New accounts a day', { h: 110 })}</section>` : ''}
<section aria-labelledby="rp-how-h"><h2 id="rp-how-h">How these are counted</h2><p class="rp-fine">${esc(d.note || '')} The same numbers: <a href="/api/v1/stats?days=${esc(days)}"><code>/api/v1/stats</code></a>. How closely each site follows the design kit, read from its code: <a href="/design">Design health</a>.</p></section>`;
    return layout({ title: `Every site's numbers, ${days} days`, description: 'Page views, people, streams and how fast each OpenVibe service answers, open to everyone.', body, active: '/stats', path: `/stats${Number(days) === 30 ? '' : `?days=${Number(days)}`}`, agent: true });
}

function rundown({ rundown: R = {}, topics } = {}) {
    const all = ((topics && topics.topics) || []).slice(0, 24);
    const onAir = (R.on_air || []).map(streamCard).filter(Boolean);
    const voices = (R.voices || []).slice(0, 12);
    const streams = (R.streams || []).slice(0, 12).map(streamCard).filter(Boolean);
    const body = `<header class="rp-page-h"><p class="rp-kicker">The Rundown</p><h1>What streamers talked about</h1>
<p class="rp-lede">Written up from what was said on stream: topics, takes and how they connect. ${AI}</p>
${R.counts ? `<p class="rp-counts">${[['topics', R.counts.topics], ['episodes', R.counts.episodes], ['takes', R.counts.takes]].filter(([, v]) => n(v)).map(([l, v]) => `<span><b>${exact(v)}</b> ${l}</span>`).join('')}</p>` : ''}</header>
${onAir.length ? kit.rail({ id: 'on-air', title: 'On air now', items: onAir }) : ''}
${R.lead ? `<section class="rp-lead" aria-labelledby="rp-lead-h"><p class="rp-kicker">Lead</p><h2 id="rp-lead-h">${esc(R.lead.title)}</h2>${R.lead.what ? `<p class="rp-lead-what">${esc(R.lead.what)}</p>` : ''}${R.lead.take ? `<p class="rp-lead-take">${esc(R.lead.take)}</p>` : ''}</section>` : ''}
${all.length ? `<section aria-labelledby="rp-t-h"><h2 id="rp-t-h">Topics</h2><ul class="rp-topics">${all.map(topicCard).join('')}</ul></section>` : ''}
${voices.length ? `<section aria-labelledby="rp-v-h"><h2 id="rp-v-h">Voices</h2><ul class="rp-voices">${voices.map((v) => `<li><a href="/rundown/s/${encodeURIComponent((v.user || {}).username || '')}">${kit.mark({ name: who(v.user), src: v.user && v.user.avatar_url, size: 40 })}<span><b>${esc(who(v.user))}</b><small>${[n(v.topics) ? `${exact(v.topics)} topics` : '', n(v.segments) ? `${exact(v.segments)} takes` : ''].filter(Boolean).join(' · ')}</small></span></a></li>`).join('')}</ul></section>` : ''}
${streams.length ? kit.rail({ id: 'episodes', title: 'Recent streams', items: streams }) : ''}`;
    return layout({ title: 'The Rundown: what streamers talked about', description: 'Topics, takes and crossovers from what streamers said on OpenVibe, written up by AI from the streams themselves.', body, active: '/rundown', path: '/rundown' });
}

function topic({ topic: d } = {}) {
    const t = d.topic || {};
    const takes = (d.takes || []).slice(0, 40);
    const body = `<header class="rp-page-h"><p class="rp-kicker"><a href="/rundown">The Rundown</a> · ${esc(KIND[t.kind] || t.kind || 'Topic')}</p><h1>${esc(t.title)}</h1>
${t.headline ? `<p class="rp-lede">${esc(t.headline)}</p>` : ''}${t.summary ? `<p class="rp-summary">${esc(t.summary)}</p>` : ''}<p class="rp-meta">${AI}${t.first_seen_at ? ` · since ${esc(day(t.first_seen_at))}` : ''}</p></header>
${takes.length ? `<section aria-labelledby="rp-tk-h"><h2 id="rp-tk-h">Takes</h2><ol class="rp-takes">${takes.map(takeRow).join('')}</ol></section>` : ''}
${(d.related || []).length ? `<section aria-labelledby="rp-rel-h"><h2 id="rp-rel-h">Related</h2><ul class="rp-chips">${d.related.slice(0, 12).map((r) => `<li><a href="/rundown/t/${encodeURIComponent(r.slug)}">${esc(r.title)}</a></li>`).join('')}</ul></section>` : ''}`;
    return layout({ title: `${t.title}: The Rundown`, description: t.headline || `What streamers said about ${t.title}.`, body, active: '/rundown', path: `/rundown/t/${encodeURIComponent(t.slug || '')}` });
}

function episode({ episode: d } = {}) {
    const e = d.episode || {}, s = d.stream || {};
    const segs = (d.segments || []).slice(0, 60);
    const body = `<header class="rp-page-h"><p class="rp-kicker"><a href="/rundown">The Rundown</a> · episode</p><h1>${esc(e.title || s.title || 'Episode')}</h1>${e.logline ? `<p class="rp-lede">${esc(e.logline)}</p>` : ''}
<p class="rp-meta">${AI}${who(s.user) ? ` · <a href="/rundown/s/${encodeURIComponent(s.user.username)}">${esc(who(s.user))}</a>` : ''}${s.started_at ? ` · ${esc(dayTime(s.started_at))}` : ''}${s.id ? ` · <a href="/after-show/${encodeURIComponent(s.id)}">After-show report</a>` : ''}</p></header>
${segs.length ? `<section aria-labelledby="rp-sg-h"><h2 id="rp-sg-h">What happened</h2><ol class="rp-takes rp-timeline">${segs.map(takeRow).join('')}</ol></section>` : ''}
${(d.more || []).length ? `<section aria-labelledby="rp-mo-h"><h2 id="rp-mo-h">More from ${esc(who(s.user) || 'this streamer')}</h2><ul class="rp-chips">${d.more.slice(0, 8).map((m) => `<li><a href="/rundown/e/${encodeURIComponent(m.stream_id)}">${esc(m.title)}</a></li>`).join('')}</ul></section>` : ''}`;
    return layout({ title: `${e.title || s.title}: The Rundown`, description: e.logline || '', body, active: '/rundown', path: `/rundown/e/${encodeURIComponent(s.id || e.stream_id || '')}` });
}

function speaker({ speaker: d, username } = {}) {
    const u = d.user || { username };
    if (d.opted_out) return layout({ title: `${who(u)}: The Rundown`, robots: 'noindex, follow', body: `<header class="rp-page-h"><h1>${esc(who(u))}</h1><p class="rp-lede">${esc(who(u))} has opted out of The Rundown: nothing they say on stream is written up here.</p></header>`, active: '/rundown' });
    const body = `<header class="rp-page-h rp-person">${kit.mark({ name: who(u), src: u.avatar_url, size: 64 })}<div><p class="rp-kicker">The Rundown · voice</p><h1>${esc(who(u))}</h1><p class="rp-meta"><a href="https://openvibe.live/@${encodeURIComponent(u.username || username)}">Channel on OpenVibe.Live</a> · <a href="/c/${encodeURIComponent(u.username || username)}">After-show reports</a></p></div></header>
${(d.topics || []).length ? `<section aria-labelledby="rp-st-h"><h2 id="rp-st-h">Topics</h2><ul class="rp-topics">${d.topics.slice(0, 12).map(topicCard).join('')}</ul></section>` : ''}
${(d.lines || []).length ? `<section aria-labelledby="rp-sl-h"><h2 id="rp-sl-h">Takes</h2><ol class="rp-takes">${d.lines.slice(0, 20).map(takeRow).join('')}</ol><p class="rp-meta">${AI}</p></section>` : ''}
${(d.episodes || []).length ? `<section aria-labelledby="rp-se-h"><h2 id="rp-se-h">Episodes</h2><ul class="rp-chips">${d.episodes.slice(0, 12).map((m) => `<li><a href="/rundown/e/${encodeURIComponent(m.stream_id)}">${esc(m.title)}</a></li>`).join('')}</ul></section>` : ''}`;
    return layout({ title: `${who(u)}: The Rundown`, description: `What ${who(u)} talked about on stream, topic by topic.`, body, active: '/rundown', path: `/rundown/s/${encodeURIComponent(u.username || username || '')}` });
}

function recap({ recap: d } = {}) {
    const r = d.recap || d;
    const s = r.stream || {}, u = r.streamer || {}, v = r.viewers || {}, c = r.chat || {}, love = r.love || {}, w = r.write || {}, vod = r.vod;
    const takes = (r.takes || []).filter((t) => t && t.title).sort((a, b) => (n(a.sec) ?? 1e9) - (n(b.sec) ?? 1e9)).slice(0, 8);
    const at = (sec) => (vod && vod.id && n(sec) != null ? `https://openvibe.video/v/${encodeURIComponent(vod.id)}?t=${Math.max(0, Math.floor(Number(sec)))}` : null);
    const body = `<header class="rp-page-h rp-recap-h"><p class="rp-kicker">After-show report</p><h1>${esc(w.headline || s.title || 'Stream')}</h1>
<p class="rp-meta">${kit.mark({ name: who(u), src: u.avatar_url, size: 28 })} <a href="https://openvibe.live/@${encodeURIComponent(u.username || '')}">${esc(who(u))}</a>${s.title && w.headline ? ` · ${esc(s.title)}` : ''}${s.started_at ? ` · ${esc(dayTime(s.started_at))}` : ''}${n(s.duration_seconds) ? ` · ${esc(mins(s.duration_seconds))}` : ''}</p>
${w.summary ? `<p class="rp-summary">${esc(w.summary)}</p><p class="rp-meta">${AI}</p>` : ''}</header>
<section class="rp-tiles" aria-label="The stream in numbers">
${tile('Peak viewers', n(s.peak_viewers) != null ? exact(s.peak_viewers) : null, v.peak_at ? esc(dayTime(v.peak_at)) : '')}
${tile('Average viewers', n(v.avg) != null ? exact(v.avg) : null)}
${tile('Chat messages', n(c.messages) ? exact(c.messages) : null, n(c.chatters) ? `${exact(c.chatters)} chatting` : '')}
${tile('New followers', n(love.follows) ? exact(love.follows) : null, n(love.followers_now) ? `${exact(love.followers_now)} now` : '')}
${tile('Tips', n(love.tips) ? exact(love.tips) : null)}
${tile('Length', n(s.duration_seconds) ? esc(mins(s.duration_seconds)) : null)}
</section>
${curve(v.curve) ? `<section aria-labelledby="rp-cv-h"><h2 id="rp-cv-h">Minute by minute</h2>${curve(v.curve)}</section>` : ''}
${takes.length ? `<section aria-labelledby="rp-rt-h"><h2 id="rp-rt-h">The moments</h2><ol class="rp-moments">${takes.map((t) => `<li>${at(t.sec) ? `<a class="rp-at" href="${esc(at(t.sec))}">${kit.icon('play')}<span>${esc(mins(t.sec) || '0 min')}</span></a>` : ''}<span><b>${esc(t.title)}</b>${t.topic ? `<a class="rp-kind" href="/rundown/t/${encodeURIComponent(t.slug || '')}">${esc(t.topic)}</a>` : ''}</span></li>`).join('')}</ol><p class="rp-meta">${AI}</p></section>` : ''}
${(c.top || []).length ? `<section aria-labelledby="rp-ch-h"><h2 id="rp-ch-h">Most active in chat</h2><ul class="rp-chips">${c.top.slice(0, 8).map((x) => `<li><span>${esc(x.display_name || x.username)} <b>${exact(x.n)}</b></span></li>`).join('')}</ul></section>` : ''}
<p class="rp-act">${vod && vod.id ? `<a class="rp-btn" href="https://openvibe.video/v/${encodeURIComponent(vod.id)}">Watch the recording</a>` : ''} <a class="rp-btn is-quiet" href="/c/${encodeURIComponent(u.username || '')}">More from ${esc(who(u))}</a>${s.id ? ` <a class="rp-btn is-quiet" href="/rundown/e/${encodeURIComponent(s.id)}">In The Rundown</a>` : ''}</p>`;
    return layout({ title: `${w.headline || s.title}: after-show report`, description: w.summary || `How ${who(u)}'s stream went, in numbers.`, body, active: '/rundown', path: `/after-show/${encodeURIComponent(s.id || '')}` });
}

function channel({ username, recaps } = {}) {
    const list = (recaps && recaps.recaps) || [];
    const cards = list.slice(0, 30).map((x) => kit.card({ href: `/after-show/${x.stream_id}`, title: x.headline || x.title || 'Stream', peek: x.headline && x.title ? x.title : '', type: 'stream', image: x.thumbnail_url || '', badge: x.grade ? `Grade ${x.grade}` : '', corner: n(x.duration_seconds) ? mins(x.duration_seconds) : '', count: n(x.peak_viewers) ? [x.peak_viewers, 'peak'] : null, when: x.ended_at ? ts(x.ended_at) : null }));
    const body = `<header class="rp-page-h"><p class="rp-kicker">After-show reports</p><h1>${esc(username)}</h1><p class="rp-meta"><a href="https://openvibe.live/@${encodeURIComponent(username)}">Channel on OpenVibe.Live</a> · <a href="/rundown/s/${encodeURIComponent(username)}">In The Rundown</a></p></header>
${cards.length ? `<ul class="rp-grid">${cards.map((c) => `<li>${c}</li>`).join('')}</ul>` : kit.empty({ title: 'No reports yet', text: 'A report is written a few minutes after each stream ends.' })}`;
    return layout({ title: `${username}: after-show reports`, description: `How each of ${username}'s streams went.`, body, active: '/rundown', path: `/c/${encodeURIComponent(username)}` });
}

// ── You (plan L41 R1): a person's own numbers, signed in, in one place ──
// A sentence first, then each part that has something in it: streams, money, The Rundown. AI use, agents and
// machines join as their records reach Report (L40). Private: never cached, never indexed.
const plural = (v, one, many) => `${exact(v)} ${Number(v) === 1 ? one : many}`;
const hours = (sec) => { const h = (n(sec) || 0) / 3600; return h >= 10 ? `${Math.round(h)} h` : h >= 1 ? `${h.toFixed(1).replace(/\.0$/, '')} h` : `${Math.round(h * 60)} min`; };

function youSentence({ name, days, stats, speaker }) {
    const T = (stats && stats.totals) || {};
    const parts = [];
    if (n(T.streams)) parts.push(`streamed ${plural(T.streams, 'time', 'times')} for ${hours(T.stream_seconds)}${n(T.peak_viewers) ? `, with up to ${plural(T.peak_viewers, 'viewer', 'viewers')} at once` : ''}`);
    if (n(T.messages)) parts.push(`drew ${plural(T.messages, 'chat message', 'chat messages')}${n(T.unique_chatters) ? ` from ${plural(T.unique_chatters, 'person', 'people')}` : ''}`);
    const rev = stats && stats.revenue;
    if (rev && n(rev.transactions)) parts.push(`received ${plural(rev.transactions, 'payment', 'payments')} in Vibes`);
    const eps = speaker && !speaker.opted_out ? (speaker.episodes || []).length : 0;
    if (eps) parts.push(`were written up in The Rundown ${plural(eps, 'time', 'times')}`);
    if (!parts.length) return `Nothing to count for you in the last ${days} days yet. Go live, and every stream gets its own report here.`;
    const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
    return `In the last ${days} days, ${name}, you ${list}.`;
}

// Your AI on /you (plan L40/L41): who paid, in words a person uses.
const PAID_BY = { own_key: 'Your own keys', openvibe_key: 'The OpenVibe key', plan: 'Your plan', own_machine: 'Your own machine', free_tier: 'Free tiers', network_allowance: 'OpenVibe\u2019s allowance', org_key: 'Your organisation\u2019s key' };
const aiUsd = (v) => { const x = n(v); if (x == null) return '\u2014'; if (x === 0) return '$0'; return x < 0.01 ? 'under $0.01' : `$${x.toFixed(x < 10 ? 2 : 0)}`; };
const bigNum = (v) => { const x = n(v) || 0; return x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : x >= 1e4 ? `${Math.round(x / 1e3)}k` : exact(x); };

function youAi(ai, days) {
    const T = ai && ai.totals;
    if (!T || !n(T.calls)) {
        return `<section aria-labelledby="rp-you-ai"><h2 id="rp-you-ai">Your AI</h2><p class="rp-fine">No AI calls in the last ${esc(days)} days. When you use AI on any OpenVibe site, it is counted here: the tokens, how much came from cache, what it cost and whose key paid. Only you see it.</p></section>`;
    }
    const tokens = (n(T.input_tokens) || 0) + (n(T.output_tokens) || 0);
    const cacheShare = (n(T.cached_tokens) || 0) / Math.max(1, (n(T.input_tokens) || 0) + (n(T.cached_tokens) || 0));
    const daily = (ai.rows || []).map((r) => ({ day: r.key, n: n(r.calls) || 0 }));
    const paid = Object.entries(ai.by_paid_by || {}).filter(([, v]) => v && n(v.calls)).sort((a, b) => (n(b[1].calls) || 0) - (n(a[1].calls) || 0));
    const chips = paid.map(([k, v]) => `<li><b>${esc(PAID_BY[k] || k)}</b> ${esc(plural(v.calls, 'call', 'calls'))} \u00b7 ${n(v.charged_usd) ? esc(aiUsd(v.charged_usd)) + (n(v.fee_usd) ? ` incl. ${esc(aiUsd(v.fee_usd))} fee` : '') : 'no charge'}</li>`).join('');
    const lines = (ai.insights || []).slice(0, 3);
    return `<section aria-labelledby="rp-you-ai"><h2 id="rp-you-ai">Your AI</h2>
${lines.length ? `<p class="rp-lede">${esc(lines[0])}</p>` : ''}
<div class="rp-tiles rp-tiles-sm">${tile('Calls', exact(T.calls))}${tile('Tokens', esc(bigNum(tokens)))}${tile('From cache', `${Math.round(cacheShare * 100)}%`)}${tile('Cost', esc(aiUsd(T.cost_usd)), n(T.saved_usd) ? `cache saved ${esc(aiUsd(T.saved_usd))}` : '')}${tile('Fees', esc(aiUsd(T.fee_usd)))}</div>
${daily.length > 1 ? bars(daily, 'AI calls a day', { h: 100 }) : ''}
${chips ? `<h3 class="rp-you-sub">Who paid</h3><ul class="rp-chips rp-paid">${chips}</ul>` : ''}
${lines.slice(1).map((l) => `<p class="rp-fine">${esc(l)}</p>`).join('')}
<p class="rp-meta"><a href="https://ai.openvibe.services/you">Your keys and how AI is paid for</a> \u00b7 <a href="/api/v1/me/ai/usage">As JSON</a></p>
</section>`;
}

function you({ user, days = 30, stats = null, recaps = null, speaker = null, ai = null } = {}) {
    const name = String(user.display_name || user.username || 'you');
    const username = String(user.username || '');
    const T = (stats && stats.totals) || {};
    const tabs = [7, 30, 90].map((x) => `<a href="/you?days=${x}"${Number(days) === x ? ' aria-current="page"' : ''}>${x} days</a>`).join('');
    const watch = (stats && stats.daily || []).map((d) => ({ day: d.day, n: d.watch_minutes }));
    const cards = ((recaps && recaps.recaps) || []).slice(0, 6).map((x) => kit.card({ href: `/after-show/${x.stream_id}`, title: x.headline || x.title || 'Stream', peek: x.headline && x.title ? x.title : '', type: 'stream', image: x.thumbnail_url || '', badge: x.grade ? `Grade ${x.grade}` : '', corner: n(x.duration_seconds) ? mins(x.duration_seconds) : '', count: n(x.peak_viewers) ? [x.peak_viewers, 'peak'] : null, when: x.ended_at ? ts(x.ended_at) : null }));
    const streams = n(T.streams) || cards.length ? `<section aria-labelledby="rp-you-st"><h2 id="rp-you-st">Your streams</h2>
${n(T.streams) ? `<div class="rp-tiles rp-tiles-sm">${tile('Streams', exact(T.streams))}${tile('On air', hours(T.stream_seconds))}${tile('Most at once', exact(T.peak_viewers))}${tile('Average watching', T.avg_viewers != null ? exact(T.avg_viewers) : null)}${tile('Watch time', n(T.watch_minutes) ? `${fmt(T.watch_minutes)}<small> min</small>` : null)}${tile('Chat', n(T.messages) ? fmt(T.messages) : null, n(T.unique_chatters) ? `from ${plural(T.unique_chatters, 'person', 'people')}` : '')}</div>` : ''}
${watch.length > 1 ? bars(watch, 'Minutes watched a day', { h: 110 }) : ''}
${cards.length ? `<h3 class="rp-you-sub">After-show reports</h3><ul class="rp-grid">${cards.map((c) => `<li>${c}</li>`).join('')}</ul><p class="rp-meta"><a href="/c/${encodeURIComponent(username)}">All your reports</a></p>` : ''}
</section>` : '';
    const rev = stats && stats.revenue;
    const money = rev && n(rev.transactions) ? `<section aria-labelledby="rp-you-mo"><h2 id="rp-you-mo">Money</h2>
<p class="rp-lede">${plural(rev.transactions, 'payment', 'payments')} in Vibes reached you in the last ${esc(rev.days || days)} days${n(rev.refunded_bits) ? ', some refunded since' : ''}. OpenVibe.Billing keeps every amount and receipt: <a href="https://billing.openvibe.network/">see them there</a>.</p>
</section>` : '';
    const sp = speaker && !speaker.opted_out ? speaker : null;
    const rundown = sp && ((sp.topics || []).length || (sp.episodes || []).length) ? `<section aria-labelledby="rp-you-rd"><h2 id="rp-you-rd">In The Rundown</h2>
${(sp.topics || []).length ? `<ul class="rp-chips">${sp.topics.slice(0, 12).map((t) => `<li><a href="/rundown/t/${encodeURIComponent(t.slug)}">${esc(t.title)}</a></li>`).join('')}</ul>` : ''}
${(sp.episodes || []).length ? `<p class="rp-meta">${plural(sp.episodes.length, 'stream', 'streams')} written up · <a href="/rundown/s/${encodeURIComponent(username)}">all of it</a></p>` : ''}
</section>` : '';
    const body = `<header class="rp-page-h rp-person">${kit.mark({ name, src: user.avatar_url || '', size: 64 })}<div><p class="rp-kicker">Your numbers</p><h1>${esc(name)}</h1>
<p class="rp-lede rp-you-say">${esc(youSentence({ name, days, stats, speaker }))}</p><nav class="rp-tabs" aria-label="Time range">${tabs}</nav></div></header>
${streams}${money}${youAi(ai, days)}${rundown}
<section aria-labelledby="rp-you-next" class="rp-you-next"><h2 id="rp-you-next">Coming here</h2><p class="rp-fine">Your agents' work and what your computers ran. Only you see this page.</p></section>`;
    return layout({ title: 'Your numbers', description: 'Your own numbers across OpenVibe: streams, money and The Rundown, in one place.', body, active: '/you', robots: 'noindex, nofollow' });
}

function youSignedOut() {
    const body = `<header class="rp-page-h"><p class="rp-kicker">Your numbers</p><h1>Everything you do on OpenVibe, counted for you</h1>
<p class="rp-lede">Your streams and their after-show reports, the payments that reach you, The Rundown, and soon your AI use across every site. Only you see it.</p>
<p>${kit.button({ href: `/auth/login?next=${encodeURIComponent('/you')}`, label: 'Sign in to see yours', icon: 'forward' })}</p></header>`;
    return layout({ title: 'Your numbers', description: 'Sign in to see your own numbers across OpenVibe.', body, active: '/you', robots: 'noindex, nofollow' });
}

function developers() {
    const rows = [
        ['GET /api/v1/stats?days=30', 'The network\'s open numbers over 7, 30 or 90 days: page views, accounts, Live, OpenCoins and every site.'],
        ['GET /api/v1/rundown', 'The Rundown\'s front: on air, the lead, recent streams, trending topics, voices and counts.'],
        ['GET /api/v1/rundown/topics', 'Every topic with its headline, takes and streamers.'],
        ['GET /api/v1/rundown/t/:slug', 'One topic with its takes and related topics.'],
        ['GET /api/v1/after-show/:streamId', 'A stream\'s after-show report: viewers minute by minute, chat, moments and the write-up.'],
        ['GET /api/v1/c/:username', 'A channel\'s after-show reports, newest first.'],
    ];
    const body = `<header class="rp-page-h"><p class="rp-kicker">For developers</p><h1>The Report API</h1><p class="rp-lede">Open JSON, no key, readable from any site (CORS). Counts only, never about a person.</p></header>
<section aria-labelledby="rp-ep-h"><h2 id="rp-ep-h">Endpoints</h2><dl class="rp-eps">${rows.map(([ep, what]) => `<div><dt><code>${esc(ep)}</code></dt><dd>${esc(what)}</dd></div>`).join('')}</dl></section>
<p class="rp-fine">Limits: 120 requests a minute from one address. Errors are problem+json (RFC 9457). <a href="/llms.txt">llms.txt</a> describes the site for agents.</p>`;
    return layout({ title: 'The Report API', description: 'Open JSON for the network\'s numbers, The Rundown and after-show reports.', body, active: '/developers', path: '/developers', agent: true });
}

function benchState(...reads) {
    const stale = reads.filter((r) => r && r.stale);
    if (!stale.length) return '';
    const oldest = stale.map((r) => r.at).sort()[0];
    return `<p class="rp-fine" role="status">Bench is unavailable. Showing the last good copy, read ${esc(dayTime(oldest))}.</p>`;
}

const aiPath = (kind) => `/ai/${encodeURIComponent(kind)}`;
const modelPath = (model) => `/ai/models/${encodeURIComponent(model)}`;
const modelLink = (subject) => `<a href="${modelPath(subject)}">${esc(subject)}</a>`;
const datasetLink = (kind) => `<p class="rp-fine">Download the <a href="${BENCH}/api/v1/datasets/${encodeURIComponent(kind)}.jsonl">dataset JSONL</a> from Bench.</p>`;

// ── AI boards (Kit 2): who does each job best, and what it costs ──
// The reader came to choose a model for a job. So the page leads with the leaders, one row per job, and keeps the
// jobs nobody has rated yet in one short list; each board is a ranking, a quality-against-cost chart and the exact
// numbers. Nothing here is drawn from a guess: every figure is Bench's.
const JUDGE_SHORT = { human_pairwise: 'blind votes', rubric: 'a rubric', automatic_grader: 'a grader', test_suite: 'a test suite', game_outcome: 'game results' };
// Where people rate a kind themselves (only blind-vote kinds are rated by people); a room without a site has no link.
const ROOM_HOSTS = { chat: 'openvibe.chat', games: 'openvibe.games', search: 'search.openvibe.network', codes: 'openvibe.codes' };
const roomHost = (room) => { const r = rooms.get(room); return (r && r.host) || ROOM_HOSTS[room] || null; };
const rowsOf = (read) => (read && read.data && read.data.board && Array.isArray(read.data.board.rows) ? read.data.board.rows : []);
const howRated = (kind) => `Rated by ${JUDGE_SHORT[kind.judge] || 'Bench'}`;
const METHOD = 'Ratings are Bradley–Terry Elo from Bench, with a 95% interval; a model with fewer than ten games is provisional.';

/** What to do when a board is empty: rate it in its room (blind-vote kinds), or wait for runs (graded kinds). */
function emptyFor(kind) {
    const host = kind && kind.judge === 'human_pairwise' ? roomHost(kind.room) : null;
    if (host) return kit.empty({ icon: 'trophy', title: 'No votes yet', text: `This board fills as people compare two answers blind on ${roomName(kind.room)} and pick the better one.`, action: { href: `https://${host}/`, label: `Vote on ${roomName(kind.room)}`, icon: 'forward' } });
    return kit.empty({ icon: 'trophy', title: 'No results yet', text: kind ? `This board fills as models are run and ${JUDGE_SHORT[kind.judge] || 'Bench'} scores them.` : 'This board fills as models are run on Bench.' });
}

function aiIndex({ kinds, boards = [] }) {
    const list = kinds && kinds.data && Array.isArray(kinds.data.kinds) ? kinds.data.kinds : [];
    const items = list.map((kind, i) => ({ kind, rows: rowsOf(boards[i]), available: Boolean(boards[i]) }));
    const rated = items.filter((x) => x.rows.length).sort((a, b) => gamesOf(b.rows) - gamesOf(a.rows));
    const waiting = items.filter((x) => !x.rows.length);
    const leaders = rated.length ? kit.table({
        caption: 'Leaders', columns: [
            { key: 'job', label: 'Job', primary: true, html: true }, { key: 'leader', label: 'Leader', html: true },
            { key: 'rating', label: 'Rating', num: true, html: true }, { key: 'games', label: 'Games', num: true, fmt: 'int' },
        ],
        rows: rated.map(({ kind, rows }) => ({ job: `<a href="${aiPath(kind.id)}">${esc(kind.name || kind.id)}</a>`, leader: `${modelLink(rows[0].subject)}${flag(rows[0])}`, rating: rating(rows[0]), games: gamesOf(rows) })),
    }) : '';
    const waitRows = waiting.map(({ kind, available }) => kit.row({ href: aiPath(kind.id), title: kind.name || kind.id, sub: `${roomName(kind.room)} · ${available ? howRated(kind) : 'board unavailable'}`, trail: kit.icon('chevron') }));
    const waitList = waitRows.length ? kit.list(waitRows, { flush: true }) : '';
    const none = !rated.length && list.length;
    const body = kit.head({ title: 'AI boards', sub: 'Which AI does each job best, and what it costs', sticky: false })
        + benchState(kinds, ...boards)
        + (!list.length ? kit.empty({ icon: 'trophy', title: 'Bench is unavailable', text: 'The boards come back as soon as Bench answers.' }) : '')
        + (none ? kit.notice({ kind: 'info', text: `No model is rated yet. ${list.length} jobs are set up; each board fills as people vote blind on two answers, or as graders score runs.` }) : '')
        + (rated.length ? kit.stats([[rated.length, rated.length === 1 ? 'job rated' : 'jobs rated'], [rated.reduce((s, x) => s + gamesOf(x.rows), 0), 'games played'], [list.length, 'jobs tracked']], { label: 'The boards in numbers' }) : '')
        + leaders
        + (waitList ? (none ? kit.section({ title: 'Jobs being rated', count: waiting.length, body: waitList }) : kit.fold({ title: 'Waiting for their first results', meta: String(waiting.length), body: waitList })) : '')
        + `<p class="rp-fine">${esc(METHOD)} Every board's data is open: <a href="${BENCH}/docs">Bench's API and datasets</a>.</p>`;
    return layout({ title: 'AI boards', description: 'Which AI does each job best, and what it costs: Bench ratings across OpenVibe.', body, active: '/ai', path: '/ai', agent: true });
}

function paretoRows(pareto, cost) {
    const costs = new Map(rowsOf(cost).map((r) => [r.subject, n(r.cost_per_solved)]));
    const rows = rowsOf(pareto).map((r) => ({ ...r, quality: n(r.quality), costPerSolved: costs.get(r.subject) }));
    return rows.map((r) => ({ ...r, frontier: r.quality != null && r.costPerSolved != null && !rows.some((other) => other !== r && other.quality != null && other.costPerSolved != null && other.quality >= r.quality && other.costPerSolved <= r.costPerSolved && (other.quality > r.quality || other.costPerSolved < r.costPerSolved)) }));
}

/** Quality against cost per solved task, the frontier dashed and labelled (kit.chart scatter). */
function paretoChart(rows) {
    const points = rows.filter((r) => r.quality != null && r.costPerSolved != null && r.costPerSolved >= 0);
    if (!points.length) return '<p class="rp-fine">No quality and cost per solved pairs yet.</p>';
    return kit.chart({
        type: 'scatter', title: 'Quality against cost per solved task', note: 'Up and to the left is better. The dashed line joins the models nothing beats on both.',
        x: { label: 'Cost per solved task (USD, lower is better)', fmt: (v) => usd(v) }, y: { label: 'Quality', fmt: (v) => `${Math.round(v)}%`, zero: false },
        points: points.map((r) => ({ label: r.subject, x: r.costPerSolved, y: r.quality * 100, best: r.frontier, mark: r.frontier || points.length <= 8, href: modelPath(r.subject) })),
        height: 260,
    });
}

const TABS = [{ key: 'elo', label: 'Ranking' }, { key: 'pareto', label: 'Quality and cost' }, { key: 'cost', label: 'Cost per solved' }];

function aiBoard({ kindId, kind, tab, board, cost, kinds }) {
    const name = kind && kind.name || kindId;
    const rows = rowsOf(board);
    let content;
    if (!board) content = kit.empty({ icon: 'trophy', title: 'Bench is unavailable', text: 'This board comes back as soon as Bench answers.' });
    else if (!rows.length) content = emptyFor(kind);
    else if (tab === 'pareto') {
        const points = paretoRows(board, cost);
        content = paretoChart(points) + (points.length ? kit.table({ caption: 'The numbers', columns: [{ key: 'm', label: 'Model', primary: true, html: true }, { key: 'q', label: 'Quality', num: true, html: true }, { key: 'c', label: 'Cost per solved', num: true, html: true }],
            // The frontier is a word on the model's name, so a phone's card stays two lines.
            rows: points.map((r) => ({ m: `${modelLink(r.subject)}${r.frontier ? ` ${kit.badge('frontier', 'accent')}` : ''}`, q: share(r.quality), c: usd(r.costPerSolved) })) }) : '');
    } else if (tab === 'cost') {
        const crows = rowsOf(cost).length ? rowsOf(cost) : rows;
        content = kit.table({ caption: 'Cost per solved task', columns: [{ key: 'm', label: 'Model', primary: true, html: true }, { key: 'solved', label: 'Solved', num: true, fmt: 'int' }, { key: 'entries', label: 'Entries', num: true, fmt: 'int' }, { key: 'total', label: 'Total cost', num: true, html: true }, { key: 'per', label: 'Cost per solved', num: true, html: true }],
            rows: crows.map((r) => ({ m: modelLink(r.subject), solved: r.solved, entries: r.entries, total: usd(r.total_cost_usd), per: usd(r.cost_per_solved) })) });
    } else {
        // The bars start just under the lowest interval, so the differences that matter are the ones you see.
        const floor = Math.floor((Math.min(...rows.map((r) => n(r.ci_lower) ?? n(r.elo) ?? 0)) - 25) / 50) * 50;
        content = kit.rank({ label: `${name}: ranking`, base: floor, fmt: 'int', items: rows.map((r) => {
            const lo = n(r.ci_lower), hi = n(r.ci_upper), elo = n(r.elo);
            return { name: r.subject, href: modelPath(r.subject), value: elo, interval: lo != null && hi != null && elo != null ? Math.round(Math.max(hi - elo, elo - lo)) : null,
                note: [n(r.games) != null ? `${exact(r.games)} games` : '', n(r.win_rate) != null ? `${share(r.win_rate)} won` : '', provisional(r) ? 'provisional' : ''].filter(Boolean).join(' · ') };
        }) }) + `<p class="rp-fine">${esc(METHOD)}</p>`;
    }
    const head = kit.head({ title: name, sub: kind ? `${roomName(kind.room)} · ${howRated(kind)}` : 'Bench results', back: { href: '/ai', label: 'AI boards' },
        tabs: rows.length ? kit.tabs({ base: aiPath(kindId), items: TABS, active: tab, label: 'Board view' }) : '' });
    const body = head + benchState(kinds, board, cost) + `<section aria-label="${esc(TABS.find((t) => t.key === tab)?.label || 'Board')}">${content}</section>${datasetLink(kindId)}`;
    return layout({ title: `${name}: AI board`, description: `${name}: which AI does it best, and what it costs.`, body, active: '/ai', path: aiPath(kindId), agent: true });
}

function aiModel({ model, summary }) {
    const data = summary && summary.data || null;
    const ratings = data && Array.isArray(data.ratings) ? data.ratings : [];
    const entries = data && Array.isArray(data.entries) ? data.entries : [];
    const kinds = [...new Set([...ratings.map((r) => r.kind_id), ...entries.map((e) => e.kind_id)])].filter(Boolean);
    const rows = kinds.map((kind) => {
        const r = ratings.find((item) => item.kind_id === kind);
        return { job: `<a href="${aiPath(kind)}">${esc(kind)}</a>`, rating: r ? `${rating(r)}${flag(r)}` : '—', games: r ? r.games : null, won: r ? share(r.win_rate) : '—', recent: entries.filter((item) => item.kind_id === kind).length };
    });
    const games = ratings.reduce((s, r) => s + (n(r.games) || 0), 0);
    const head = kit.head({ title: model, sub: 'Every job this model has been rated on', back: { href: '/ai', label: 'AI boards' }, sticky: false });
    const body = head + benchState(summary) + (!data ? kit.empty({ icon: 'trophy', title: 'Bench is unavailable', text: 'This page comes back as soon as Bench answers.' })
        : kit.stats([[kinds.length, kinds.length === 1 ? 'job' : 'jobs'], [games, 'games'], [n(data.total_cost_usd) ? usd(data.total_cost_usd) : null, 'spent on runs']], { label: `${model} in numbers` })
        + (rows.length ? kit.table({ caption: 'By job', columns: [{ key: 'job', label: 'Job', primary: true, html: true }, { key: 'rating', label: 'Rating', num: true, html: true }, { key: 'games', label: 'Games', num: true, fmt: 'int' }, { key: 'won', label: 'Won', num: true, html: true }, { key: 'recent', label: 'Recent entries', num: true, fmt: 'int' }], rows })
            : kit.empty({ icon: 'trophy', title: 'Not rated yet', text: 'This model appears here once it has played on a Bench board.' })))
        + `<p class="rp-fine">${esc(METHOD)}</p>`;
    return layout({ title: `${model}: AI model`, description: `${model} across OpenVibe benchmark jobs: ratings, games and cost.`, body, active: '/ai', path: modelPath(model), agent: true });
}

function notFound() {
    return layout({ title: 'Not found', robots: 'noindex, follow', body: `<header class="rp-page-h"><h1>Nothing here</h1><p class="rp-lede">That page does not exist, or its source has nothing for it. <a href="/">Back to Report</a>.</p></header>` });
}

module.exports = { home, stats, rundown, topic, episode, speaker, recap, channel, you, youSignedOut, developers, aiIndex, aiBoard, aiModel, paretoRows, paretoChart, notFound, layout, setRelease, configure };
