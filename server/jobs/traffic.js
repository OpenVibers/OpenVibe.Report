'use strict';
/**
 * The traffic job (plan AD.40): every minute, what is new in the host's nginx log of every request
 * (server/traffic/collect.js), counted into report_traffic_days; once a day, counts older than the retention go.
 *
 * Off under drill mode (REPORT_DRILL=1), when REPORT_JOBS=0, without a database, and when there is no log file (a
 * laptop, a test). A failed pass logs one short line; the next pass reads from the same saved place.
 */
const { createTrafficCollector } = require('../traffic/collect');
const { createVerifier } = require('../traffic/verify');

function createTrafficJobs({ config = {}, store = null, log = console, collector = null } = {}) {
    const cfg = config.jobs || {};
    const c = collector || (store ? createTrafficCollector({ store, file: cfg.trafficLog, verify: createVerifier(), log }) : null);
    let timer = null;
    let lastPrune = 0;

    async function runOnce() {
        if (!c) return { skipped: 'no_database' };
        if (config.drill) return { skipped: 'drill' };
        if (cfg.enabled === false) return { skipped: 'disabled' };
        const out = await c.runOnce();
        if (Date.now() - lastPrune > 24 * 60 * 60 * 1000 && !out.skipped) {
            lastPrune = Date.now();
            await c.prune(cfg.trafficRetentionDays || 400).catch(() => {});
        }
        return out;
    }

    function start() {
        if (timer || !c || config.drill || cfg.enabled === false || !cfg.trafficLog) return null;
        const every = Math.max(15_000, Number(cfg.trafficIntervalMs) || 60_000);
        timer = setInterval(() => { runOnce().catch(() => {}); }, every);
        if (typeof timer.unref === 'function') timer.unref();
        const first = setTimeout(() => { runOnce().catch(() => {}); }, 5_000);
        if (typeof first.unref === 'function') first.unref();
        return timer;
    }

    function stop() { if (timer) { clearInterval(timer); timer = null; } }

    return { start, stop, runOnce };
}

module.exports = { createTrafficJobs };
