'use strict';
/**
 * Traffic pages (plan AD.40; the owner 2026-11-28: "so we know whats up with which bots … separate bot traffic. have a
 * full analytics suite"): openvibe.report/traffic (the network), /traffic/sites/:host (one site, its files for
 * machines and who read them), /traffic/bots/:agent (one bot). Counted on the server from every request, so the bots
 * that never run a page's script are here; never an address, never a person.
 */
const kit = require('openvibe-shared/kit');
const { layout, tile, exact, fmt, dayTime, whenTag } = require('./index');
const { WHO, WHO_LINE } = require('../traffic/agents');
const { KIND } = require('../traffic/paths');

const esc = kit.esc;
const ORDER = ['person', 'search', 'ai_crawler', 'ai_assistant', 'preview', 'seo', 'monitor', 'script', 'bot', 'own'];
const RANGES = [[1, 'Today'], [7, '7 days'], [30, '30 days'], [90, '90 days']];
const share = (part, whole) => (whole ? `${Math.round((part / whole) * 1000) / 10}%` : '—');
const botHref = (agent) => `/traffic/bots/${encodeURIComponent(agent)}`;
const siteHref = (host) => `/traffic/sites/${encodeURIComponent(host)}`;
const glyph = (name) => `<i data-ov-icon="${esc(name)}" aria-hidden="true"></i>`;
const shortDay = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

function tabs(base, days) {
    return `<nav class="rp-tabs" aria-label="Time range">${RANGES.map(([d, l]) => `<a href="${esc(base)}${d === 7 ? '' : `?days=${d}`}"${Number(days) === d ? ' aria-current="page"' : ''}>${esc(l)}</a>`).join('')}</nav>`;
}

/** People and each kind of bot a day, stacked; a legend with each total. */
function stacked(daily, totals) {
    const cols = (daily || []).map((d) => ({ day: d.day, label: d.label || shortDay(d.day), parts: ORDER.map((w) => [w, Number(d[w]) || 0]), sum: ORDER.reduce((a, w) => a + (Number(d[w]) || 0), 0) }));
    const max = Math.max(1, ...cols.map((c) => c.sum));
    const H = 150;
    const w = 100 / Math.max(1, cols.length);
    const rects = cols.map((c, i) => {
        let y = H;
        return c.parts.filter(([, v]) => v > 0).map(([who, v]) => {
            const h = Math.max(0.8, (v / max) * (H - 10));
            y -= h;
            return `<rect class="tf-w-${who}" x="${(i * w + w * 0.15).toFixed(2)}" y="${y.toFixed(1)}" width="${(w * 0.7).toFixed(2)}" height="${h.toFixed(1)}"><title>${esc(c.label)}: ${esc(WHO[who])} ${exact(v)}</title></rect>`;
        }).join('');
    }).join('');
    const label = cols.map((c) => `${c.label} ${exact(c.sum)}`).join(', ');
    const legend = ORDER.filter((who) => (totals.by_who || {})[who]).map((who) => `<li title="${esc(WHO_LINE[who])}"><span class="tf-sw tf-w-${who}"></span>${esc(WHO[who])}<b>${fmt(totals.by_who[who])}</b></li>`).join('');
    return `<figure class="tf-chart"><svg viewBox="0 0 100 ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(`Requests a day: ${label}`)}">${rects}</svg>`
        + (cols.length > 1 ? `<figcaption><span>${esc(cols[0].label)}</span><span>${esc(cols[cols.length - 1].label)}</span></figcaption>` : '')
        + `</figure><ul class="tf-legend">${legend}</ul>`;
}

function tilesOf(t, extra = '') {
    return `<section class="rp-tiles" aria-label="In this window">
${tile('Requests', fmt(t.total))}
${tile('People', fmt(t.people), share(t.people, t.total))}
${tile('Bots and programs', fmt(t.bots), share(t.bots, t.total))}
${tile('AI', fmt(t.ai), 'crawlers and assistants')}
${extra}</section>`;
}

/** Rows of a table: the first `n` shown, the rest folded behind "Show all" (never cut). */
function fold(rows, n = 12) {
    if (rows.length <= n) return rows.join('');
    return rows.slice(0, n).join('') + `<details class="tf-more"><summary>Show all ${rows.length}</summary>${rows.slice(n).join('')}</details>`;
}

