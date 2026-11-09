'use strict';

// Report's AI comparison pages: the hub, the full leaderboard, providers, a model and a comparison.
// One way to show each thing everywhere:
//  - a model is its maker's mark, a readable name and its tags;
//  - a rating is the number with its spread and the votes it rests on, or "Not rated yet";
//  - a price is the cheapest provider's own-page price;
//  - speed and uptime are measured on the Exchange's real traffic, shown only where traffic went.
// A column or section earns its place: it shows when some row has a value, and a missing value reads in words.
const kit = require('openvibe-shared/kit');
const marks = require('openvibe-shared/ai-marks');
const { asset } = require('../assets');
const { layout } = require('./index');

const esc = kit.esc;
const value = (x) => x == null || !Number.isFinite(Number(x)) ? null : Number(x);
const idPath = (id) => `/ai/models/${encodeURIComponent(id || '')}`;
const act = (href, label) => kit.button({ href, label, kind: 'quiet', icon: 'forward' });
const quiet = (text) => `<span class="ai-quiet">${esc(text)}</span>`;
const money = (x) => value(x) == null ? null : kit.num(x, 'money');
const ms = (x) => value(x) == null ? null : kit.num(x, 'ms');
const share = (x) => { const v = x != null && typeof x === 'object' ? x.value : x; return value(v) == null ? null : `${(Number(v) * 100).toFixed(Number(v) > 0 && Number(v) < 0.01 ? 2 : 1)}%`; };
const sourceHint = (s) => { const x = s && typeof s === 'object' ? s : { name: s }; return `Source: ${x.name || 'not listed'}${x.date ? ` · ${String(x.date).slice(0, 10)}` : ''}${x.sample_size != null ? ` · n = ${x.sample_size}` : ''}`; };

