'use strict';
/**
 * Every site's design health (plan L45 step 6): the snapshot scripts/design-health.js writes to server/design-health/snapshot.json
 * from each site's code at its main branch. Read once and kept; a refresh is a new snapshot in a PR.
 *
 *   all()        → { generated_at, rules, weights, kept, sites: [...] } (sites with a stylesheet to read only)
 *   site(slug)   → one site by its short name ('live', 'tools', 'openrestream'), or null
 *   slugOf(repo) → 'OpenVibe.Live' → 'live'
 */
const fs = require('fs');
const path = require('path');

// DESIGN_HEALTH_FILE: another snapshot (the tests' fixture).
const FILE = process.env.DESIGN_HEALTH_FILE || path.join(__dirname, '..', 'design-health', 'snapshot.json');
const slugOf = (repo) => String(repo || '').replace(/^OpenVibe\./, '').toLowerCase();
let cached = null;

function all() {
    if (cached) return cached;
    let snap = null;
    try { snap = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { snap = null; }
    const sites = (snap && Array.isArray(snap.sites) ? snap.sites : [])
        // A repo with no stylesheet where the rules read (a library, a service with no pages) is not a site to score.
        .filter((s) => s && s.counts && Number(s.files_scanned) > 0)
        .map((s) => ({ ...s, slug: slugOf(s.repo) }));
    cached = { generated_at: snap ? snap.generated_at : null, rules: snap ? snap.rules : [], weights: snap ? snap.weights : {}, kept: snap ? snap.kept : 0, sites };
    return cached;
}

function site(slug) {
    const s = String(slug || '').toLowerCase();
    if (!/^[a-z0-9-]{2,40}$/.test(s)) return null;
    return all().sites.find((x) => x.slug === s) || null;
}

module.exports = { all, site, slugOf, _reset: () => { cached = null; } };
