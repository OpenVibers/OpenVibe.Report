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
const { pickList, foldAround } = require('./short');
// A short name for a chip: the title, cut where it stops saying anything.
const clip = (s, n = 40) => { const x = String(s == null ? '' : s); return x.length > n ? `${x.slice(0, n - 1).trimEnd()}…` : x; };
const sc = require('openvibe-shared/showcase');
const rooms = require('openvibe-shared/rooms');
const { asset } = require('../assets');

const NAME = 'OpenVibe.Report';

// The tables are an open dataset, not only a page: Dataset JSON-LD names the numbers and the JSON that serves them, so
// dataset search and AI retrieval can cite Report's tables instead of re-deriving them from prose.
function networkDataset() {
    return seo.jsonLd.dataset({
        name: 'OpenVibe network numbers',
        url: 'https://openvibe.report/stats',
        description: 'Page views, visitors, live streams, chat, OpenCoins and service speed across every OpenVibe site, counted by the sites themselves and published as open JSON.',
        creator: 'OpenVibe',
        keywords: ['OpenVibe', 'web analytics', 'live streaming', 'page views', 'service status', 'open data'],
        distribution: [
            { '@type': 'DataDownload', name: 'Network numbers', contentUrl: 'https://openvibe.report/api/v1/stats', encodingFormat: 'application/json' },
            { '@type': 'DataDownload', name: 'AI results and cost per task', contentUrl: 'https://openvibe.report/api/v1/ai/results', encodingFormat: 'application/json' },
            { '@type': 'DataDownload', name: 'The Rundown topics', contentUrl: 'https://openvibe.report/api/v1/rundown/topics', encodingFormat: 'application/json' },
        ],
    });
}
const NETWORK = 'https://openvibe.network';
const LIVE = 'https://openvibe.live';
const BENCH = 'https://openvibe.compare';
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
    { label: 'You', href: '/you', icon: 'user' },
    { label: 'Numbers', href: '/stats', icon: 'chart' },
    { label: 'The Rundown', href: '/rundown', icon: 'news' },
    { label: 'API', href: '/developers', icon: 'code', more: true },
];

