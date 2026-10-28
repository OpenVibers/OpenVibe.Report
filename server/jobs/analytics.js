'use strict';

/**
 * The two background jobs (server/index.js starts them; tests never do):
 *
 *   ingest   pull Network's open stats into Report's tables every REPORT_INGEST_INTERVAL_MS and at boot
 *   shadow   compare the same window from Network and Report every REPORT_SHADOW_INTERVAL_MS and at boot
 *
 * Neither job runs when REPORT_JOBS=0. A failed pass logs one short line and leaves the last good data in place;
 * the next pass retries. Overlapping passes in one process are skipped.
 */
function createAnalyticsJobs({ config = {}, analytics = null, shadow = null, log = console } = {}) {
    const cfg = config.jobs || {};
    const timers = [];
    let ingestBusy = false;
    let shadowBusy = false;

    async function runIngest() {
        if (!analytics || ingestBusy) return null;
        ingestBusy = true;
        try {
            const out = [];
            for (const days of cfg.ingestWindows || [7, 30, 90]) out.push(await analytics.ingestNetwork({ days }));
            if (out.every((x) => x && x.ok === false && x.reason === 'network_did_not_answer')) log.warn('[OpenVibe.Report] ingest: Network did not answer; keeping the last numbers');
            return out;
        } catch (err) {
            log.warn(`[OpenVibe.Report] ingest failed: ${String((err && err.message) || err).replace(/\s+/g, ' ').slice(0, 200)}`);
            return null;
        } finally { ingestBusy = false; }
    }

    async function runShadow() {
        if (!shadow || shadowBusy) return null;
        shadowBusy = true;
        try {
            const out = await shadow.compare({ days: cfg.shadowWindowDays || 7 });
            if (out && out.status === 'differences') log.warn(`[OpenVibe.Report] shadow: ${out.differences} difference(s) over ${cfg.shadowWindowDays || 7} days`);
            return out;
        } catch (err) {
            log.warn(`[OpenVibe.Report] shadow failed: ${String((err && err.message) || err).replace(/\s+/g, ' ').slice(0, 200)}`);
            return null;
        } finally { shadowBusy = false; }
    }

    function every(ms, fn) {
        const t = setInterval(fn, ms);
        if (typeof t.unref === 'function') t.unref();
        timers.push(t);
    }

    function start() {
        if (!cfg.enabled) return false;
        if (cfg.onBoot) {
            const t = setTimeout(async () => { await runIngest(); await runShadow(); }, 2_000);
            if (typeof t.unref === 'function') t.unref();
            timers.push(t);
        }
        every(cfg.ingestIntervalMs || 5 * 60_000, runIngest);
        every(cfg.shadowIntervalMs || 15 * 60_000, runShadow);
        return true;
    }

    async function stop() {
        while (timers.length) { const t = timers.pop(); clearTimeout(t); clearInterval(t); }
        // Let an in-flight pass finish before the database closes (gracefulStop awaits this step).
        const until = Date.now() + 5_000;
        while ((ingestBusy || shadowBusy) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    }

    return { start, stop, runIngest, runShadow };
}

module.exports = { createAnalyticsJobs };
