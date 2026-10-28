'use strict';

/**
 * Report's analytics authority: the source switch and the one object pages, the API, the ingest job and the shadow
 * job share.
 *
 *   stats(days)   REPORT_SOURCE=network → Network's answer (today's behaviour); report → computed from Report's tables.
 *   channel       always computed from Report's own report_streams, plus Billing's revenue read.
 *   metrics       the flat report.metric@1 rows.
 *
 * The default is `network`: the pages keep reading where they read today while Report shadows. The cutover is one
 * environment value, REPORT_SOURCE=report.
 */
const query = require('./query');
const ingest = require('./ingest');

function createAnalytics({ config = {}, store = null, network = null, billing = null, now = () => Date.now(), log = console } = {}) {
    const source = config.source === 'report' ? 'report' : 'network';

    function warn(what, err) {
        try { (log.warn || log.error || console.warn).call(log, `[OpenVibe.Report] ${what} failed: ${String((err && err.message) || err).replace(/\s+/g, ' ').slice(0, 200)}`); } catch { /* logging must never fail a page */ }
    }

    async function stats(days) {
        try {
            if (source === 'report') return store ? await query.reportStats(store, days, { now }) : null;
            return network && typeof network.stats === 'function' ? await network.stats(days) : null;
        } catch (err) { warn('stats', err); return null; }
    }

    async function channel(name, days, opts = {}) {
        try { return store ? await query.channelStats(store, name, days, { now, billing, ...opts }) : null; } catch (err) { warn('channel analytics', err); return null; }
    }

    async function metrics(opts = {}) {
        try { return store ? await query.metrics(store, { now, ...opts }) : null; } catch (err) { warn('metrics', err); return null; }
    }

    return {
        source, store, billing, network,
        stats, channel, metrics,
        reportStats: (days, opts = {}) => (store ? query.reportStats(store, days, { now, ...opts }) : null),
        recordEvent: (event, opts = {}) => (store ? ingest.recordEvent(store, event, { now, ...opts }) : Promise.resolve({ duplicate: false, outcome: 'no_database' })),
        ingestStats: (payload, opts = {}) => (store ? ingest.ingestStats(store, payload, { now, ...opts }) : Promise.resolve({ ok: false, reason: 'no_database' })),
        ingestNetwork: (opts = {}) => (store && network ? ingest.ingestNetwork(store, network, { now, ...opts }) : Promise.resolve({ ok: false, reason: 'no_database' })),
        log,
    };
}

module.exports = { createAnalytics };