// ── A model ──
function makerName(row) {
    const key = marks.family(row && row.maker) || marks.family(row && row.id);
    return key ? marks.NAMES[key] : (row && row.maker) || null;
}
// "openai/gpt-5-nano" reads as "gpt-5-nano" beside OpenAI's mark; the full id stays in the link and the title.
const shortName = (id) => String(id || '').replace(/^[^/]+\//, '') || String(id || '');
function tags(row) {
    const t = [];
    if (row.weights === 'open' || row.weights === 'open_weights') t.push(kit.badge('Open weights'));
    if (row.uncensored) t.push(kit.badge('18+', 'warn'));
    if (row.community) t.push(kit.badge('Community machines'));
    return t.join('');
}
function modelCell(row, { size = 28 } = {}) {
    const maker = makerName(row);
    return `<a class="ai-model" href="${idPath(row.id)}" title="${esc(row.id)}">${marks.mark(row.maker || row.id, { size, label: false })}`
        + `<span class="ai-model-text"><b>${esc(shortName(row.id))}</b><small>${esc(maker || 'Maker not listed')}${tags(row) ? ` ${tags(row)}` : ''}</small></span></a>`;
}

// ── Numbers on a model ──
const rated = (row) => row && row.rating && value(row.rating.value) != null;
function ratingCell(row, { range = false } = {}) {
    if (!rated(row)) return quiet('Not rated yet');
    const v = Math.round(Number(row.rating.value));
    const [lo, hi] = (row.rating.interval || []).map(value);
    const n = value(row.rating.sample_size);
    const spread = lo != null && hi != null ? (range ? `${Math.round(lo)}–${Math.round(hi)}` : `± ${Math.round((hi - lo) / 2)}`) : '';
    const votes = n != null ? `${n.toLocaleString('en-US')} ${n === 1 ? 'game' : 'games'}` : '';
    return `<span class="ai-rating" title="${esc(sourceHint(row.rating))}"><b>${v}</b>${spread || votes ? `<small>${esc([spread, votes].filter(Boolean).join(' · '))}</small>` : ''}</span>`;
}
const rankText = (row, i) => row.rank && row.rank.min != null ? (row.rank.min === row.rank.max ? String(row.rank.min) : `${row.rank.min}–${row.rank.max}`) : (rated(row) ? String(i + 1) : '–');
const offersOf = (row) => (row && row.provider_offers || []).filter(Boolean);
const measured = (o) => Number(o.requests_7d) > 0;
function cheapest(row) {
    const priced = offersOf(row).filter((o) => o.price && value(o.price.out) != null);
    return priced.sort((a, b) => Number(a.price.out) - Number(b.price.out))[0] || null;
}
function fastest(row) {
    const timed = offersOf(row).filter((o) => measured(o) && o.speed && value(o.speed.p50_ms) != null);
    return timed.sort((a, b) => Number(a.speed.p50_ms) - Number(b.speed.p50_ms))[0] || null;
}
function priceCell(row) {
    const o = cheapest(row);
    if (!o) return quiet('No price listed');
    const n = offersOf(row).filter((x) => x.price && value(x.price.out) != null).length;
    const via = n > 1 ? `cheapest of ${n} providers` : `via ${providerName(o)}`;
    return `<span class="ai-price" title="${esc(sourceHint(o.source || { name: o.provider_name }))}"><b>${esc(money(o.price.out))}</b> out · ${esc(money(o.price.in) || '–')} in<small>per 1M tokens, ${esc(via)}</small></span>`;
}
function speedCell(row) {
    const o = fastest(row);
    if (!o) return quiet('No traffic yet');
    return `<span title="${esc(sourceHint({ name: 'OpenVibe.AI, real traffic', sample_size: o.requests_7d }))}"><b>${esc(ms(o.speed.p50_ms))}</b><small>typical reply · p95 ${esc(ms(o.speed.p95_ms) || '–')}</small></span>`;
}
function uptimeCell(row) {
    const o = fastest(row) || offersOf(row).find(measured);
    if (!o || share(o.uptime) == null) return quiet('No traffic yet');
    return `<b${Number(o.uptime) < 0.95 ? ' class="ai-bad"' : ''}>${esc(share(o.uptime))}</b><small>${esc(Number(o.requests_7d).toLocaleString('en-US'))} requests in 7 days</small>`;
}

// ── The leaderboard table ──
function board(rows, { full = false } = {}) {
    const has = (fn) => rows.some(fn);
    const columns = [
        has(rated) && { key: 'rank', label: 'Rank', num: true, html: true },
        { key: 'model', label: 'Model', primary: true, html: true },
        has(rated) && { key: 'rating', label: 'Rating', html: true },
        has((r) => cheapest(r)) && { key: 'price', label: 'Price', html: true },
        has((r) => fastest(r)) && { key: 'speed', label: 'Reply time', html: true },
        full && has((r) => offersOf(r).some((o) => measured(o) && share(o.uptime) != null)) && { key: 'uptime', label: 'Uptime 7 d', html: true },
        full && has((r) => r.benchmark && value(r.benchmark.value) != null) && { key: 'bench', label: 'Bench score', html: true },
    ].filter(Boolean);
    const data = rows.map((r, i) => ({
        rank: `<span class="ai-rank${rated(r) && i < 3 ? ' is-top' : ''}">${esc(rankText(r, i))}</span>`,
        model: modelCell(r),
        rating: ratingCell(r),
        price: priceCell(r),
        speed: speedCell(r),
        uptime: uptimeCell(r),
        bench: r.benchmark && value(r.benchmark.value) != null ? `<b>${esc(kit.num(r.benchmark.value))}</b>` : quiet('No runs yet'),
    }));
    const none = rows.length && !has(rated) ? `<p class="ai-note">No model has blind votes or runs yet, so nothing is ranked: these are the models with their prices and measured speed. <a href="https://openvibe.exchange/arena">Vote in the Arena</a> to rate them.</p>` : '';
    const wrapped = data.map((d) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, k === 'model' ? v : `<span class="ai-cell">${v}</span>`])));
    return none + kit.table({ columns, rows: wrapped, label: 'AI models', empty: 'No model matches these filters.' }).replace('class="ovk-table"', 'class="ovk-table ai-board"');
}

