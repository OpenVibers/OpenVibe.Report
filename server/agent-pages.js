'use strict';
// The Markdown twins of openvibe.report's public pages (openvibe-shared/agent-layer). Each is rendered by the same
// data and view the route uses (createPublicPages in http/pages.js), so a twin cannot drift from its page; the mount
// sits after the page routes, so the pages themselves keep their own cache policy, and twinPath here is also what
// marks the pages that advertise a twin.
const { normaliseDays } = require('./data/source');

// /design and /rundown since 11-03: llms.txt listed them as HTML pages with no twin.
// The /ai pages moved to OpenVibe.Compare on 2026-11-13 (their twins with them).
const twinPath = (path) => /^\/(?:|stats|developers|design|rundown)$/.test(String(path || '/'));

function createAgentPages({ publicPages }) {
    async function renderPublicPage(path, { query } = {}) {
        let page = null;
        if (path === '/') page = await publicPages.home();
        else if (path === '/developers') page = publicPages.developers();
        else if (path === '/design') page = publicPages.design();
        else if (path === '/stats') page = await publicPages.stats(normaliseDays(query && query.get('days')));
        return page ? { html: page.html } : null;
    }

    return { renderPublicPage };
}

module.exports = { createAgentPages, twinPath };