const REGION = (() => { try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch { return null; } })();
const countryName = (cc) => (cc === 'T1' ? 'Tor' : (REGION && REGION.of(cc)) || cc);

/** A list with a bar per row (the largest is full width), folded after 10. */
function barList(items, label, value, extra = () => '') {
    if (!items.length) return '';
    const max = Math.max(1, ...items.map(value));
    const total = items.reduce((a, x) => a + value(x), 0);
    return `<div class="tf-bars" role="list">${fold(items.map((x) => `<div class="tf-brow" role="listitem"><span class="tf-bar" style="--w:${((value(x) / max) * 100).toFixed(1)}%"></span><span class="tf-bl">${label(x)}</span><span class="tf-bv">${exact(value(x))} <span class="tf-muted">${share(value(x), total)}</span>${extra(x)}</span></div>`), 10)}</div>`;
}
function arrivals(d) {
    const sources = (d.sources || []).filter((x) => x.requests > 0);
    const countries = (d.countries || []).filter((x) => x.people + x.bots > 0);
    const where = sources.length ? `<section aria-labelledby="tf-src-h"><h2 id="tf-src-h">${glyph('link')}Where people come from</h2><p class="rp-fine">People opening a page, by the site that sent them; "Direct" had none (a typed address, an app, a bookmark). Only the site is kept, never its page.</p>${barList(sources, (x) => esc(x.source), (x) => x.requests)}</section>` : '';
    const from = countries.length ? `<section aria-labelledby="tf-cc-h"><h2 id="tf-cc-h">${glyph('globe')}Countries</h2><p class="rp-fine">People's requests by country, with the bots from there beside them.</p>${barList(countries.filter((x) => x.people > 0), (x) => esc(countryName(x.country)), (x) => x.people, (x) => (x.bots ? ` <span class="tf-muted">· ${fmt(x.bots)} bots</span>` : ''))}</section>` : '';
    return where + from;
}

const whoChip = (who) => `<span class="tf-who tf-c-${esc(who)}">${esc(WHO[who] || who)}</span>`;
function checked(b) {
    if (b.verified_no) return `<span class="tf-flag is-bad" title="Requests that say they are ${esc(b.agent)} but come from elsewhere">${exact(b.verified_no)} not really</span>`;
    if (b.verified_yes) return '<span class="tf-flag is-ok">Checked</span>';
    return '<span class="tf-muted">—</span>';
}
const problems = (r) => {
    const bad = (r.missing || 0) + (r.refused || 0) + (r.errors || 0);
    return bad ? `<span class="tf-muted">${share(bad, r.requests)} not answered</span>` : '';
};

function botsTable(bots, { sites = true } = {}) {
    if (!bots.length) return '<p class="rp-fine">No bots in this window.</p>';
    return `<div class="rp-table" role="table" aria-label="Bots"><div class="rp-tr rp-th" role="row"><span role="columnheader">Bot</span><span role="columnheader">Requests</span><span role="columnheader">${sites ? 'Sites' : 'Answered'}</span><span role="columnheader">Files for machines</span><span role="columnheader">Who it is</span></div>`
        + fold(bots.map((b) => `<div class="rp-tr" role="row"><span role="cell" class="rp-site"><a href="${esc(botHref(b.agent))}">${esc(b.agent || 'Unnamed')}</a><small>${whoChip(b.who)}</small></span>`
            + `<span role="cell" data-l="Requests">${exact(b.requests)} ${problems(b)}</span>`
            + `<span role="cell" data-l="${sites ? 'Sites' : 'Answered'}">${sites ? exact(b.sites) : share(b.ok, b.requests)}</span>`
            + `<span role="cell" data-l="Files for machines">${b.files != null ? exact(b.files) : '—'}</span>`
            + `<span role="cell" data-l="Who it is">${checked(b)}</span></div>`)) + '</div>';
}

const readerChips = (readers) => (readers || []).slice(0, 4).map((r) => `<a class="tf-chip" href="${esc(botHref(r.agent))}">${esc(r.agent || 'Unnamed')} <b>${fmt(r.requests)}</b></a>`).join('');