function page(title, description, body, path) {
    return layout({ title, description, body: `<link rel="stylesheet" href="${asset('css/ai-comparison.css')}"><style>${marks.CSS}</style><div class="ai-page">${body}</div>`, active: '/ai', path });
}
const dataLinks = () => `<p class="ai-data">Data: <a href="/api/v1/ai/leaderboard">JSON</a> · <a href="/api/v1/ai/leaderboard?format=csv&amp;limit=100">CSV</a> · <a href="/ai/method">How it is measured</a></p>`;

// ── /ai ──
const PICK_LABELS = { overall: 'Best overall', value: 'Best value', fastest: 'Fastest', open: 'Best open weights', code: 'Best for code', writing: 'Best for writing', uncensored: 'Best uncensored 18+', free: 'Best free' };
function pickNumber(id, row) {
    if (id === 'value' || id === 'free') { const o = cheapest(row); return o ? `${money(o.price.out)} per 1M out` : ''; }
    if (id === 'fastest') { const o = fastest(row); return o ? `${ms(o.speed.p50_ms)} typical reply` : ''; }
    return rated(row) ? `Rating ${Math.round(row.rating.value)}` : '';
}
function hub({ rows = [], picks = [], providers = [], others = 0, month = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }), changed = [], tasks = [], arena = null } = {}) {
    const ratedRows = rows.filter(rated);
    const providerNames = new Set(providers.map(providerName).filter(Boolean));
    const measuredOffers = providers.filter(measured);
    const made = picks.filter((p) => p.model);
    const pending = picks.filter((p) => !p.model).map((p) => PICK_LABELS[p.id] || p.id);
    const pickList = made.map((p) => `<li><a class="ai-pick" href="${idPath(p.model.id)}"><span class="ai-pick-k">${esc(PICK_LABELS[p.id] || p.id)}</span>`
        + `<span class="ai-pick-m">${marks.mark(p.model.maker || p.model.id, { size: 32, label: false })}<b>${esc(shortName(p.model.id))}</b></span>`
        + `${pickNumber(p.id, p.model) ? `<span class="ai-pick-n">${esc(pickNumber(p.id, p.model))}</span>` : ''}<small>${esc(p.why || '')}</small></a></li>`).join('');
    const pairs = ratedRows.slice(0, 16).reduce((a, r, i, all) => { if (i % 2 === 0 && all[i + 1]) a.push([r, all[i + 1]]); return a; }, []).slice(0, 8);
    const sourceDate = rows.map((r) => r.source && r.source.date).find(Boolean) || 'date not reported by source';
    const faq = [
        ['How are ratings made?', `${ratedRows.length} models have a rating from blind pairwise votes and open runs on OpenVibe.Bench (Bradley-Terry with bootstrap intervals), dated ${sourceDate}.`],
        ['Where do prices come from?', `Each provider's own price page, read by OpenVibe.AI's pricebook; ${providers.length} provider and model offers are listed.`],
        ['What does the rank band mean?', 'Models whose rating intervals overlap share a band: the data cannot tell them apart yet.'],
        ['Why does a model say "Not rated yet"?', 'No blind votes or runs on it so far. Its prices and measured speed are still listed.'],
        ['How is speed measured?', `On real requests through OpenVibe.Exchange over seven days: ${measuredOffers.length} provider endpoints had traffic.`],
        ['How often does this change?', 'Ratings and prices refresh within two minutes of the sources changing.'],
    ];
    const body = `<header class="ai-head"><p class="ai-kicker">AI comparison · ${esc(month)}</p><h1>AI model leaderboard — ${esc(month)}</h1>`
        + `<p class="ai-lede">${rows.length} models from ${providerNames.size} providers. Ratings come from blind votes, prices from each provider's own page, and speed and uptime from real traffic.</p>`
        + kit.find({ action: '/ai/leaderboard', placeholder: 'Search a model or maker', label: 'Search models' })
        + kit.stats([[ratedRows.length, 'rated'], [rows.length, 'models listed'], [providerNames.size, 'providers'], [measuredOffers.length, 'measured endpoints']], { label: 'The leaderboard in numbers' })
        + `</header>`
        + (pickList || pending.length ? kit.section({ title: 'Top picks', body: `${pickList ? `<ul class="ai-picks">${pickList}</ul>` : ''}${pending.length ? `<p class="ai-fine">Not enough data yet for ${esc(pending.join(', '))}.</p>` : ''}` }) : '')
        + kit.section({ title: 'Leaderboard', count: rows.length, actions: [act('/ai/leaderboard', rows.length > 25 ? `All ${rows.length} models` : 'Filter and sort')], body: board(rows.slice(0, 25)) + (others ? `<p class="ai-fine">Chat models only. ${others} embedding and speech ${others === 1 ? 'model is' : 'models are'} in the <a href="/ai/leaderboard?type=all">full list</a>.</p>` : '') + dataLinks() })
        + (arena && (arena.answers || []).length ? kit.section({ title: 'One prompt, many answers', body: `<p class="ai-prompt">${esc(arena.prompt || '')}</p><div class="ai-answers">${arena.answers.slice(0, 3).map((a) => `<article>${modelCell({ id: a.model || 'Model', maker: a.maker })}<p>${esc(a.text || '')}</p></article>`).join('')}</div>` }) : '')
        + (tasks.length ? kit.section({ title: 'Boards by task', body: `<ul class="ai-chips">${tasks.slice(0, 16).map((x) => `<li><a href="/ai/${encodeURIComponent(x.id)}">${esc(x.name || x.id)}</a></li>`).join('')}</ul>` }) : '')
        + (measuredOffers.length ? kit.section({ title: 'Providers', actions: [act('/ai/providers', 'Every provider')], body: providerTable(measuredOffers.slice(0, 6)) }) : '')
        + (pairs.length ? kit.section({ title: 'Popular comparisons', body: `<ul class="ai-chips">${pairs.map(([a, b]) => `<li><a href="/ai/compare/${encodeURIComponent(a.id)}-vs-${encodeURIComponent(b.id)}">${esc(shortName(a.id))} vs ${esc(shortName(b.id))}</a></li>`).join('')}</ul>` }) : '')
        + (changed.length ? kit.section({ title: 'What changed this month', body: `<ul>${changed.slice(0, 8).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` }) : '')
        + kit.section({ title: 'Questions', body: faq.map(([q, a]) => kit.fold({ title: q, body: `<p>${esc(a)}</p>` })).join('') })
        + `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faq.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) }).replace(/</g, '\\u003c')}</script>`
        + `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Dataset', name: 'OpenVibe AI model leaderboard', url: 'https://openvibe.report/ai', variableMeasured: ['Bench rating', 'Provider price', 'Provider reply time', 'Provider uptime'], distribution: { '@type': 'DataDownload', contentUrl: 'https://openvibe.report/api/v1/ai/leaderboard', encodingFormat: 'application/json' } }).replace(/</g, '\\u003c')}</script>`;
    return page(`AI model leaderboard — ${month}`, `${rows.length} AI models compared: ratings from blind votes, provider prices and measured speed.`, body, '/ai');
}

