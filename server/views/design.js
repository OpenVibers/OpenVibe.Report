'use strict';
/**
 * openvibe.report/design: how closely every OpenVibe site follows the shared design kit (plan L45 step 6), read from
 * each site's code (server/design-health/scan.js, snapshot in server/design-health/snapshot.json).
 *
 *   designHealth(snapshot)      /design: the network at a glance, every site most-to-fix first, and how it is scored
 *   designSite(snapshot, site)  /design/:site: one site's counts and where, each finding linked to its line on GitHub
 */
const kit = require('openvibe-shared/kit');
const { layout } = require('./index');

const esc = kit.esc;
const exact = (v) => (v == null ? '—' : Number(v).toLocaleString('en-US'));
const day = (s) => { const t = Date.parse(s || ''); return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : ''; };
const IN_VIEW = 15;   // sites before the counted fold

// The rules in the order they matter, in words a reader knows.
const RULES = [
    ['spinner', 'Spinners', 'A keyframe that turns a whole circle, or an animation that runs one forever. Nothing on OpenVibe spins: a loading state breathes, bobs or fills.'],
    ['missing_reduced_motion', 'No reduced motion', 'A stylesheet that animates and never asks for prefers-reduced-motion, so a person who asked for less movement still gets it.'],
    ['literal_duration', 'Hand-set timings', 'A transition or animation time written by hand (.25s, 300ms) where the kit says var(--ov-dur-1…4), so a look\'s motion and Calm cannot change it.'],
    ['literal_curve', 'Hand-set curves', 'A cubic-bezier() or an ease keyword where the kit says var(--ov-ease-out), var(--ov-ease-spring) or var(--ov-ease-in-out).'],
    ['color_drift', 'Colours outside the theme', 'A colour written by hand in a file that already uses the theme\'s variables: it stays put when a person changes their look.'],
];
const LABEL = Object.fromEntries(RULES.map(([k, l]) => [k, l]));
const SHORT = { spinner: 'Spins', missing_reduced_motion: 'No reduced motion', literal_duration: 'Timing', literal_curve: 'Curve', color_drift: 'Colour' };
// A count in words, for a phone's one-line summary of a site ("931 timings 448 curves").
const WORDS = { spinner: 'spinning', missing_reduced_motion: 'without reduced motion', literal_duration: 'timings', literal_curve: 'curves', color_drift: 'colours' };

const band = (s) => (s >= 90 ? 'is-good' : s >= 60 ? 'is-ok' : 'is-low');
/** The score as a number on a bar: 0 to 100, coloured by band, with its words for a screen reader. */
const scoreBar = (s) => `<span class="dh-score ${band(Number(s))}" style="--dh:${Math.max(0, Math.min(100, Number(s) || 0))}%"><b>${esc(Number(s).toFixed(Number.isInteger(Number(s)) ? 0 : 1))}</b><i aria-hidden="true"></i></span>`;
const repoUrl = (s) => `https://github.com/OpenVibers/${encodeURIComponent(s.repo)}`;
const median = (xs) => { const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };

function siteRow(s) {
    const c = s.counts || {};
    return `<div class="rp-tr dh-tr" role="row"><span role="cell" class="rp-site"><a href="/design/${esc(s.slug)}">${esc(s.repo)}</a><small>${exact(s.files_scanned)} ${Number(s.files_scanned) === 1 ? 'file' : 'files'}</small></span>`
        + `<span role="cell" data-l="Score">${scoreBar(s.score)}</span>`
        + RULES.map(([k]) => `<span role="cell" data-l="${esc(LABEL[k])}" data-s="${esc(WORDS[k])}" class="dh-n${c[k] ? '' : ' is-zero'}${k === 'spinner' && c[k] ? ' is-bad' : ''}">${exact(c[k] || 0)}</span>`).join('')
        + (Number(c.total) ? '' : '<span role="cell" class="dh-none">Nothing to fix</span>')
        + '</div>';
}
const tableHead = `<div class="rp-tr rp-th dh-tr" role="row"><span role="columnheader">Site</span><span role="columnheader">Score</span>${RULES.map(([k]) => `<span role="columnheader">${esc(LABEL[k])}</span>`).join('')}</div>`;