function overview({ data: d = null, days = 7 } = {}) {
    const head = `<header class="rp-page-h"><p class="rp-kicker">Open numbers</p><h1>Who visits OpenVibe</h1>
<p class="rp-lede">Every request any OpenVibe site answered, people and bots apart: search engines, AI crawlers, the assistants fetching for someone, link previews and the rest, with the files sites publish for machines (llms.txt, robots.txt, sitemaps, agent cards) on their own.</p>${tabs('/traffic', days)}</header>`;
    if (!d || !d.totals || !d.totals.total) {
        return layout({ title: 'Who visits OpenVibe', description: 'People and bots on every OpenVibe site.', active: '/traffic', path: '/traffic',
            body: `${head}<p class="rp-fine">Counting started on 28 November 2026; the numbers appear within a minute of the first requests.</p>` });
    }
    const t = d.totals;
    const files = d.files.length ? `<div class="rp-table" role="table" aria-label="Files for machines"><div class="rp-tr rp-th" role="row"><span role="columnheader">File</span><span role="columnheader">Requests</span><span role="columnheader">People</span><span role="columnheader">Read most by</span><span role="columnheader">Last read</span></div>`
        + fold(d.files.map((f) => `<div class="rp-tr" role="row"><span role="cell" class="rp-site"><code>${esc(f.path)}</code><small>on ${exact(f.sites)} ${f.sites === 1 ? 'site' : 'sites'}</small></span>`
            + `<span role="cell" data-l="Requests">${exact(f.requests)} ${problems(f)}</span><span role="cell" data-l="People">${exact(f.people)}</span>`
            + `<span role="cell" data-l="Read most by" class="tf-chips">${readerChips(f.readers) || '<span class="tf-muted">—</span>'}</span>`
            + `<span role="cell" data-l="Last read">${f.last_at ? whenTag(f.last_at) : '—'}</span></div>`)) + '</div>'
        : '<p class="rp-fine">No file for machines was asked for in this window.</p>';
    const sites = `<div class="rp-table" role="table" aria-label="Sites"><div class="rp-tr rp-th" role="row"><span role="columnheader">Site</span><span role="columnheader">Requests</span><span role="columnheader">People</span><span role="columnheader">Bots</span><span role="columnheader">AI</span></div>`
        + fold(d.sites.map((s) => `<div class="rp-tr" role="row"><span role="cell" class="rp-site"><a href="${esc(siteHref(s.host))}">${esc(s.host)}</a><small>${exact(s.people_pages)} pages opened by people</small></span>`
            + `<span role="cell" data-l="Requests">${exact(s.requests)}</span><span role="cell" data-l="People">${exact(s.people)}</span>`
            + `<span role="cell" data-l="Bots">${exact(s.bots)} <span class="tf-muted">${share(s.bots, s.requests)}</span></span><span role="cell" data-l="AI">${exact(s.ai)}</span></div>`)) + '</div>';
    const kinds = d.kinds.map((k) => `<li><b>${esc(KIND[k.kind] || k.kind)}</b> ${exact(k.requests)} <span class="tf-muted">(${share(k.people, k.requests)} people)</span></li>`).join('');
    const body = `${head}
${tilesOf(t, `${tile('Bots seen', exact(d.bots.length))}${tile('Files for machines', fmt(d.files.reduce((a, f) => a + f.requests, 0)), 'llms.txt, robots.txt, sitemaps …')}`)}
<section aria-labelledby="tf-day-h"><h2 id="tf-day-h">${glyph('chart')}People and bots ${d.hourly ? 'by the hour (UTC)' : 'a day'}</h2>${stacked(d.hourly || d.daily, t)}</section>
${arrivals(d)}
<section aria-labelledby="tf-bots-h"><h2 id="tf-bots-h">${glyph('robot')}Bots</h2><p class="rp-fine">Every bot and program that asked for something, most requests first. Search engines that publish how to check are checked: "not really" counts requests that use a crawler's name from somewhere else.</p>${botsTable(d.bots)}</section>
<section aria-labelledby="tf-files-h"><h2 id="tf-files-h">${glyph('file')}Files for machines</h2><p class="rp-fine">What sites publish for search engines and AI: llms.txt and llms-full.txt, robots.txt, sitemaps, agent cards, the OpenAPI documents and each page's Markdown twin.</p>${files}</section>
<section aria-labelledby="tf-sites-h"><h2 id="tf-sites-h">${glyph('globe')}Every site</h2>${sites}</section>
<section aria-labelledby="tf-how-h"><h2 id="tf-how-h">${glyph('info')}How this is counted</h2><ul class="tf-kinds">${kinds}</ul><p class="rp-fine">Counted on the server from every request the sites answered, so bots that never run a page's script are here too. A request is a person when a browser asks and nothing in it says bot; who a bot is comes from its user agent. Times are UTC. No address and no person is kept: a page is counted by its section ("/c/*"), and a link's code or a share token never is. The same numbers: <a href="/api/v1/traffic?days=${esc(days)}"><code>/api/v1/traffic</code></a>.</p></section>`;
    return layout({ title: 'Who visits OpenVibe', description: 'People and bots on every OpenVibe site: search engines, AI crawlers and assistants, link previews, and the files sites publish for machines.', body, active: '/traffic', path: `/traffic${days === 7 ? '' : `?days=${days}`}` });
}

