'use strict';
/**
 * The AI meter's job (plan L40 and L41): the daily roll-ups of the usage records, and the pruning of the raw records
 * after 90 days. The roll-ups are kept for good.
 *
 * The job stays off under drill mode (REPORT_DRILL=1) and off when REPORT_JOBS=0, so a drill never changes the
 * numbers. A failed pass logs one short line and the next pass retries; the last good roll-up stays in place.
 */
const aiUsage = require('../analytics/ai-usage');

function createAiUsageJobs({ config = {}, store = null, now = () => Date.now(), log = console } = {}) {
    const cfg = config.jobs || {};
    let timer = null;
    let running = false;

    async function runOnce() {
        if (!store) return { skipped: 'no_database' };
        if (config.drill) return { skipped: 'drill' };
        if (cfg.enabled === false) return { skipped: 'disabled' };
        if (running) return { skipped: 'running' };
        running = true;
        try {
            const rolled = await aiUsage.rollup(store, { days: cfg.aiUsageRollupDays || 14 });
            const pruned = await aiUsage.prune(store, { now: now(), days: cfg.aiUsageRetentionDays || aiUsage.RAW_RETENTION_DAYS });
            return { days: rolled.days, rows: rolled.rows, raw_pruned: pruned.raw };
        } catch (err) {
            const msg = String((err && err.message) || err).replace(/\s+/g, ' ').slice(0, 200);
            log.warn('[OpenVibe.Report] the AI meter roll-up failed: ' + msg);
            return { error: msg };
        } finally { running = false; }
    }

    function start() {
        if (timer) return timer;
        if (config.drill) return null;          // a drill never changes the numbers
        if (cfg.enabled === false) return null;
        const every = Math.max(60_000, Number(cfg.aiUsageIntervalMs) || 60 * 60_000);
        timer = setInterval(() => { runOnce().catch(() => {}); }, every);
        if (typeof timer.unref === 'function') timer.unref();
        return timer;
    }

    function stop() {
        if (timer) { clearInterval(timer); timer = null; }
    }

    return { start, stop, runOnce };
}

module.exports = { createAiUsageJobs };
