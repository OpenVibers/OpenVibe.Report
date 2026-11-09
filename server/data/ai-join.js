'use strict';

// Bench names a model as its maker's API does ("gpt-5-nano-2025-08-07"); the Exchange catalogue names it by
// maker and family ("openai/gpt-5-nano"). They are the same model when the names agree once the maker prefix
// and a date or channel suffix are dropped. Used by the AI pages and the AI API, so both join the same way.

const bare = (v) => String(v || '').toLowerCase()
    .replace(/^[^/]+\//, '')
    .replace(/[-_@:](\d{4}-?\d{2}-?\d{2}|latest|free)$/, '');

function findCatalogModel(models, id) {
    const list = Array.isArray(models) ? models : [];
    return list.find((m) => [m.slug, m.canonical, m.id].includes(id))
        || list.find((m) => [m.slug, m.canonical, m.name, ...(m.offers || []).map((o) => o.model)].some((v) => v && bare(v) === bare(id)))
        || null;
}

// The maker: the catalogue's own, else the prefix of the catalogue's name, else the prefix of Bench's name.
function makerOf(cat, id) {
    if (cat && cat.maker) return cat.maker;
    const named = String(cat && (cat.canonical || cat.slug) || id || '');
    return named.includes('/') ? named.split('/')[0] : null;
}

module.exports = { bare, findCatalogModel, makerOf };