function layout({ title, description, canonical = null, path = null, robots = 'index, follow', body, active = '/', jsonLd = [], agent = false, inlineStyles = [], og = null }) {
    canonical = canonical || (path ? canon(path) : undefined);
    const ogTags = og ? [
        `<meta property="og:type" content="${esc(og.type || 'website')}">`,
        `<meta property="og:site_name" content="${esc(NAME)}">`,
        `<meta property="og:title" content="${esc(og.title || title || NAME)}">`,
        `<meta property="og:description" content="${esc(og.description || description || '')}">`,
        og.url ? `<meta property="og:url" content="${esc(og.url)}">` : '',
        og.image ? `<meta property="og:image" content="${esc(og.image)}">` : '',
        '<meta name="twitter:card" content="summary">',
    ].filter(Boolean).join('\n') : '';
    const navbar = {
        service: 'report',
        apiBase: NETWORK,
        links: NAV.map((l) => ({ ...l, active: l.href === active || (l.href !== '/' && active.startsWith(l.href)) })),
        appBar: [{ label: 'Home', href: '/', icon: 'home' }, { label: 'Numbers', href: '/stats', icon: 'chart' }, { label: 'Rundown', href: '/rundown', icon: 'news' }],
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
${ogTags}
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

/**
 * The home's picture (MOTION-1, 2026-11-02: sc.room drew its default motif): an after-show report in miniature, the
 * thing Report writes for every stream. A sample stream, its viewers minute by minute with the peak, chat, and the top
 * moment. The numbers are a sample, said as one; the real reports are a tap away.
 */
function reportMotif() {
    const sample = [3, 5, 9, 14, 18, 22, 27, 31, 41, 37, 33, 35, 29, 24, 19, 15].map((v) => ({ n: v }));
    return `<div class="rp-motif" aria-hidden="true">
<div class="rp-mf-head"><span class="rp-mf-k">After the show · sample</span><b>Tuesday stream · 2 h 14 m</b></div>
<div class="rp-mf-curve">${spark(sample)}<span class="rp-mf-peak">peak 41</span></div>
<ul class="rp-mf-facts"><li><b>1,204</b><span>chat messages</span></li><li><b>186</b><span>people came by</span></li><li><b>01:12</b><span>top moment</span></li></ul>
<p class="rp-mf-note">“The cat walks in” · the clip with the most replays</p>
</div>`;
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
        + `<span class="rp-meta">${[n(t.takes) ? `${exact(t.takes)} take${Number(t.takes) === 1 ? '' : 's'}` : '', n(t.streamers) ? `${exact(t.streamers)} streamer${Number(t.streamers) === 1 ? '' : 's'}` : '', t.last_seen_at ? day(t.last_seen_at) : ''].filter(Boolean).map(esc).join(' · ')}</span></a></li>`;
}
function streamCard(s) {
    if (!s || !s.stream_id) return '';
    const ep = s.episode && s.episode.title ? s.episode : null;
    // The card opens the stream's Rundown episode, which every stream in the feed has (it has takes). Its after-show report
    // exists only for some streams, and the card linked to it for all of them: 404s for most (2026-11-01).
    return kit.card({ href: `/rundown/e/${encodeURIComponent(s.stream_id)}`, title: ep ? ep.title : s.title || 'Stream', peek: ep ? (ep.logline || s.title || '') : '', type: 'stream', live: !!s.live, corner: n(s.minutes) ? `${s.minutes} min` : '', who: who(s.user), avatar: s.user && s.user.avatar_url, when: s.started_at ? ts(s.started_at) : null, image: s.thumbnail_url || '', count: n(s.takes_total) ? [s.takes_total, Number(s.takes_total) === 1 ? 'take' : 'takes'] : null });
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
            motif: reportMotif(),
        },
        proof: [
            { value: n(T.pageviews), label: 'page views this week', asOf: stats && stats.generated_at ? day(stats.generated_at) : null },
            { value: n(T.accounts), label: 'accounts' },
            { value: n(L.streams), label: 'streams so far' },
            { value: n(R.counts && R.counts.takes), label: 'takes written up' },
        ].filter((p) => p.value),
        rails: streams.length ? [{ id: 'episodes', title: 'Latest episodes', more: { href: '/rundown', label: 'The Rundown' }, items: streams }] : [],
        html: leadHTML + topicsBlock,
        scenes: [numbersScene].filter(Boolean),
        explore: { title: 'More on Report', items: [
            { title: 'Every site\'s numbers', text: 'Page views, people, streams and how fast each service answers', href: '/stats', icon: 'ov:gauge' },
            { title: 'The Rundown', text: 'What streamers talked about, topic by topic', href: '/rundown', icon: 'ov:news' },
            { title: 'AI models', text: 'Which AI does each job best, what it costs and how fast it is: the comparison lives on OpenVibe.Compare', href: 'https://openvibe.compare/ai', icon: 'ov:ai' },
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
        jsonLd: [seo.jsonLd.website({ name: 'OpenVibe.Report', url: 'https://openvibe.report/', description: "The network's numbers open to everyone, what streamers talked about in The Rundown, and every stream's after-show report." }), seo.jsonLd.organization(), networkDataset()],
        // The rule that shows the picked topic of the pick list: one per topic, written for this page.
    });
}

// ── Views (OpenVibe.Media's one view store): per item, per creator and per site ──────────────
// A row is { id, service?, kind?, item_id?, site, creator, views, engaged, previews, preview_share, peak_concurrent }.
// Every number came from Media's GET /api/v1/views/aggregate; a missing dimension leaves its table out, never a zero.
const pctShare = (v) => (v == null ? '—' : `${Math.round(Number(v) * 1000) / 10}%`);
function viewRow(row, label, href) {
    const name = href ? `<a href="${esc(href)}">${esc(label)}</a>` : esc(label || 'Unknown');
    return `<div class="rp-tr" role="row"><span role="cell" class="rp-site">${name}<small>${esc(row.site || '')}</small></span>`
        + `<span role="cell" data-l="Views">${exact(row.views)}</span>`
        + `<span role="cell" data-l="Engaged">${exact(row.engaged)}</span>`
        + `<span role="cell" data-l="From previews">${pctShare(row.preview_share)}</span>`
        + `<span role="cell" data-l="Peak live">${row.peak_concurrent == null ? '—' : exact(row.peak_concurrent)}</span></div>`;
}
function viewTable(title, rows, kind) {
    if (!rows || !rows.length) return '';
    const body = rows.map((row) => {
        if (kind === 'item') {
            const name = `${row.kind} ${row.item_id}`;
            const href = row.service === 'media' && row.kind === 'vod' ? `https://openvibe.media/v/${encodeURIComponent(row.item_id)}`
                : row.service === 'media' && row.kind === 'clip' ? `https://openvibe.media/c/${encodeURIComponent(row.item_id)}` : null;
            return viewRow(row, name, href);
        }
        if (kind === 'creator') return viewRow(row, row.creator || row.id || 'Unknown', row.creator ? `/c/${encodeURIComponent(row.creator)}` : null);
        return viewRow(row, row.site || row.id || 'Unknown', null);
    }).join('');
    return `<section aria-labelledby="rp-v-${esc(kind)}"><h2 id="rp-v-${esc(kind)}">${esc(title)}</h2>
<div class="rp-table" role="table" aria-label="${esc(title)}"><div class="rp-tr rp-th" role="row"><span role="columnheader">${kind === 'item' ? 'Item' : kind === 'creator' ? 'Creator' : 'Site'}</span><span role="columnheader">Views</span><span role="columnheader">Engaged</span><span role="columnheader">From previews</span><span role="columnheader">Peak live</span></div>${body}</div></section>`;
}
function viewsSection(v) {
    if (!v) return '';
    const items = v.items && v.items.rows || [];
    const creators = v.creators && v.creators.rows || [];
    const sites = v.sites && v.sites.rows || [];
    if (!items.length && !creators.length && !sites.length) return '';
    return `<section aria-labelledby="rp-views-h"><h2 id="rp-views-h">Views and engaged viewers</h2>
<p class="rp-fine">Counted by OpenVibe.Media for every kind: a Feed preview counts from one second, once per person per item per 30 minutes, and a viewer is engaged after 30 seconds or a third of the video (60 seconds live). The peak is the most people watching a live stream at once. A preview is the share of views that started in the Feed.</p>
${viewTable('Top items', items, 'item')}${viewTable('Top creators', creators, 'creator')}${viewTable('By site', sites, 'site')}</section>`;
}

function stats({ stats: d, days = 30, views: v = null } = {}) {
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
${viewsSection(v)}
${d.pageviews_daily && d.pageviews_daily.length > 1 ? `<section aria-labelledby="rp-pv-h"><h2 id="rp-pv-h">Page views a day</h2>${bars(d.pageviews_daily, 'Page views a day')}</section>` : ''}
${sites ? `<section aria-labelledby="rp-sites-h"><h2 id="rp-sites-h">Every site</h2><p class="rp-fine">Most visited first over ${esc(d.window_days || days)} days; requests and speed (95% of answers were at least this fast) over the last 24 hours.</p>
<div class="rp-table" role="table" aria-label="Every site"><div class="rp-tr rp-th" role="row"><span role="columnheader">Site</span><span role="columnheader">Page views</span><span role="columnheader">Visitors</span><span role="columnheader">Requests, 24 h</span><span role="columnheader">95% answered in</span></div>${sites}</div></section>` : ''}
${L ? `<section aria-labelledby="rp-live-h"><h2 id="rp-live-h">OpenVibe.Live</h2><div class="rp-minis">${[['Streamers', L.streamers], ['Streams', L.streams], ['Hours watched', L.hours_watched], ['Chat messages', L.messages], ['Recordings', L.vods], ['Clips', L.clips], ['AI moments', L.ai_moments]].filter(([, v]) => n(v)).map(([l, v]) => `<div><b>${fmt(v)}</b><span>${esc(l)}</span></div>`).join('')}</div></section>` : ''}
${A && A.daily && A.daily.length > 1 ? `<section aria-labelledby="rp-acc-h"><h2 id="rp-acc-h">New accounts a day</h2>${bars(A.daily, 'New accounts a day', { h: 110 })}</section>` : ''}
<section aria-labelledby="rp-how-h"><h2 id="rp-how-h">How these are counted</h2><p class="rp-fine">${esc(d.note || '')} The same numbers: <a href="/api/v1/stats?days=${esc(days)}"><code>/api/v1/stats</code></a>. How closely each site follows the design kit, read from its code: <a href="/design">Design health</a>.</p></section>`;
    return layout({ title: `Every site's numbers, ${days} days`, description: 'Page views, people, streams and how fast each OpenVibe service answers, open to everyone.', body, active: '/stats', path: `/stats${Number(days) === 30 ? '' : `?days=${Number(days)}`}`, agent: true, jsonLd: [networkDataset()] });
}

function rundown({ rundown: R = {}, topics, reports } = {}) {
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
${voices.length ? `<section aria-labelledby="rp-v-h"><h2 id="rp-v-h">Voices</h2><ul class="rp-voices">${voices.map((v) => `<li><a href="/rundown/s/${encodeURIComponent((v.user || {}).username || '')}">${kit.mark({ name: who(v.user), src: v.user && v.user.avatar_url, size: 40 })}<span><b>${esc(who(v.user))}</b><small>${[n(v.topics) ? `${exact(v.topics)} topic${Number(v.topics) === 1 ? '' : 's'}` : '', n(v.segments) ? `${exact(v.segments)} take${Number(v.segments) === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')}</small></span></a></li>`).join('')}</ul></section>` : ''}
${streams.length ? kit.rail({ id: 'episodes', title: 'Recent streams', items: streams }) : ''}
${reports && reports.length ? reportsSection(reports) : ''}`;
    return layout({ title: 'The Rundown: what streamers talked about', description: 'Topics, takes and crossovers from what streamers said on OpenVibe, written up by AI from the streams themselves.', body, active: '/rundown', path: '/rundown', canonical: `${LIVE}/rundown` });
}


// Agent Streams S3: the report of one agent session (report.session@1). Seven parts, in the order a reader wants
// them: what it was and how it ended, what was asked, what came out, the proof, the steps, what to watch, what to do.
function reportOutcome(rep) {
    if (rep.outcome === 'done') return { label: 'Done', cls: 'is-done' };
    if (rep.outcome === 'failed') return { label: 'Failed', cls: 'is-failed' };
    return { label: 'Stopped', cls: 'is-stopped' };
}

function worked(rep) {
    const m = Math.round((Number(rep.worked_seconds) || 0) / 60);
    if (!m) return 'under a minute';
    if (m < 60) return m + ' min';
    const h = Math.floor(m / 60);
    return h + ' h ' + (m % 60) + ' min';
}

// A proof shot is a Media object (med_…); the picture is at Media's own address, the id stays under it.
function shotURL(id) {
    const s = String(id == null ? '' : id).trim();
    if (/^med_[0-9A-Za-z]+$/.test(s)) return 'https://openvibe.media/o/' + s + '?w=640';
    if (/^https?:\/\//i.test(s)) return s;
    return null;
}

function reportCard(rep) {
    const out = reportOutcome(rep);
    return '<li class="rp-report"><a href="/s/' + encodeURIComponent(rep.id) + '"><span class="rp-kind">' + esc(out.label)
        + '</span><b>' + esc(rep.task.title) + '</b><span class="rp-report-s">' + esc(rep.summary) + '</span>'
        + '<span class="rp-meta">' + AI + ' · ' + esc(worked(rep))
        + (rep.cost_usd != null ? ' · $' + esc(String(rep.cost_usd)) : '') + '</span></a></li>';
}

// The Rundown's new section: what agents built today. The fold is counted ("More (N)"), never a silent cut.
function reportsSection(reports) {
    const all = (reports || []).slice(0, 24);
    const shown = all.slice(0, 8);
    const rest = all.slice(8);
    return '<section aria-labelledby="rp-ag-h"><div class="rp-head-row"><h2 id="rp-ag-h">What agents built today</h2>'
        + '<span class="rp-counts"><b>' + exact(all.length) + '</b> report' + (all.length === 1 ? '' : 's') + '</span></div>'
        + '<ul class="rp-topics">' + shown.map(reportCard).join('') + '</ul>'
        + (rest.length ? '<details class="rp-fold"><summary>More (' + exact(rest.length) + ')</summary><ul class="rp-topics">'
            + rest.map(reportCard).join('') + '</ul></details>' : '')
        + '</section>';
}

function sessionReport({ report: rep, signedIn = false, isOwner = false, audience = 'private', members = [] } = {}) {
    if (!rep) return notFound();
    const out = reportOutcome(rep);
    const proof = rep.proof || {};
    const total = proof.tests ? (Number(proof.tests.passed) || 0) + (Number(proof.tests.failed) || 0) : 0;
    const tests = proof.tests ? (Number(proof.tests.passed) || 0) + ' of ' + total + ' tests passing' : '';
    const testsOk = proof.tests ? !(Number(proof.tests.failed) > 0) : false;
    const shots = proof.screenshots || [];
    const watch = (rep.outputs || []).filter((o) => o.kind === 'vod' || o.kind === 'clip');
    const made = (rep.outputs || []).filter((o) => o.kind !== 'vod' && o.kind !== 'clip');
    const steps = rep.timeline || [];
    let body = '<header class="rp-page-h"><p class="rp-kicker">Session report · ' + esc(rep.source) + '</p><h1>'
        + esc(rep.task.title) + '</h1><p class="rp-sr-meta"><span class="rp-kind ' + out.cls + '">' + esc(out.label)
        + '</span>' + AI + '<span>worked ' + esc(worked(rep)) + '</span>'
        + (rep.cost_usd != null ? '<span>$' + esc(String(rep.cost_usd)) + '</span>' : '')
        + (rep.models && rep.models.length ? '<span>' + esc(rep.models.join(', ')) + '</span>' : '') + '</p></header>';
    body += '<section aria-labelledby="rp-sum-h"><h2 id="rp-sum-h">What was asked</h2><p class="rp-lede">'
        + esc(rep.summary) + '</p>'
        + '</section>';
    if (made.length) {
        body += '<section aria-labelledby="rp-out-h"><h2 id="rp-out-h">What came out</h2><ul class="rp-chips">'
            + made.map((o) => '<li><a href="' + (o.url ? esc(o.url) : '#') + '">' + esc(o.title)
                + (o.state ? ' (' + esc(o.state) + ')' : '') + '</a></li>').join('') + '</ul></section>';
    }
    body += '<section aria-labelledby="rp-pr-h"><h2 id="rp-pr-h">The proof</h2>'
        + (tests ? '<p class="rp-proof-tests ' + (testsOk ? 'is-ok' : 'is-bad') + '">' + esc(tests) + '</p>' : '')
        + (shots.length ? '<ul class="rp-shots" aria-label="Screenshots">' + shots.map((s, i) => {
            const u = shotURL(s);
            return u ? '<li><a href="' + esc(u) + '"><img src="' + esc(u) + '" alt="Screenshot ' + (i + 1) + '" width="200" height="125" loading="lazy" decoding="async"></a></li>' : '';
        }).join('') + '</ul>' : '')
        + (proof.review ? '<div class="rp-review"><p><b>Review:</b> ' + esc(proof.review.verdict) + '</p>'
            + (proof.review.notes ? '<details class="rp-fold"><summary>The notes</summary><p>' + esc(proof.review.notes) + '</p></details>' : '')
            + '</div>' : '')
        + (!tests && !shots.length && !proof.review ? '<p class="rp-meta">No proof was recorded for this session.</p>' : '')
        + '</section>';
    if (steps.length || rep.stopped_because) {
        body += '<section aria-labelledby="rp-tl-h"><h2 id="rp-tl-h">How it went</h2>'
            + (rep.stopped_because ? '<p class="rp-summary">It stopped: ' + esc(rep.stopped_because) + '</p>' : '')
            + '<ol class="rp-steps">'
            + steps.map((s) => {
                const st = ['passed', 'failed', 'skipped', 'started'].includes(s.status) ? s.status : 'started';
                return '<li class="is-' + st + '"><span class="rp-step-dot" aria-hidden="true"></span><div><p><b>' + esc(s.title) + '</b> <span class="rp-step-st">'
                    + esc(st === 'started' ? 'running' : st)
                    + (s.tests ? ' · ' + (Number(s.tests.passed) || 0) + ' of ' + ((Number(s.tests.passed) || 0) + (Number(s.tests.failed) || 0)) + ' passing' : '') + '</span></p>'
                    + (s.detail ? '<p class="rp-step-detail">' + esc(s.detail) + '</p>' : '') + '</div></li>';
            }).join('')
            + '</ol></section>';
    }
    if (watch.length) {
        body += '<section aria-labelledby="rp-wa-h"><h2 id="rp-wa-h">Watch</h2><ul class="rp-chips">'
            + watch.map((o) => '<li><a href="' + (o.url ? esc(o.url) : '#') + '">' + esc(o.title) + '</a></li>').join('')
            + '</ul></section>';
    }
    // The one sheet (openvibe-shared/ov-share.js, loaded on the first press). For the owner, "Who can open it" is the
    // access part, which calls the SDK's router at /api/v1/session-report/<id>/share; everyone else just sends the link.
    const shareButton = '<button type="button" class="rp-btn" data-ov-share-sheet data-title="' + esc(rep.task.title) + '"'
        + (isOwner ? ' data-kind="session-report" data-id="' + esc(rep.id) + '"'
            : ' data-url="' + esc(canon('/s/' + rep.id)) + '"') + '>Share</button>';
    body += '<section aria-labelledby="rp-ac-h"><h2 id="rp-ac-h">What to do</h2><p class="rp-act">'
        + shareButton
        + (signedIn ? ' <a class="rp-btn is-quiet" href="https://openvibe.codes/t/new?from=' + encodeURIComponent(rep.id) + '">Do this again</a>' : '')
        + '</p>'
        + (isOwner ? '<p class="rp-meta">' + esc(sharingChip(audience, members)) + ' can open this report. '
            + '<a href="/you">Change the default for new reports</a>.</p>' : '')
        + '</section>';
    return layout({
        title: rep.task.title + ': the session report',
        description: rep.summary,
        body,
        active: '/rundown',
        path: '/s/' + rep.id,
        // Only a report in Everyone is for search and crawlers; a link, a list of people and Only me are not.
        robots: audience === 'public' ? 'index, follow' : 'noindex, nofollow',
    });
}

/** The four audiences in the words the sheet uses ("Everyone", "Anyone with the link", "Specific people", "Only me"). */
function sharingChip(audience, members = []) {
    if (audience === 'public') return 'Everyone';
    if (audience === 'link') return 'Anyone with the link';
    if (audience === 'people') return members.length === 1 ? 'You and 1 other person' : `You and ${members.length} people`;
    return 'Only you';
}

function topic({ topic: d, citations = [] } = {}) {
    const t = d.topic || {};
    const takes = (d.takes || []).slice(0, 40);
    // S7: a public agent report whose task worked on this topic, under the whole-name rule. Only Everyone's reports
    // reach here (the page asks listPublicMatchingTopic); a hidden report is never a citation.
    const cites = (Array.isArray(citations) ? citations : []).slice(0, 6);
    const citesHTML = cites.length ? `<section aria-labelledby="rp-cite-h"><h2 id="rp-cite-h">Agents that worked on this</h2><ul class="rp-topics">${cites.map((r) => `<li class="rp-report"><a href="/s/${encodeURIComponent(r.id)}"><span class="rp-kind">${esc((r.outcome || 'done') === 'failed' ? 'Failed' : (r.outcome || 'done') === 'stopped' ? 'Stopped' : 'Done')}</span><b>${esc((r.task && r.task.title) || 'An agent session')}</b><span class="rp-report-s">${esc(r.summary || '')}</span><span class="rp-meta">${AI}${r.worked_seconds ? ` · ${esc(worked(r))}` : ''}</span></a></li>`).join('')}</ul></section>` : '';
    const body = `<header class="rp-page-h"><p class="rp-kicker"><a href="/rundown">The Rundown</a> · ${esc(KIND[t.kind] || t.kind || 'Topic')}</p><h1>${esc(t.title)}</h1>
${t.headline ? `<p class="rp-lede">${esc(t.headline)}</p>` : ''}${t.summary ? `<p class="rp-summary">${esc(t.summary)}</p>` : ''}<p class="rp-meta">${AI}${t.first_seen_at ? ` · since ${esc(day(t.first_seen_at))}` : ''}</p></header>
${takes.length ? `<section aria-labelledby="rp-tk-h"><h2 id="rp-tk-h">Takes</h2><ol class="rp-takes">${takes.map(takeRow).join('')}</ol></section>` : ''}
${citesHTML}
${(d.related || []).length ? `<section aria-labelledby="rp-rel-h"><h2 id="rp-rel-h">Related</h2><ul class="rp-chips">${d.related.slice(0, 12).map((r) => `<li><a href="/rundown/t/${encodeURIComponent(r.slug)}">${esc(r.title)}</a></li>`).join('')}</ul></section>` : ''}`;
    return layout({ title: `${t.title}: The Rundown`, description: t.headline || `What streamers said about ${t.title}.`, body, active: '/rundown', path: `/rundown/t/${encodeURIComponent(t.slug || '')}`, canonical: `${LIVE}/rundown/t/${encodeURIComponent(t.slug || '')}` });
}

/**
 * A recording's or clip's moment on OpenVibe.Video, in YouTube's shape: /watch?v=<watch id> (and &t=<seconds>).
 * The watch id is Media's; without one the numbered /v/<id> address still answers 301 to the watch page.
 */
function videoHref(vodId, sec, watchId = null) {
    const watch = /^[A-Za-z0-9_-]{11}$/.test(String(watchId || '')) ? String(watchId) : null;
    const t = sec != null && Number.isFinite(Number(sec)) && Number(sec) > 0 ? Math.floor(Number(sec)) : null;
    if (watch) return `https://openvibe.video/watch?v=${encodeURIComponent(watch)}${t ? `&t=${t}` : ''}`;
    const id = String(vodId == null ? '' : vodId).trim();
    if (!/^\d{1,16}$/.test(id)) return null;
    return `https://openvibe.video/v/${encodeURIComponent(id)}${t ? `?t=${t}` : ''}`;
}

function chapterHref(vodId, sec, watchId = null) {
    return videoHref(vodId, sec, watchId);
}

function episode({ episode: d, citations = [] } = {}) {
    const e = d.episode || {}, s = d.stream || {};
    const segs = (d.segments || []).slice(0, 60);
    // S7: the chapters are the recording's moments, linked into OpenVibe.Video; a chapter with no recording stays text.
    const vod = e.vod_id || s.vod_id || null;
    const watch = e.watch_id || s.watch_id || null;
    const chapters = (Array.isArray(e.chapters) ? e.chapters : []).slice(0, 40);
    const chaptersHTML = chapters.length ? `<section aria-labelledby="rp-ch-h"><h2 id="rp-ch-h">Chapters</h2><ol class="rp-chapters">${chapters.map((c) => {
        const href = (vod || watch) ? chapterHref(vod, c.sec, watch) : null;
        const stamp = `<span class="rp-stamp">${esc(String(Math.floor((Number(c.sec) || 0) / 60)).padStart(2, '0'))}:${esc(String((Number(c.sec) || 0) % 60).padStart(2, '0'))}</span>`;
        return `<li>${href ? `<a href="${esc(href)}">${stamp} ${esc(c.title)}</a>` : `${stamp} ${esc(c.title)}`}</li>`;
    }).join('')}</ol></section>` : '';
    const body = `<header class="rp-page-h"><p class="rp-kicker"><a href="/rundown">The Rundown</a> · episode</p><h1>${esc(e.title || s.title || 'Episode')}</h1>${e.logline ? `<p class="rp-lede">${esc(e.logline)}</p>` : ''}
<p class="rp-meta">${AI}${who(s.user) ? ` · <a href="/rundown/s/${encodeURIComponent(s.user.username)}">${esc(who(s.user))}</a>` : ''}${s.started_at ? ` · ${esc(dayTime(s.started_at))}` : ''}${s.id ? ` · <a href="/after-show/${encodeURIComponent(s.id)}">After-show report</a>` : ''}</p></header>
${chaptersHTML}
${segs.length ? `<section aria-labelledby="rp-sg-h"><h2 id="rp-sg-h">What happened</h2><ol class="rp-takes rp-timeline">${segs.map(takeRow).join('')}</ol></section>` : ''}
${(d.more || []).length ? `<section aria-labelledby="rp-mo-h"><h2 id="rp-mo-h">More from ${esc(who(s.user) || 'this streamer')}</h2><ul class="rp-chips">${d.more.slice(0, 8).map((m) => `<li><a href="/rundown/e/${encodeURIComponent(m.stream_id)}">${esc(m.title)}</a></li>`).join('')}</ul></section>` : ''}`;
    return layout({ title: `${e.title || s.title}: The Rundown`, description: e.logline || '', body, active: '/rundown', path: `/rundown/e/${encodeURIComponent(s.id || e.stream_id || '')}`, canonical: `${LIVE}/rundown/e/${encodeURIComponent(s.id || e.stream_id || '')}` });
}

function speaker({ speaker: d, username } = {}) {
    const u = d.user || { username };
    if (d.opted_out) return layout({ title: `${who(u)}: The Rundown`, robots: 'noindex, follow', body: `<header class="rp-page-h"><h1>${esc(who(u))}</h1><p class="rp-lede">${esc(who(u))} has opted out of The Rundown: nothing they say on stream is written up here.</p></header>`, active: '/rundown', canonical: `${LIVE}/rundown/${encodeURIComponent(u.username || username || '')}` });
    const body = `<header class="rp-page-h rp-person">${kit.mark({ name: who(u), src: u.avatar_url, size: 64 })}<div><p class="rp-kicker">The Rundown · voice</p><h1>${esc(who(u))}</h1><p class="rp-meta"><a href="https://openvibe.live/@${encodeURIComponent(u.username || username)}">Channel on OpenVibe.Live</a> · <a href="/c/${encodeURIComponent(u.username || username)}">After-show reports</a></p></div></header>
${(d.topics || []).length ? `<section aria-labelledby="rp-st-h"><h2 id="rp-st-h">Topics</h2><ul class="rp-topics">${d.topics.slice(0, 12).map(topicCard).join('')}</ul></section>` : ''}
${(d.lines || []).length ? `<section aria-labelledby="rp-sl-h"><h2 id="rp-sl-h">Takes</h2><ol class="rp-takes">${d.lines.slice(0, 20).map(takeRow).join('')}</ol><p class="rp-meta">${AI}</p></section>` : ''}
${(d.episodes || []).length ? `<section aria-labelledby="rp-se-h"><h2 id="rp-se-h">Episodes</h2><ul class="rp-chips">${d.episodes.slice(0, 12).map((m) => `<li><a href="/rundown/e/${encodeURIComponent(m.stream_id)}">${esc(m.title)}</a></li>`).join('')}</ul></section>` : ''}`;
    return layout({ title: `${who(u)}: The Rundown`, description: `What ${who(u)} talked about on stream, topic by topic.`, body, active: '/rundown', path: `/rundown/s/${encodeURIComponent(u.username || username || '')}`, canonical: `${LIVE}/rundown/${encodeURIComponent(u.username || username || '')}` });
}

function recap({ recap: d } = {}) {
    const r = d.recap || d;
    const s = r.stream || {}, u = r.streamer || {}, v = r.viewers || {}, c = r.chat || {}, love = r.love || {}, w = r.write || {}, vod = r.vod;
    const takes = (r.takes || []).filter((t) => t && t.title).sort((a, b) => (n(a.sec) ?? 1e9) - (n(b.sec) ?? 1e9)).slice(0, 8);
    const at = (sec) => (vod && (vod.id || vod.watch_id) && n(sec) != null ? videoHref(vod.id, sec, vod.watch_id) : null);
    const watching = vod ? videoHref(vod.id, null, vod.watch_id) : null;
    const body = `<header class="rp-page-h rp-recap-h"><p class="rp-kicker">After-show report</p><h1>${esc(w.headline || s.title || 'Stream')}</h1>
<p class="rp-meta">${kit.mark({ name: who(u), src: u.avatar_url, size: 28 })} <a href="https://openvibe.live/@${encodeURIComponent(u.username || '')}">@${esc(u.username || '')}</a>${s.title && w.headline ? ` · ${esc(s.title)}` : ''}${s.started_at ? ` · ${esc(dayTime(s.started_at))}` : ''}${n(s.duration_seconds) ? ` · ${esc(mins(s.duration_seconds))}` : ''}</p>
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
<p class="rp-act">${watching ? `<a class="rp-btn" href="${esc(watching)}">Watch the recording</a>` : ''} <a class="rp-btn is-quiet" href="/c/${encodeURIComponent(u.username || '')}">More from ${esc(who(u))}</a>${s.id ? ` <a class="rp-btn is-quiet" href="/rundown/e/${encodeURIComponent(s.id)}">In The Rundown</a>` : ''}</p>`;
    return layout({ title: `${w.headline || s.title}: after-show report`, description: w.summary || `How ${who(u)}'s stream went, in numbers.`, body, active: '/rundown', path: `/after-show/${encodeURIComponent(s.id || '')}` });
}

function channel({ username, recaps, views: v = null } = {}) {
    const list = (recaps && recaps.recaps) || [];
    const cards = list.slice(0, 30).map((x) => kit.card({ href: `/after-show/${x.stream_id}`, title: x.headline || x.title || 'Stream', peek: x.headline && x.title ? x.title : '', type: 'stream', image: x.thumbnail_url || '', badge: x.grade ? `Grade ${x.grade}` : '', corner: n(x.duration_seconds) ? mins(x.duration_seconds) : '', count: n(x.peak_viewers) ? [x.peak_viewers, 'peak'] : null, when: x.ended_at ? ts(x.ended_at) : null }));
    const body = `<header class="rp-page-h"><p class="rp-kicker">After-show reports</p><h1>${esc(username)}</h1><p class="rp-meta"><a href="https://openvibe.live/@${encodeURIComponent(username)}">Channel on OpenVibe.Live</a> · <a href="/rundown/s/${encodeURIComponent(username)}">In The Rundown</a></p></header>
${viewsSection(v && v.rows ? { creators: v } : null)}
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

function you({ user, days = 30, stats = null, recaps = null, speaker = null, ai = null, reports = null, defaultAudience = 'private' } = {}) {
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
<p class="rp-lede rp-you-say">${esc(youSentence({ name, days, stats, speaker }))}</p><nav class="rp-tabs" aria-label="Time range">${tabs}</nav><p class="rp-meta"><a href="/me">All your stats: your places, activity and what you made</a></p></div></header>
${streams}${money}${youAi(ai, days)}${youReports(reports, defaultAudience)}${rundown}
<section aria-labelledby="rp-you-next" class="rp-you-next"><h2 id="rp-you-next">Coming here</h2><p class="rp-fine">Your agents' work and what your computers ran. Only you see this page.</p></section>`;
    return layout({ title: 'Your numbers', description: 'Your own numbers across OpenVibe: streams, money and The Rundown, in one place.', body, active: '/you', robots: 'noindex, nofollow' });
}

/**
 * Your session reports, and the default for the ones you make from now on (design 2026-11-06, rule 1: "New reports:
 * Only me ▾" on the person's own page). Each report's Share sheet still changes just that one.
 */
function youReports(reports = null, defaultAudience = 'private') {
    if (!reports) return '';
    const list = Array.isArray(reports) ? reports : [];
    const options = ['public', 'link', 'people', 'private'].map((a) => `<option value="${esc(a)}"${a === defaultAudience ? ' selected' : ''}>${esc(sharingChip(a, 0).replace('Only you', 'Only me'))}</option>`).join('');
    const rows = list.slice(0, 20).map((r) => `<li><a href="/s/${encodeURIComponent(r.id)}">${esc(r.task.title)}</a>`
        + `<span class="rp-meta">${esc(sharingChip(r.audience || 'private', []))}</span></li>`).join('');
    return `<section aria-labelledby="rp-you-sr"><h2 id="rp-you-sr">Your session reports</h2>
<form class="rp-share-default" method="post" action="/api/v1/me/session-reports/default" data-ov-default-share>
<label for="rp-you-def">New reports:</label>
<select id="rp-you-def" name="audience">${options}</select>
<button type="submit" class="rp-btn is-quiet">Save</button>
</form>
<p class="rp-fine">Each report's Share button changes just that one. Changing this never changes a report you already made.</p>
${rows ? `<ul class="rp-chips rp-you-reports">${rows}</ul>` : '<p class="rp-meta">No reports yet. When an agent finishes a session, its report lands here.</p>'}
</section>`;
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
        ['GET /api/v1/ai/results', 'New public AI runs from OpenVibe.Bench, newest first, with their score, cost and time.'],
        ['GET /ai/feed.xml', 'The same new AI results as an RSS feed.'],
    ];
    const body = `<header class="rp-page-h"><p class="rp-kicker">For developers</p><h1>The Report API</h1><p class="rp-lede">Open JSON, no key, readable from any site (CORS). Counts only, never about a person.</p></header>
<section aria-labelledby="rp-ep-h"><h2 id="rp-ep-h">Endpoints</h2><dl class="rp-eps">${rows.map(([ep, what]) => `<div><dt><code>${esc(ep)}</code></dt><dd>${esc(what)}</dd></div>`).join('')}</dl></section>
<p class="rp-fine">Limits: 120 requests a minute from one address. Errors are problem+json (RFC 9457). <a href="/llms.txt">llms.txt</a> describes the site for agents.</p>`;
    return layout({ title: 'The Report API', description: 'Open JSON for the network\'s numbers, The Rundown and after-show reports.', body, active: '/developers', path: '/developers', agent: true });
}

function benchState(...reads) {
    const stale = reads.filter((r) => r && r.stale).sort((a, b) => String(a.at).localeCompare(String(b.at)));
    if (!stale.length) return '';
    return `<p class="rp-fine" role="status">Bench is unavailable. Showing the last good copy, read ${esc(dayTime(stale[0].at))}.</p>`;
}

/** The answer inside a Bench read ({ data, at, stale }), or null. */
const readData = (r) => (r && r.data != null ? r.data : null);
const aiPath = (kind) => `/ai/${encodeURIComponent(kind)}`;
const modelPath = (model) => `/ai/models/${encodeURIComponent(model)}`;
const modelLink = (subject) => `<a href="${modelPath(subject)}">${esc(subject)}</a>`;
const datasetLink = (kind) => `<p class="rp-fine">Download the <a href="${BENCH}/api/v1/datasets/${encodeURIComponent(kind)}.jsonl">dataset JSONL</a> from Bench.</p>`;
const scoreText = (v) => { const x = n(v); return x == null ? '—' : `${Math.round(x * 10) / 10}`; };
const scoreCell = (v) => { const x = n(v); return x == null ? '—' : `<span title="${esc(String(v))} / 100 from Bench">${esc(scoreText(v))}</span>`; };
const moneyCell = (v) => { const x = n(v); return x == null ? '—' : `<span title="${esc(String(v))} USD from Bench">${esc(usd(x))}</span>`; };
const speedCell = (v) => { const x = n(v); if (x == null) return '—'; return `<span title="${exact(x)} ms from Bench">${esc(msText(x))}</span>`; };
function msText(v) {
    const x = n(v);
    if (x == null) return '—';
    if (x >= 60_000) return `${(x / 60_000).toFixed(x >= 600_000 ? 0 : 1).replace(/\.0$/, '')} min`;
    if (x >= 1_000) return `${(x / 1_000).toFixed(x >= 10_000 ? 0 : 1).replace(/\.0$/, '')} s`;
    return `${Math.round(x)} ms`;
}
const lastRunText = (v) => (v ? `Last run ${dayTime(v)}` : 'No runs yet');
const provenanceCell = (p) => (p === 'verified' ? '<span class="rp-fine">verified</span>' : p === 'submitted' ? '<span class="rp-flag">submitted</span>' : '—');
/** A reading of quality against cost: a model is on the frontier when nothing beats it on both. */
function frontier(rows, xKey, yKey) {
    return rows.map((r) => {
        const x = n(r[xKey]), y = n(r[yKey]);
        const best = x != null && y != null && !rows.some((o) => {
            if (o === r) return false;
            const ox = n(o[xKey]), oy = n(o[yKey]);
            return ox != null && oy != null && ox <= x && oy >= y && (ox < x || oy > y);
        });
        return { ...r, frontier: best, cost: x, quality: y };
    });
}
/** A benchmark's leads and last run, from the overview list (no new number is derived). */
function byKindFromOverview(overview) {
    const map = new Map();
    for (const b of (overview && Array.isArray(overview.list) ? overview.list : [])) {
        if (!b || !b.kind) continue;
        const at = b.last_run;
        if (!at) continue;
        if (!map.has(b.kind) || String(at) > String(map.get(b.kind))) map.set(b.kind, at);
    }
    return map;
}

// ── AI (OpenVibe.Bench, plan 2026-10-28 §4.12; the owner moved its pages here 2026-11-08) ──
// The reader came to choose a model for a job. Every figure is Bench's: a board's rating, a run's score, the
// cost and the milliseconds the run carried, and the moment it was published. A job nobody has rated yet is a
// short wait list, never a made-up leader.
const JUDGE_SHORT = { human_pairwise: 'blind votes', audience_poll: 'audience polls', rubric: 'a rubric', automatic_grader: 'a grader', test_suite: 'a test suite', game_outcome: 'game results' };
const JUDGE_LONG = {
    human_pairwise: 'People see two answers blind and pick the better one. A vote is one game between two models.',
    audience_poll: 'An audience votes on the outputs; the poll is recorded as one game, however many people voted.',
    rubric: 'A rubric scores the output against the task’s stated criteria.',
    automatic_grader: 'A grader checks the output against the expected answer or the task’s rules.',
    test_suite: 'A pinned test suite runs the output; it passes only when the tests pass.',
    game_outcome: 'The game itself decides: the result is the judgement, not a person’s opinion.',
};
const ROOM_HOSTS = { chat: 'openvibe.chat', games: 'openvibe.games', search: 'search.openvibe.network', codes: 'openvibe.codes' };
const roomHost = (room) => { const r = rooms.get(room); return (r && r.host) || ROOM_HOSTS[room] || null; };
const rowsOf = (read) => (read && read.data && read.data.board && Array.isArray(read.data.board.rows) ? read.data.board.rows : []);
const played = (rows) => {
    const list = rows || [];
    if (!list.some((r) => r && r.games != null)) return list.length > 0;
    return list.some((r) => (n(r && r.games) || 0) > 0);
};
const howRated = (kind) => `Rated by ${JUDGE_SHORT[kind && kind.judge] || 'Bench'}`;
const METHOD = 'Ratings are Bradley–Terry Elo from Bench, with a 95% interval; a model with fewer than ten games is provisional.';
const CHART_NOTE = 'Up and to the left is better. The dashed line joins the models nothing beats on both.';
const BENCH_API = `${BENCH}/api/v1`;

function emptyFor(kind) {
    const host = kind && kind.judge === 'human_pairwise' ? roomHost(kind.room) : null;
    if (host) return kit.empty({ icon: 'trophy', title: 'No votes yet', text: `This board fills as people compare two answers blind on ${roomName(kind.room)} and pick the better one.`, action: { href: `https://${host}/`, label: `Vote on ${roomName(kind.room)}`, icon: 'forward' } });
    return kit.empty({ icon: 'trophy', title: 'No results yet', text: kind ? `This board fills as models are run and ${JUDGE_SHORT[kind.judge] || 'Bench'} scores them.` : 'This board fills as models are run on Bench.' });
}

/** The cost-per-solved chart Bench's boards already use: quality (0–1) against cost per solved task. */
function paretoRows(pareto, cost) {
    const costs = new Map(rowsOf(cost).map((r) => [r.subject, n(r.cost_per_solved)]));
    const rows = rowsOf(pareto).map((r) => ({ ...r, quality: n(r.quality), costPerSolved: costs.get(r.subject) }));
    return frontier(rows.map((r) => ({ ...r, x: r.costPerSolved, y: r.quality })), 'x', 'y');
}
function paretoChart(rows) {
    const points = rows.filter((r) => r.quality != null && r.costPerSolved != null && r.costPerSolved >= 0);
    if (!points.length) return '<p class="rp-fine">No quality and cost per solved pairs yet.</p>';
    return kit.chart({
        type: 'scatter', title: 'Quality against cost per solved task', note: CHART_NOTE,
        x: { label: 'Cost per solved task (USD, lower is better)', fmt: (v) => usd(v) }, y: { label: 'Quality', fmt: (v) => `${Math.round(v)}%`, zero: false },
        points: points.map((r) => ({ label: r.subject, x: r.costPerSolved, y: r.quality * 100, best: r.frontier, mark: r.frontier || points.length <= 8, href: modelPath(r.subject) })),
        height: 260,
    });
}
/** A benchmark's verifier: score 0–100 against the median cost of a run. The frontier is the same reading. */
function scoreCostChart(entries) {
    const rows = frontier(entries.filter((r) => n(r.cost_usd) != null && n(r.score) != null).map((r) => ({ ...r, x: n(r.cost_usd), y: n(r.score) })), 'x', 'y');
    if (!rows.length) return '';
    return kit.chart({
        type: 'scatter', title: 'Score against cost per run', note: CHART_NOTE,
        x: { label: 'Median cost of a run (USD, lower is better)', fmt: (v) => usd(v) }, y: { label: 'Score (0–100)', fmt: (v) => `${Math.round(v)}`, zero: false },
        points: rows.map((r) => ({ label: r.model, x: r.cost, y: r.quality, best: r.frontier, mark: r.frontier || rows.length <= 8, href: modelPath(r.model) })),
        height: 260,
    });
}

const TABS = [{ key: 'elo', label: 'Ranking' }, { key: 'pareto', label: 'Quality and cost' }, { key: 'cost', label: 'Cost per solved' }];

// ── The AI Exchange (plan G-P9): Billing's settlements, summed by day, model and access ────────────────────────
// Money is integer nano-USD and stays exact: this formatter works in BigInt, never in floats, and the title carries
// the exact nano-USD the authority sent.
function usdNano(v) {
    if (v == null) return '\u2014';
    let n;
    try { n = BigInt(String(v)); } catch { return '\u2014'; }
    const neg = n < 0n;
    const abs = neg ? -n : n;
    const whole = abs / 1_000_000_000n;
    const frac = (abs % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
    const digits = frac.length < 2 ? `${frac}00`.slice(0, 2) : frac;
    const group = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `${neg ? '-' : ''}$${group}.${digits}`;
}
const nanoCell = (v) => (v == null ? '\u2014' : `<span title="${esc(String(v))} nano-USD from Billing">${esc(usdNano(v))}</span>`);

function aiExchange({ range = {}, rows = [], daily = [], totals = {}, rejected = {} } = {}) {
    const t = totals || {};
    const tokens = t.tokens || {};
    const tokenTotal = (n(tokens.input) || 0) + (n(tokens.cached_read) || 0) + (n(tokens.cache_write) || 0) + (n(tokens.output) || 0);
    const rejectedCount = Number(rejected && rejected.count) || 0;
    const tiles = `<div class="rp-tiles rp-tiles-sm">
${tile('Settlements', exact(t.requests))}
${tile('Sandbox', exact(t.sandbox_requests), 'not money')}
${tile('Tokens', esc(bigNum(tokenTotal)))}
${tile('Retail', esc(usdNano(t.retail_nano_usd)))}
${tile('Shortfall', esc(usdNano(t.shortfall_nano_usd)), 'owed, not collected')}
${tile('Supply', esc(usdNano(t.supply_nano_usd)))}
${tile('Margin', esc(usdNano(t.margin_nano_usd)), 'retail minus supply')}
${rejectedCount ? tile('Rejected', exact(rejectedCount), 'invalid payloads') : ''}
</div>`;
    const table = rows.length ? kit.table({
        caption: 'By day, model and provider access',
        columns: [
            { key: 'day', label: 'Day', primary: true },
            { key: 'model', label: 'Model' },
            { key: 'access', label: 'Access' },
            { key: 'requests', label: 'Requests', num: true, fmt: 'int' },
            { key: 'sandbox_requests', label: 'Sandbox', num: true, fmt: 'int' },
            { key: 'input', label: 'Input', num: true, fmt: 'int' },
            { key: 'cached_read', label: 'Cache read', num: true, fmt: 'int' },
            { key: 'cache_write', label: 'Cache write', num: true, fmt: 'int' },
            { key: 'output', label: 'Output', num: true, fmt: 'int' },
            { key: 'retail', label: 'Retail', num: true, html: true },
            { key: 'shortfall', label: 'Shortfall', num: true, html: true },
            { key: 'supply', label: 'Supply', num: true, html: true },
            { key: 'margin', label: 'Margin', num: true, html: true },
        ],
        rows: rows.map((r) => ({
            day: r.day, model: r.model, access: r.provider_access, requests: r.requests, sandbox_requests: r.sandbox_requests,
            input: r.tokens.input, cached_read: r.tokens.cached_read, cache_write: r.tokens.cache_write, output: r.tokens.output,
            retail: nanoCell(r.retail_nano_usd), shortfall: nanoCell(r.shortfall_nano_usd), supply: nanoCell(r.supply_nano_usd),
            margin: nanoCell(r.margin_nano_usd),
        })),
    }) : `<p class="rp-fine">No settlements in this range. The table fills as Billing posts settlements; with ${esc('REPORT_AI_EXCHANGE')} off, nothing is consumed.</p>`;
    const head = kit.head({ title: 'AI Exchange', sub: 'What Billing settled, by day, model and provider access', sticky: false });
    const body = head
        + `<p class="rp-lede">Aggregates only: no person, no project, no prompt. Report reads the authorities and never sets a rate, a price or a balance. Retail is what was collected, shortfall is what is owed but not collected, supply is what the route cost, and the margin is retail minus supply. Sandbox settlements are counted apart and are never money.</p>
<p class="rp-fine">${esc(range.from || '')} to ${esc(range.to || '')}${range.days ? ` \u00b7 ${esc(range.days)} days` : ''}. Money is exact integer nano-USD from Billing; the exact amount is in each cell's title.</p>
${tiles}
${daily.length > 1 ? `<section aria-labelledby="rp-ex-chart"><h2 id="rp-ex-chart">Settlements a day</h2>${bars(daily.map((d) => ({ day: d.day, n: d.requests })), 'Settlements a day', { h: 110 })}</section>` : ''}
<section aria-labelledby="rp-ex-table"><h2 id="rp-ex-table">The daily table</h2>${table}</section>
<p class="rp-meta"><a href="/api/v1/ai/exchange">As JSON</a></p>`;
    return layout({ title: 'AI Exchange analytics', description: 'Billing settlements aggregated by day, model and provider access.', robots: 'noindex, nofollow', body, active: '/ai', path: '/ai/exchange' });
}

/** The page a person sees when the staff gate refuses them: signed out asks for a sign-in, signed in says why. */
function staffOnly({ signedIn = false } = {}) {
    const text = signedIn
        ? 'Your OpenVibe.Network account does not hold staff.site.view. This page reads the network\'s AI Exchange analytics; ask an admin if you need it.'
        : 'This page is for OpenVibe.Network staff. Sign in with an account that holds staff.site.view.';
    const action = signedIn ? '' : '<p class="rp-meta"><a href="/auth/login?next=/ai/exchange">Sign in</a></p>';
    return layout({ title: 'Staff only', description: 'Staff only.', robots: 'noindex, nofollow', body: `<header class="rp-page-h"><p class="rp-kicker">OpenVibe.Report</p><h1>Staff only</h1><p class="rp-lede">${esc(text)}</p>${action}</header>` });
}

// ── A person's stats (the owner, 2026-11-09): private /me, public /u/<name> ─────────────────────────────
//
// Every number is a source's: Network's cross-site history (visits, not minutes), Report's analytics (streams and
// hours), Report's AI meter, Billing's settled Vibes and the person's session reports. A section a source did not
// answer for is absent, never a zero. The charts are server-drawn SVG with the numbers in their aria-label, and the
// tables are the same numbers as text.
const STAT_SECTIONS = [
    ['sites', 'Sites you used', 'The OpenVibe sites you opened, from Network’s history. A page opened again within ten minutes is one visit.'],
    ['activity', 'Your activity', 'The days you were around, week by week, and the streak that ends today.'],
    ['made', 'Things you made', 'What Report can count so far: your streams and hours, and the agent sessions you ran.'],
    ['ai', 'Your AI', 'Your own calls on the AI meter: what they cost and how many there were.'],
    ['money', 'Vibes', 'What Billing says reached you. Report stores no money and derives no amount.'],
];
const STAT_LABEL = Object.fromEntries(STAT_SECTIONS.map(([k, label]) => [k, label]));
// The public page speaks about the person, never to the reader: the same sections, in the third person.
const STAT_PUBLIC_NOTE = {
    sites: 'The OpenVibe sites they opened, from Network’s history. A page opened again within ten minutes is one visit.',
    activity: 'The days they were around, week by week, and the streak that ends today.',
    made: 'What Report can count so far: their streams and hours, and the agent sessions they ran.',
    ai: 'Their own calls on the AI meter: what they cost and how many there were.',
    money: 'What Billing says reached them. Report stores no money and derives no amount.',
};

function statSites(sites) {
    if (!sites || !Array.isArray(sites.month) || !sites.month.length) {
        return kit.empty({ icon: 'compass', title: 'No places yet', text: 'When you use OpenVibe signed in, the sites you open show up here. Nothing is recorded for signed-out visits.' });
    }
    const week = new Map((Array.isArray(sites.week) ? sites.week : []).map((s) => [s.service, s.visits]));
    const top = Math.max(1, ...sites.month.map((s) => Number(s.visits) || 0));
    // Designed 11-09: a bar per site reads at a glance (it was a table of two numbers per site).
    const rows = sites.month.map((s, i) => {
        const n = Number(s.visits) || 0, w = week.get(s.service) || 0;
        return `<li style="--p:${Math.max(3, Math.round(n / top * 100))}%;--i:${i}"><a href="${esc(s.url)}">${esc(s.label)}</a>`
            + `<span class="rp-sbar" aria-hidden="true"><i></i></span><b>${fmt(n)}</b><small>${w ? `${fmt(w)} this week` : 'none this week'}</small></li>`;
    }).join('');
    return `<ol class="rp-sites" aria-label="Visits by site in this window, with this week's">${rows}</ol>
<p class="rp-fine">Counted from Network’s cross-site history: a visit is a page, not a length of time. Times are UTC.</p>`;
}

/** Twelve weeks as a grid of days (a column a week, Monday on top), shaded by visits; the numbers stay in a table. */
function heatmap(weeks) {
    const all = weeks.flatMap((w) => (w.days || []).map((n) => Number(n) || 0));
    const max = Math.max(1, ...all);
    const level = (n) => (n <= 0 ? 0 : Math.min(4, Math.ceil(n / max * 4)));
    const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const cols = weeks.map((w) => `<span class="rp-heat-col">${DAYS.map((d, j) => {
        const n = Number((w.days || [])[j]) || 0;
        return `<i class="l${level(n)}" title="${esc(`${d}, week of ${day(w.week_start)}: ${n} ${n === 1 ? 'visit' : 'visits'}`)}"></i>`;
    }).join('')}</span>`).join('');
    return `<div class="rp-heat" role="img" aria-label="${esc(`Visits a day for ${weeks.length} weeks; the table below has every number`)}">
<span class="rp-heat-days" aria-hidden="true"><i>Mon</i><i></i><i>Wed</i><i></i><i>Fri</i><i></i><i>Sun</i></span><span class="rp-heat-grid">${cols}</span></div>
<p class="rp-heat-key" aria-hidden="true"><span>${esc(day(weeks[0].week_start))}</span><span class="rp-heat-scale">Fewer <i class="l0"></i><i class="l1"></i><i class="l2"></i><i class="l3"></i><i class="l4"></i> More</span><span>${esc(day(weeks[weeks.length - 1].week_start))}</span></p>`;
}

function statActivity(activity) {
    if (!activity || !Array.isArray(activity.weeks) || !activity.weeks.length) return '';
    if (!activity.active_days && !activity.streak_days) {
        return kit.empty({ icon: 'calendar', title: 'No activity yet', text: 'Your days fill in as you use OpenVibe signed in. Nothing is recorded for signed-out visits.' });
    }
    const weeks = activity.weeks.map((w) => ({ week_start: w.week_start, week: day(w.week_start), total: (w.days || []).reduce((a, b) => a + (Number(b) || 0), 0), days: w.days || [] }));
    const chart = bars(weeks.map((w) => ({ day: w.week_start, n: w.total })), 'Visits a week', { h: 90 });
    const rows = activity.weeks.map((w, i) => ({
        week: day(w.week_start),
        mon: (w.days && w.days[0]) || 0, tue: (w.days && w.days[1]) || 0, wed: (w.days && w.days[2]) || 0, thu: (w.days && w.days[3]) || 0,
        fri: (w.days && w.days[4]) || 0, sat: (w.days && w.days[5]) || 0, sun: (w.days && w.days[6]) || 0,
    }));
    return `<div class="rp-tiles rp-tiles-sm">${tile('Active days', exact(activity.active_days))}${tile('Streak', exact(activity.streak_days), Number(activity.streak_days) === 1 ? 'day in a row' : 'days in a row')}</div>
${heatmap(activity.weeks)}
${chart}
<details class="rp-fold"><summary>Every day as numbers <span>${activity.weeks.length} weeks</span></summary>
${kit.table({
        caption: 'Visits by day, last twelve weeks (UTC)',
        stack: false,
        columns: [
            { key: 'week', label: 'Week of', primary: true },
            { key: 'mon', label: 'Mon', num: true }, { key: 'tue', label: 'Tue', num: true }, { key: 'wed', label: 'Wed', num: true },
            { key: 'thu', label: 'Thu', num: true }, { key: 'fri', label: 'Fri', num: true }, { key: 'sat', label: 'Sat', num: true }, { key: 'sun', label: 'Sun', num: true },
        ],
        rows,
    })}</details>`;
}

function statMade(made, { publicView = false } = {}) {
    const items = made && Array.isArray(made.items) ? made.items : [];
    if (!items.length) return kit.empty({ icon: 'sparkles', title: 'Nothing counted yet', text: 'Streams, hours and your agent reports appear here when Report has them for this window.' });
    return `<div class="rp-tiles rp-tiles-sm">${items.map((it) => tile(it.label, `${fmt(it.count)}<small> ${esc(it.unit || '')}</small>`, (it.href && (!publicView || it.key === 'streams') ? `<a href="${esc(it.href)}">See them</a>` : ''))).join('')}</div>`;
}

function statAi(ai, { publicView = false } = {}) {
    if (!ai || !(Number(ai.calls) > 0)) return '';
    const daily = (ai.daily || []).map((d) => ({ day: d.day, n: d.calls }));
    return `<div class="rp-tiles rp-tiles-sm">${tile('Calls', exact(ai.calls))}${tile('Tokens', fmt(ai.tokens))}${tile('Cost', usd(ai.cost_usd))}</div>
${daily.length > 1 ? bars(daily, 'AI calls a day', { h: 100 }) : ''}
${publicView ? '' : '<p class="rp-meta"><a href="/you#rp-you-ai">The whole AI meter</a> · <a href="/api/v1/me/ai/usage">As JSON</a></p>'}`;
}

function statMoney(money) {
    if (!money || !(Number(money.transactions) > 0)) return '';
    return `<div class="rp-tiles rp-tiles-sm">${tile('Vibes earned', exact(money.settled_bits))}${tile('Payments', exact(money.transactions))}</div>
<p class="rp-fine">These are Billing’s settled amounts. Report never computes a price, a fee or a balance: <a href="https://billing.openvibe.network/">every receipt is on Billing</a>.</p>`;
}

/** One publish row: a checkbox and its hidden false, so an unchecked box is an explicit "no". */
function publishRow(key, checked, note) {
    return `<li class="rp-publish-row"><label><input type="hidden" name="${esc(key)}" value="false"><input class="rp-switch" type="checkbox" role="switch" name="${esc(key)}" value="true"${checked ? ' checked' : ''}> <b>${esc(STAT_LABEL[key] || key)}</b></label> <span class="rp-fine">· ${esc(note)}</span></li>`;
}

function publishPanel({ doc, username }) {
    const p = doc.published || {};
    const any = Object.values(p).some(Boolean);
    const publicUrl = `${BASE}/u/${encodeURIComponent(username)}`;
    return `<section class="rp-share" id="rp-share" aria-labelledby="rp-pub-h"><h2 id="rp-pub-h">Share your stats</h2>
<p class="rp-lede">Private by default: only you see this page. Turn a section on to publish it at <a href="/u/${encodeURIComponent(username)}">/u/${esc(username)}</a>. Each section is a separate choice; a published section shows the numbers in this snapshot.</p>
<form class="rp-publish" method="post" action="/api/v1/me/stats/published">
<fieldset><legend class="rp-sr">Public sections</legend><ul>${STAT_SECTIONS.map(([key]) => publishRow(key, p[key], p[key] ? 'Public now' : 'Only you')).join('')}</ul>
${kit.button({ label: 'Save public sections', icon: 'check' })}
</fieldset></form>
${any ? `<div class="rp-share-card"><p class="rp-kicker">Share card</p><h3>${esc(doc.person.display_name || username)}’s OpenVibe stats</h3><p class="rp-fine">Anyone with this link sees only the sections you made public.</p><p><a href="/u/${encodeURIComponent(username)}">${esc(publicUrl)}</a></p></div>` : `<p class="rp-fine">Nothing is public yet. Your public link will be <code>/u/${esc(username)}</code>.</p>`}
</section>`;
}

function me({ user, doc, days = 30 } = {}) {
    const name = String((user && (user.display_name || user.username)) || doc.person.display_name || 'you');
    const username = String(doc.person.username || (user && user.username) || '');
    const s = doc.sections || {};
    const tabs = [7, 30, 90].map((d) => `<a href="/me?days=${d}"${Number(days) === d ? ' aria-current="page"' : ''}>${d} days</a>`).join('');
    const body = `<header class="rp-page-h">${kit.mark({ name, src: (user && user.avatar_url) || doc.person.avatar_url || '', size: 64 })}<div><p class="rp-kicker">Your stats</p><h1>${esc(name)}</h1>
<p class="rp-lede">Everything OpenVibe counts for you, in one place. Private by default; you choose what is public.</p><nav class="rp-tabs" aria-label="Time range">${tabs}</nav></div></header>
${doc.note ? kit.notice({ kind: 'info', text: doc.note }) : ''}
${(() => { const n = Object.values(doc.published || {}).filter(Boolean).length; return `<p class="rp-privacy${n ? ' is-public' : ''}"><span>${n ? `${n} ${n === 1 ? 'section is' : 'sections are'} public` : 'Private: only you see this page'}</span> <a href="#rp-share">${n ? 'Change' : 'Share some of it'}</a></p>`; })()}
${s.sites ? kit.section({ title: 'Sites you used', count: (s.sites.month || []).length, note: STAT_SECTIONS[0][2], body: statSites(s.sites), id: 'rp-me-sites' }) : ''}
${s.activity ? kit.section({ title: 'Your activity', note: STAT_SECTIONS[1][2], body: statActivity(s.activity), id: 'rp-me-activity' }) : ''}
${s.made ? kit.section({ title: 'Things you made', note: STAT_SECTIONS[2][2], body: statMade(s.made), id: 'rp-me-made' }) : ''}
${s.ai ? kit.section({ title: 'Your AI', note: STAT_SECTIONS[3][2], body: statAi(s.ai), id: 'rp-me-ai' }) : ''}
${s.money ? kit.section({ title: 'Vibes', note: STAT_SECTIONS[4][2], body: statMoney(s.money), id: 'rp-me-money' }) : ''}
${publishPanel({ doc, username })}
<p class="rp-fine">Counted ${esc(dayTime(doc.generated_at))}. <a href="/you">Your streams, money, AI and The Rundown</a> · <a href="/api/v1/me/stats?days=${esc(days)}">Your numbers as JSON</a>.</p>`;
    return layout({ title: 'Your stats', description: 'Your own numbers across OpenVibe: the sites you used, your activity, what you made, your AI and your Vibes.', body, active: '/me', robots: 'noindex, nofollow' });
}

function meSignedOut() {
    const body = `<header class="rp-page-h"><p class="rp-kicker">Your stats</p><h1>Your OpenVibe, in numbers</h1>
<p class="rp-lede">The sites you use, the days you were around, what you made, your AI and the Vibes that reached you. Private by default: you choose which sections, if any, are public.</p>
<p>${kit.button({ href: `/auth/login?next=${encodeURIComponent('/me')}`, label: 'Sign in to see yours', icon: 'forward' })}</p>
<p class="rp-fine">A public stats page looks like <a href="/stats">the rest of Report</a>: server-rendered numbers, no account needed to read what someone chose to publish.</p></header>`;
    return layout({ title: 'Your stats', description: 'Sign in to see your own numbers across OpenVibe.', body, active: '/me', robots: 'noindex, nofollow' });
}

function meError({ user } = {}) {
    const name = String((user && (user.display_name || user.username)) || 'there');
    return layout({ title: 'Your stats', robots: 'noindex, nofollow', body: `<header class="rp-page-h"><p class="rp-kicker">Your stats</p><h1>${esc(name)}, your numbers did not load</h1><p class="rp-lede">One of the sources did not answer. Nothing is shown as a zero. Try again in a moment; <a href="/you">your streams, AI and Rundown</a> are still here.</p></header>` });
}

function publicStats({ doc } = {}) {
    const person = doc.person || {};
    const username = String(person.username || '');
    const name = String(person.display_name || username);
    const s = doc.sections || {};
    const any = Object.values(doc.published || {}).some(Boolean);
    const body = `<header class="rp-page-h">${kit.mark({ name, src: person.avatar_url || '', size: 64 })}<div><p class="rp-kicker">Public stats</p><h1>${esc(name)}’s OpenVibe</h1>
<p class="rp-lede">The numbers ${esc(name)} chose to publish. Private by default: nothing else is here.</p></div></header>
${s.sites ? kit.section({ title: 'Sites used', count: (s.sites.month || []).length, note: STAT_PUBLIC_NOTE.sites, body: statSites(s.sites), id: 'rp-u-sites' }) : ''}
${s.activity ? kit.section({ title: 'Activity', note: STAT_PUBLIC_NOTE.activity, body: statActivity(s.activity), id: 'rp-u-activity' }) : ''}
${s.made ? kit.section({ title: 'Things made', note: STAT_PUBLIC_NOTE.made, body: statMade(s.made, { publicView: true }), id: 'rp-u-made' }) : ''}
${s.ai ? kit.section({ title: 'AI', note: STAT_PUBLIC_NOTE.ai, body: statAi(s.ai, { publicView: true }), id: 'rp-u-ai' }) : ''}
${s.money ? kit.section({ title: 'Vibes', note: STAT_PUBLIC_NOTE.money, body: statMoney(s.money), id: 'rp-u-money' }) : ''}
<p class="rp-fine">Published ${esc(dayTime(doc.generated_at))} · ${any ? 'only the sections above' : 'no sections'} · <a href="/stats">the network’s open numbers</a>.</p>`;
    return layout({
        title: `${name}: OpenVibe stats`,
        description: `${name}’s OpenVibe numbers: the sites they used, their activity and what they made. Only the sections they made public.`,
        path: `/u/${encodeURIComponent(username)}`,
        robots: 'index, follow',
        jsonLd: [{
            '@context': 'https://schema.org',
            '@type': 'Person',
            name,
            alternateName: username,
            url: canon(`/u/${encodeURIComponent(username)}`),
            ...(person.avatar_url ? { image: person.avatar_url } : {}),
            description: `${name}’s public OpenVibe stats, published by them on OpenVibe.Report.`,
        }],
        og: { type: 'profile', title: `${name}: OpenVibe stats`, description: `${name}’s public OpenVibe numbers. Private by default.`, url: canon(`/u/${encodeURIComponent(username)}`), image: person.avatar_url || undefined },
        body,
        active: '/me',
    });
}

function publicStatsPrivate({ doc } = {}) {
    const person = (doc && doc.person) || {};
    const name = String(person.display_name || person.username || 'This person');
    return layout({
        title: `${name}: private stats`,
        robots: 'noindex, nofollow',
        body: `<header class="rp-page-h"><p class="rp-kicker">Private</p><h1>${esc(name)} keeps their numbers private</h1><p class="rp-lede">Nothing has been published from this page. On OpenVibe.Report, a person’s stats are private until they turn a section on.</p><p class="rp-fine"><a href="/stats">The network’s open numbers</a> · <a href="/">OpenVibe.Report</a></p></header>`,
        active: '/me',
    });
}

function notFound() {
    return layout({ title: 'Not found', robots: 'noindex, follow', body: `<header class="rp-page-h"><h1>Nothing here</h1><p class="rp-lede">That page does not exist, or its source has nothing for it. <a href="/">Back to Report</a>.</p></header>` });
}

module.exports = { home, stats, rundown, sessionReport, sharingChip, topic, episode, speaker, recap, channel, you, youSignedOut, me, meSignedOut, meError, publicStats, publicStatsPrivate, developers, aiExchange, staffOnly, usdNano, paretoRows, paretoChart, notFound, layout, setRelease, configure };