// ── /ai/leaderboard ──
function leaderboard({ rows = [], filters = {} } = {}) {
    const select = (name, label, opts) => `<label class="ai-filter"><span>${esc(label)}</span><select name="${name}">${opts.map(([v, t]) => `<option value="${esc(v)}"${String(filters[name] || '') === v ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
    const text = (name, label, placeholder) => `<label class="ai-filter"><span>${esc(label)}</span><input name="${name}" value="${esc(filters[name] || '')}" placeholder="${esc(placeholder)}"></label>`;
    const form = `<form class="ai-filters" action="/ai/leaderboard">`
        + `<label class="ai-filter ai-filter--q"><span>Search</span><input name="q" type="search" value="${esc(filters.q || '')}" placeholder="Model or maker"></label>`
        + select('type', 'Type', [['chat', 'Chat models'], ['embedding', 'Embeddings'], ['stt', 'Speech to text'], ['all', 'All']])
        + select('sort', 'Sort by', [['rating', 'Rating'], ['price', 'Output price'], ['speed', 'Reply time'], ['name', 'Name']])
        + select('weights', 'Weights', [['', 'Any'], ['open', 'Open weights'], ['closed', 'Closed']])
        + select('price', 'Price', [['', 'Any price'], ['free', 'Free'], ['low', 'Low'], ['mid', 'Mid'], ['high', 'High']])
        + text('maker', 'Maker', 'e.g. openai')
        + text('kind', 'Task', 'e.g. design.page')
        + select('status', 'Status', [['current', 'Current'], ['all', 'All']])
        + select('uncensored', '18+', [['', 'Any'], ['true', 'Uncensored only']])
        + select('community', 'Runs on', [['', 'Anywhere'], ['true', 'Community machines']])
        + `<button class="ovk-btn ovk-btn--primary">Apply</button></form>`;
    const body = `<header class="ai-head ai-head--page"><p class="ai-kicker"><a href="/ai">AI comparison</a></p><h1>AI model leaderboard</h1>`
        + `<p class="ai-lede">${rows.length} ${rows.length === 1 ? 'model' : 'models'}${rows.filter(rated).length ? `, ${rows.filter(rated).length} rated` : ''}. Rated models first, then the rest with their prices.</p></header>`
        + form + board(rows, { full: true }) + dataLinks();
    return page('AI model leaderboard', 'Every AI model with its rating, provider prices and measured speed; filter and sort.', body, '/ai/leaderboard');
}

// ── /ai/providers ──
const ownServer = (p) => /^(local|whisper)$/i.test(String(p.provider || '')) || /on this host|\blocal\b/i.test(String(p.provider_name || ''));
const providerName = (p) => ownServer(p) ? 'OpenVibe server' : (p.provider_name || p.provider || 'Provider');
const providerMark = (p) => ownServer(p) ? marks.mark('openvibe', { size: 24, label: false }) : marks.mark(p.provider || p.provider_name, { size: 24, label: false });
function providerTable(list) {
    const rows = list.map((p) => ({
        provider: `<span class="ai-prov">${providerMark(p)}<b>${esc(providerName(p))}</b></span>`,
        model: `<a href="${idPath(p.model)}">${esc(shortName(p.model))}</a>`,
        price: p.price && value(p.price.out) != null ? `<b>${esc(money(p.price.out))}</b> out · ${esc(money(p.price.in) || '–')} in` : quiet('No price listed'),
        reply: measured(p) && p.speed && value(p.speed.p50_ms) != null ? `<b>${esc(ms(p.speed.p50_ms))}</b><small>p95 ${esc(ms(p.speed.p95_ms) || '–')}</small>` : quiet('No traffic yet'),
        errors: measured(p) && share(p.error_rate) != null ? `<b class="${Number(typeof p.error_rate === 'object' ? p.error_rate.value : p.error_rate) > 0.05 ? 'ai-bad' : ''}">${esc(share(p.error_rate))}</b>` : quiet('–'),
        uptime: measured(p) && share(p.uptime) != null ? `<b class="${Number(p.uptime) < 0.95 ? 'ai-bad' : ''}">${esc(share(p.uptime))}</b>` : quiet('–'),
        requests: measured(p) ? Number(p.requests_7d).toLocaleString('en-US') : quiet('0'),
    }));
    return kit.table({
        columns: [
            { key: 'provider', label: 'Provider', primary: true, html: true },
            { key: 'model', label: 'Model', html: true },
            { key: 'price', label: 'Price per 1M', html: true },
            { key: 'reply', label: 'Reply time', html: true },
            { key: 'errors', label: 'Errors', html: true },
            { key: 'uptime', label: 'Uptime 7 d', html: true },
            { key: 'requests', label: 'Requests 7 d', html: true },
        ],
        rows: rows.map((d) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, k === 'provider' ? v : `<span class="ai-cell">${v}</span>`]))), label: 'Providers', empty: 'No provider is listed yet.',
    });
}
function providers({ providers: list = [] } = {}) {
    const sorted = [...list].sort((a, b) => (Number(b.requests_7d) || 0) - (Number(a.requests_7d) || 0));
    const body = `<header class="ai-head ai-head--page"><p class="ai-kicker"><a href="/ai">AI comparison</a></p><h1>AI providers</h1>`
        + `<p class="ai-lede">Every provider and model the Exchange lists. Prices come from each provider's own page. Reply time, errors and uptime are measured on real requests over the last seven days; a provider with no traffic yet has no measurement.</p></header>`
        + providerTable(sorted);
    return page('AI providers', 'AI providers compared: price per million tokens, reply time, error rate and uptime measured on real traffic.', body, '/ai/providers');
}

