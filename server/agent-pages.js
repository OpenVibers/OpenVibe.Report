'use strict';
// The Markdown twins of openvibe.report's public pages (openvibe-shared/agent-layer). Each is rendered by the same
// data and view the route uses (createPublicPages in http/pages.js), so a twin cannot drift from its page; the mount
// sits after the page routes, so the pages themselves keep their own cache policy, and twinPath here is also what
// marks the pages that advertise a twin.
const { normaliseDays } = require('./data/source');

const twinPath = (path) => /^\/(?:|stats|developers|ai|ai\/[^/]+|ai\/models\/[^/]+)$/.test(String(path || '/'));

function createAgentPages({ publicPages, bench }) {
    async function renderPublicPage(path, { query } = {}) {
        let page = null;
        const model = /^\/ai\/models\/([^/]+)$/.exec(path);
        const kind = /^\/ai\/([^/]+)$/.exec(path);
        if (path === '/') page = await publicPages.home();
        else if (path === '/developers') page = publicPages.developers();
        else if (path === '/stats') page = await publicPages.stats(normaliseDays(query && query.get('days')));
        else if (path === '/ai') page = await publicPages.aiIndex();
        else if (model) page = await publicPages.aiModel(decodeURIComponent(model[1]));
        else if (kind) page = await publicPages.aiBoard(kind[1], bench.normaliseTab(query && query.get('tab')));
        return page ? { html: page.html } : null;
    }

    return { renderPublicPage };
}

module.exports = { createAgentPages, twinPath };
