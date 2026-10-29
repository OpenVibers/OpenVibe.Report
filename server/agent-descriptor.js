'use strict';
// What openvibe.report tells an agent about itself (openvibe-shared/agent-layer): /.well-known/agent.json.
// Every field is something this site really serves: its JSON API, its API page, and the crawl files it publishes.
// No OpenAPI document and no MCP endpoint exist for Report, so neither is named.
module.exports = {
    id: 'report',
    name: 'OpenVibe.Report',
    purpose: 'The network\'s open numbers: every OpenVibe site\'s stats, The Rundown of what streamers talked about, each stream\'s after-show report, and the AI benchmark boards.',
    home: 'https://openvibe.report',
    site: 'openvibe.report',
    api: '/api/v1',
    docs: '/developers',
    policy: {
        auth: ['none'],
        rateLimit: '120 API requests a minute per address',
    },
};