// ── /ai/models/:id ──
function model({ id, detail = {}, row = null, providers: list = [], sourceDate = null } = {}) {
    detail = detail || {};
    const self = row || { id, provider_offers: list.filter((p) => p.model === id) };
    const offers = offersOf(self).length ? offersOf(self) : list.filter((p) => p.model === id);
    const tasks = (self.task_ratings || []).filter((t) => t.rating && value(t.rating.value) != null);
    const maker = makerName(self);
    const facts = kit.stats([
        [rated(self) ? Math.round(self.rating.value) : 'Not rated yet', 'rating'],
        [cheapest({ provider_offers: offers }) ? money(cheapest({ provider_offers: offers }).price.out) : null, 'cheapest output / 1M'],
        [fastest({ provider_offers: offers }) ? ms(fastest({ provider_offers: offers }).speed.p50_ms) : null, 'typical reply'],
        [offers.length || null, offers.length === 1 ? 'provider' : 'providers'],
    ], { label: `${id} in numbers` });
    const taskTable = tasks.length ? kit.table({
        columns: [{ key: 'task', label: 'Task', primary: true, html: true }, { key: 'rank', label: 'Rank' }, { key: 'rating', label: 'Rating', html: true }],
        rows: tasks.map((t) => ({ task: `<a href="/ai/${encodeURIComponent(t.kind)}">${esc(t.kind)}</a>`, rank: t.rank ? (t.rank.min === t.rank.max ? String(t.rank.min) : `${t.rank.min}–${t.rank.max}`) : 'Not enough data', rating: ratingCell({ rating: t.rating }, { range: true }) })),
        label: 'Task ratings',
    }) : `<p class="ai-fine">Not rated on any task yet: no blind votes or runs on this model so far.</p>`;
    const benchmarks = (detail.benchmarks || []).length ? kit.table({
        columns: [{ key: 'name', label: 'Benchmark', primary: true }, { key: 'score', label: 'Score' }, { key: 'runs', label: 'Runs' }, { key: 'last', label: 'Last run' }],
        rows: detail.benchmarks.map((b) => ({ name: b.title || b.benchmark_id, score: b.score == null ? 'Not measured' : String(b.score), runs: b.runs == null ? 'Not reported' : String(b.runs), last: b.last_run ? String(b.last_run).slice(0, 10) : '–' })),
        label: 'Benchmarks', caption: `OpenVibe.Bench${sourceDate ? ` · snapshot ${String(sourceDate).slice(0, 10)}` : ''}`,
    }) : '';
    const body = `<header class="ai-head ai-head--model"><p class="ai-kicker"><a href="/ai">AI comparison</a></p>`
        + `<div class="ai-model-head">${marks.mark(self.maker || id, { size: 56 })}<div><h1>${esc(shortName(id))}</h1><p class="ai-lede">${esc(maker || 'Maker not listed')}${tags(self) ? ` ${tags(self)}` : ''} · <code>${esc(id)}</code></p></div></div>`
        + facts + `</header>`
        + kit.section({ title: 'Providers', count: offers.length, body: providerTable(offers) })
        + kit.section({ title: 'Task ratings', count: tasks.length || null, body: taskTable + benchmarks })
        + `<aside class="ai-try"><a class="ovk-btn ovk-btn--primary" href="https://openvibe.chat/vibe?models=${encodeURIComponent(id)}">Try it in Chat</a><a class="ovk-btn ovk-btn--quiet" href="https://openvibe.exchange/models/${encodeURIComponent(id)}">Use it from code</a></aside>`
        + `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Product', name: id, brand: maker || 'Unknown maker' }).replace(/</g, '\\u003c')}</script>`;
    return page(`${shortName(id)} — AI model`, `${id}: rating, prices across providers and measured speed.`, body, idPath(id));
}

