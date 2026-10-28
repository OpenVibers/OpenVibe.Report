'use strict';

/**
 * OpenVibe.Report — process entry. `node server/index.js`
 * Listens on PORT (5080) behind nginx (deploy/).
 */
const { createApp } = require('./app');
const { createAnalyticsJobs } = require('./jobs/analytics');
const { gracefulStop } = require('openvibe-sdk/service');

/**
 * The process stop (openvibe-sdk/service): the HTTP drain runs, then the jobs stop and the database closes.
 * Exported so a test can inject `exit` and `signals: false`.
 */
function createLifecycle({ server, exit, signals, ctx } = {}) {
    const jobs = ctx && ctx.jobs;
    const store = ctx && ctx.store;
    return gracefulStop({
        name: 'OpenVibe.Report',
        server,
        deadlineExitCode: 0,
        exit,
        signals,
        deadlineMs: 10_000,
        stop: [() => (jobs ? jobs.stop() : undefined)],
        close: [() => (store ? store.close() : undefined)],
    });
}

async function start() {
    const { app, ctx } = await createApp();
    const { config } = ctx;

    const jobs = createAnalyticsJobs({ config, analytics: ctx.analytics, shadow: ctx.shadow, log: ctx.log });
    ctx.jobs = jobs;
    jobs.start();

    const server = app.listen(config.port, config.host, () => {
        console.log(`[OpenVibe.Report] ${config.nodeEnv} on http://${config.host}:${config.port} → ${config.baseUrl} (source ${config.source}; network ${config.networkUrl}, live ${config.liveUrl}, billing ${config.billing.url})`);
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