function designHealth(snap) {
    const sites = (snap.sites || []).slice().sort((a, b) => a.score - b.score || a.repo.localeCompare(b.repo));
    const sum = (k) => sites.reduce((n, s) => n + (Number(s.counts && s.counts[k]) || 0), 0);
    const spins = sum('spinner'), still = sum('missing_reduced_motion');
    const clean = sites.filter((s) => Number(s.score) >= 100).length;
    const head = sites.slice(0, IN_VIEW), rest = sites.slice(IN_VIEW);
    const W = snap.weights || {};
    const body = `<header class="rp-page-h"><p class="rp-kicker">Open numbers</p><h1>Design health of every site</h1>
<p class="rp-lede">Read from each site's own code: motion through the kit's timings and curves, colours from the theme, a pause for people who ask for less movement, and nothing that spins. 100 is a site that follows the kit everywhere it was read.${snap.generated_at ? ` Measured ${esc(day(snap.generated_at))}, at each site's main branch.` : ''}</p></header>
<section class="rp-tiles" aria-label="Across the network">
<div class="rp-tile"><span class="rp-tile-l">Sites measured</span><b class="rp-tile-v">${exact(sites.length)}</b><span class="rp-tile-s">${exact(clean)} at 100</span></div>
<div class="rp-tile"><span class="rp-tile-l">Median score</span><b class="rp-tile-v">${median(sites.map((s) => Number(s.score))) == null ? '—' : esc(String(Math.round(median(sites.map((s) => Number(s.score))) * 10) / 10))}</b><span class="rp-tile-s">of 100</span></div>
<div class="rp-tile"><span class="rp-tile-l">Spinners</span><b class="rp-tile-v">${spins ? exact(spins) : 'None'}</b><span class="rp-tile-s">${spins ? 'still to replace' : 'nothing spins'}</span></div>
<div class="rp-tile"><span class="rp-tile-l">Files without reduced motion</span><b class="rp-tile-v">${still ? exact(still) : 'None'}</b><span class="rp-tile-s">${still ? 'animate for everyone' : 'every animation can stop'}</span></div>
</section>
<section aria-labelledby="dh-sites-h"><h2 id="dh-sites-h">Every site</h2><p class="rp-fine">Most to fix first. A site's page shows where, line by line.</p>
${sites.length ? `<div class="rp-table dh-table" role="table" aria-label="Design health, most to fix first">${tableHead}${head.map(siteRow).join('')}</div>
${rest.length ? `<details class="dh-fold"><summary>All ${exact(sites.length)} sites <span>${exact(rest.length)} more</span></summary><div class="rp-table dh-table" role="table" aria-label="Design health, the rest">${tableHead}${rest.map(siteRow).join('')}</div></details>` : ''}`
        : '<p class="rp-fine">No measurement yet.</p>'}
</section>
<section aria-labelledby="dh-how-h"><h2 id="dh-how-h">How it is measured</h2>
<dl class="dh-rules">${RULES.map(([k, l, what]) => `<div><dt>${esc(l)} <span>−${esc(String(W[k] != null ? W[k] : ''))} each</span></dt><dd>${esc(what)}</dd></div>`).join('')}</dl>
<p class="rp-fine">A site's score is 100 minus what its findings cost, never below 0. The rules read every stylesheet, and every &lt;style&gt; in a page or script, under a site's <code>public/</code> and <code>server/views/</code>; a site with none there is left out. The kit's own tokens and the fallback inside <code>var(--name, fallback)</code> never count. The rules are open: <a href="https://github.com/OpenVibers/OpenVibe.Report/blob/main/server/design-health/scan.js"><code>server/design-health/scan.js</code></a>, run by <code>scripts/design-health.js</code>. The same numbers: <a href="/api/v1/design-health"><code>/api/v1/design-health</code></a>.</p></section>`;
    return layout({
        title: 'Design health of every site',
        description: 'How closely each OpenVibe site follows the shared design kit: motion timings and curves, theme colours, reduced motion and nothing that spins, read from its code.',
        body, active: '/stats', path: '/design',
    });
}

function designSite(snap, s) {
    const c = s.counts || {};
    const commit = String(s.commit || '');
    const finds = (s.findings || []).map((f) => {
        const where = `${f.file}${f.line ? `:${f.line}` : ''}`;
        const href = commit ? `${repoUrl(s)}/blob/${encodeURIComponent(commit)}/${String(f.file).split('/').map(encodeURIComponent).join('/')}${f.line ? `#L${Number(f.line)}` : ''}` : '';
        return `<li class="dh-find"><span class="dh-rule dh-rule--${esc(String(f.rule).replace(/_/g, '-'))}">${esc(SHORT[f.rule] || f.rule)}</span>`
            + `${href ? `<a class="dh-where" href="${esc(href)}">${esc(where)}</a>` : `<span class="dh-where">${esc(where)}</span>`}`
            + `${f.text ? `<code class="dh-text">${esc(f.text)}</code>` : ''}</li>`;
    }).join('');
    const total = Number(s.findings_total) || 0;
    const body = `<header class="rp-page-h"><p class="rp-kicker"><a href="/design">Design health</a></p><h1>${esc(s.repo)}</h1>
<p class="rp-lede dh-lede">${scoreBar(s.score)} <span>${exact(s.files_scanned)} ${Number(s.files_scanned) === 1 ? 'file' : 'files'} read${commit ? ` at <a href="${esc(`${repoUrl(s)}/tree/${encodeURIComponent(commit)}`)}"><code>${esc(commit.slice(0, 7))}</code></a>` : ''}${snap.generated_at ? `, ${esc(day(snap.generated_at))}` : ''}.</span></p></header>
<section class="rp-tiles" aria-label="Findings by rule">${RULES.map(([k, l]) => `<div class="rp-tile"><span class="rp-tile-l">${esc(l)}</span><b class="rp-tile-v">${exact(c[k] || 0)}</b></div>`).join('')}</section>
<section aria-labelledby="dh-where-h"><h2 id="dh-where-h">Where</h2>
${total ? `<p class="rp-fine">${total > (s.findings || []).length ? `${exact((s.findings || []).length)} of ${exact(total)}: the ones that cost most, from as many files as possible.` : `All ${exact(total)}.`} Each opens its line on GitHub.</p><ol class="dh-finds">${finds}</ol>`
        : '<p class="rp-fine">Nothing to fix: this site follows the kit everywhere the rules read.</p>'}
</section>
<p class="rp-fine"><a href="/design">Every site</a> · <a href="/design#dh-how-h">How it is measured</a> · <a href="/api/v1/design-health/${esc(s.slug)}"><code>/api/v1/design-health/${esc(s.slug)}</code></a></p>`;
    return layout({
        title: `${s.repo}: design health`,
        description: `How closely ${s.repo} follows the shared design kit: score ${s.score} of 100, with every finding by rule and line.`,
        body, active: '/stats', path: `/design/${s.slug}`,
    });
}

module.exports = { designHealth, designSite, scoreBar };
