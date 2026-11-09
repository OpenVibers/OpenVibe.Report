'use strict';
const { bare, findCatalogModel } = require('./ai-join');
// The first offer supplies the displayed prices: lowest known own-page output price,
// then input price. Unknown prices sort last; never turn null into a free price.
const amount = v => v == null || !Number.isFinite(Number(v)) ? Infinity : Number(v);
function mergeMarket(catalogue, market) {
    if (!market || !Array.isArray(market.offers)) return catalogue;
    const models = new Map();
    for (const offer of market.offers) {
        const key = bare(offer.model);
        const cat = findCatalogModel(catalogue?.models, offer.model);
        let model = models.get(key);
        if (!model) {
            model = { ...cat, slug: cat?.slug || offer.model, canonical: cat?.canonical || offer.model,
                name: offer.name, kind: offer.kind, maker: offer.maker, open_weights: offer.open_weights,
                context: offer.context, max_output: offer.max_output, licence: offer.licence,
                field_sources: offer.field_sources, routed: false, uncensored: false, offers: [] };
            models.set(key, model);
        }
        const measured = offer.routed && cat?.offers?.find(o => o.provider === offer.provider && bare(o.model) === bare(offer.provider_model));
        model.offers.push({ ...(measured || {}), ...offer, model: offer.provider_model, license: offer.licence,
            source: { name: 'Provider price page', url: offer.price_source, date: offer.price_checked_at, sample_size: measured?.requests_7d ?? null } });
        model.routed ||= offer.routed; model.uncensored ||= offer.uncensored;
    }
    // Routed models with no own-page pricebook entry still remain discoverable.
    for (const cat of catalogue?.models || []) if (!models.has(bare(cat.slug || cat.canonical))) {
        models.set(bare(cat.slug || cat.canonical), { ...cat, routed: true, offers: (cat.offers || []).map(o => ({ ...o, routed: true })) });
    }
    for (const model of models.values()) model.offers.sort((a,b) => amount(a.price?.out) - amount(b.price?.out) || amount(a.price?.in) - amount(b.price?.in));
    return { ...catalogue, generated_at: market.generated_at, metadata: market.metadata, stale: market.stale || false, models: [...models.values()] };
}
async function comparisonCatalogue(client) {
    if (!client) return null;
    const [catalogue, market] = await Promise.all([client.catalog(), client.market?.()]);
    return mergeMarket(catalogue, market);
}
module.exports = { mergeMarket, comparisonCatalogue };