function siteView({ data: d, days = 7 }) {
    const base = siteHref(d.host);
    const files = d.files.length ? `<ul class="tf-files">${d.files.map((f) => `<li><div class="tf-fh"><code>${esc(f.path)}</code><span>${exact(f.requests)} requests${f.people ? ` · ${exact(f.people)} people` : ''}${f.missing ? ` · <span class="tf-flag is-bad">${exact(f.missing)} not found</span>` : ''}${f.last_at ? ` · last ${whenTag(f.last_at)}` : ''}</span></div>`
        + `<div class="tf-chips">${f.readers.slice(0, 8).map((r) => `<a class="tf-chip" href="${esc(botHref(r.agent))}" title="${esc(r.last_at ? `last ${dayTime(r.last_at)}` : '')}">${esc(r.agent || 'Unnamed')} <b>${fmt(r.requests)}</b></a>`).join('') || '<span class="tf-muted">Only people</span>'}</div></li>`).join('')}</ul>`
        : '<p class="rp-fine">No file for machines was asked for on this site in this window.</p>';
    const pages = d.pages.length ? `<div class="rp-table" role="table" aria-label="Pages"><div class="rp-tr rp-th" role="row"><span role="columnheader">Section</span><span role="columnheader">People</span><span role="columnheader">Bots</span><span role="columnheader">Bot share</span><span role="columnheader">Not found</span></div>`
        + d.pages.map((p) => `<div class="rp-tr" role="row"><span role="cell" class="rp-site"><code>${esc(p.path)}</code></span><span role="cell" data-l="People">${exact(p.people)}</span><span role="cell" data-l="Bots">${exact(p.bots)}</span><span role="cell" data-l="Bot share">${share(p.bots, p.people + p.bots)}</span><span role="cell" data-l="Not found">${exact(p.missing)}</span></div>`).join('') + '</div>' : '';
    const body = `<header class="rp-page-h"><p class="rp-kicker"><a href="/traffic">Who visits OpenVibe</a></p><h1>${esc(d.host)}</h1>
<p class="rp-lede">People and bots on <a href="https://${esc(d.host)}">${esc(d.host)}</a>, and who reads its files for machines.</p>${tabs(base, days)}</header>
${tilesOf(d.totals)}
<section aria-labelledby="tf-day-h"><h2 id="tf-day-h">${glyph('chart')}People and bots ${d.hourly ? 'by the hour (UTC)' : 'a day'}</h2>${stacked(d.hourly || d.daily, d.totals)}</section>
<section aria-labelledby="tf-files-h"><h2 id="tf-files-h">${glyph('file')}Files for machines</h2>${files}</section>
${arrivals(d)}
<section aria-labelledby="tf-bots-h"><h2 id="tf-bots-h">${glyph('robot')}Bots on this site</h2>${botsTable(d.bots.map((b) => ({ ...b, files: null })), { sites: false })}</section>
${pages ? `<section aria-labelledby="tf-pages-h"><h2 id="tf-pages-h">${glyph('list')}Pages by section</h2>${pages}</section>` : ''}
<p class="rp-fine">The same numbers: <a href="/api/v1/traffic/sites/${esc(encodeURIComponent(d.host))}?days=${esc(days)}"><code>/api/v1/traffic/sites/${esc(d.host)}</code></a>.</p>`;
    return layout({ title: `${d.host}: people and bots`, description: `People and bots on ${d.host}, and who reads its llms.txt, robots.txt and sitemaps.`, body, active: '/traffic', path: `${base}${days === 7 ? '' : `?days=${days}`}` });
}