// ── /ai/compare ──
function compare({ models = [], options = [] } = {}) {
    const two = models.length === 2;
    const facts = (m) => [
        ['Rating', ratingCell(m, { range: true })],
        ['Price', priceCell(m)],
        ['Reply time', speedCell(m)],
        ['Providers', offersOf(m).length ? String(offersOf(m).length) : quiet('None listed')],
    ];
    const cards = models.map((m) => `<article class="ai-vs-card">${modelCell(m, { size: 40 })}<dl>${facts(m).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl></article>`).join('');
    const list = `<datalist id="ai-models">${options.slice(0, 500).map((o) => `<option value="${esc(o)}"></option>`).join('')}</datalist>`;
    const form = `<form class="ai-filters ai-vs-form" action="/ai/compare"><label class="ai-filter"><span>First model</span><input name="a" list="ai-models" value="${esc(models[0] && models[0].id || '')}" required></label>`
        + `<label class="ai-filter"><span>Second model</span><input name="b" list="ai-models" value="${esc(models[1] && models[1].id || '')}" required></label><button class="ovk-btn ovk-btn--primary">Compare</button>${list}</form>`;
    const body = `<header class="ai-head ai-head--page"><p class="ai-kicker"><a href="/ai">AI comparison</a></p><h1>${two ? `${esc(shortName(models[0].id))} vs ${esc(shortName(models[1].id))}` : 'Compare AI models'}</h1>`
        + `${two ? '' : '<p class="ai-lede">Choose two models to compare: their ratings, prices and measured speed side by side.</p>'}</header>`
        + (cards ? `<div class="ai-vs">${cards}</div>` : '') + form;
    return page(two ? `${shortName(models[0].id)} vs ${shortName(models[1].id)}` : 'Compare AI models', 'Compare AI models side by side: ratings, prices and measured speed.', body, '/ai/compare');
}

function arena() {
    return page('AI Arena', 'Compare anonymous AI answers and vote.', `<header class="ai-head ai-head--page"><p class="ai-kicker"><a href="/ai">AI comparison</a></p><h1>AI Arena</h1><p class="ai-lede">Two anonymous answers to one prompt; you pick the better one, then see which models wrote them. Every vote moves the ratings here.</p></header><p><a class="ovk-btn ovk-btn--primary" href="https://openvibe.exchange/arena">Vote in the Arena</a></p>`, '/ai/arena');
}

module.exports = { hub, leaderboard, providers, model, compare, arena };
