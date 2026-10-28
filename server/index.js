'use strict';

/**
 * OpenVibe.Report — process entry. `node server/index.js`
 * Listens on PORT (5080) behind nginx (deploy/).
 */
const { createApp } = require('./app');
const { gracefulStop } = require('openvibe-sdk/service');

/**
 * The process stop (openvibe-sdk/service): the HTTP drain runs, then anything the product added closes. Report
 * has no database, no key refresher and no subscriptions, so there is nothing else to close. Exported so a test can
 * inject `exit` and `signals: false`.
 */
function createLifecycle({ server, exit, signals } = {}) {
    return gracefulStop({
        name: 'OpenVibe.Report',
        server,
        deadlineExitCode: 0,
        exit,
        signals,
        deadlineMs: 10_000,
    });
}

async function start() {
    const { app, ctx } = await createApp();
    const { config } = ctx;

    const server = app.listen(config.port, config.host, () => {
        console.log(`[OpenVibe.Report] ${config.nodeEnv} on http://${config.host}:${config.port} → ${config.baseUrl} (network ${config.networkUrl}, live ${config.liveUrl})`);
    });
    server.keepAliveTimeout = 65_000;
    createLifecycle({ server, ctx });
    return { server, ctx };
}

if (require.main === module) {
    start().catch((err) => {
        console.error('[OpenVibe.Report] failed to start:', err);
        process.exit(1);
    });
}

module.exports = { start, createLifecycle };