function botView({ data: d, days = 7 }) {
    const base = botHref(d.agent);
    const t = d.totals;
    const sites = `<div class="rp-table" role="table" aria-label="Sites"><div class="rp-tr rp-th" role="row"><span role="columnheader">Site</span><span role="columnheader">Requests</span><span role="columnheader">Answered</span><span role="columnheader">Not found</span><span role="columnheader">Last</span></div>`
        + fold(d.sites.map((s) => `<div class="rp-tr" role="row"><span role="cell" class="rp-site"><a href="${esc(siteHref(s.host))}">${esc(s.host)}</a></span><span role="cell" data-l="Requests">${exact(s.requests)}</span><span role="cell" data-l="Answered">${share(s.ok, s.requests)}</span><span role="cell" data-l="Not found">${exact(s.missing)}</span><span role="cell" data-l="Last">${s.last_at ? whenTag(s.last_at) : '—'}</span></div>`)) + '</div>';
    const reads = d.reads.length ? `<div class="rp-table" role="table" aria-label="What it reads"><div class="rp-tr rp-th" role="row"><span role="columnheader">What</span><span role="columnheader">Requests</span><span role="columnheader">Kind</span><span role="columnheader">Answered</span><span role="columnheader">Last</span></div>`
        + d.reads.map((r) => `<div class="rp-tr" role="row"><span role="cell" class="rp-site"><code>${esc(r.path || '—')}</code></span><span role="cell" data-l="Requests">${exact(r.requests)}</span><span role="cell" data-l="Kind">${esc(KIND[r.kind] || r.kind)}</span><span role="cell" data-l="Answered">${share(r.ok, r.requests)}</span><span role="cell" data-l="Last">${r.last_at ? whenTag(r.last_at) : '—'}</span></div>`).join('') + '</div>' : '';
    const verified = t.verified_no ? `${tile('Not really', exact(t.verified_no), `requests using the name from elsewhere`)}` : t.verified_yes ? tile('Checked', exact(t.verified_yes), 'from its own machines') : '';
    const body = `<header class="rp-page-h"><p class="rp-kicker"><a href="/traffic">Who visits OpenVibe</a></p><h1>${esc(d.agent)}</h1>
<p class="rp-lede">${whoChip(d.who)} ${esc(WHO_LINE[d.who] || '')}.</p>${tabs(base, days)}</header>
<section class="rp-tiles" aria-label="In this window">${tile('Requests', fmt(t.requests))}${tile('Sites', exact(t.sites))}${tile('Answered', share(t.ok, t.requests), t.missing ? `${exact(t.missing)} not found` : '')}${verified}</section>
<section aria-labelledby="tf-day-h"><h2 id="tf-day-h">${glyph('chart')}Requests a day</h2>${stacked(d.daily.map((x) => ({ day: x.day, [d.who]: x.requests })), { by_who: { [d.who]: t.requests } })}</section>
<section aria-labelledby="tf-sites-h"><h2 id="tf-sites-h">${glyph('globe')}Sites</h2>${sites}</section>
${reads ? `<section aria-labelledby="tf-reads-h"><h2 id="tf-reads-h">${glyph('file')}What it reads</h2>${reads}</section>` : ''}
<p class="rp-fine">The same numbers: <a href="/api/v1/traffic/bots/${esc(encodeURIComponent(d.agent))}?days=${esc(days)}"><code>/api/v1/traffic/bots/…</code></a>.</p>`;
    return layout({ title: `${d.agent} on OpenVibe`, description: `What ${d.agent} asks OpenVibe's sites for, and how often.`, body, active: '/traffic', path: `${base}${days === 7 ? '' : `?days=${days}`}` });
}

module.exports = { overview, siteView, botView, stacked };
