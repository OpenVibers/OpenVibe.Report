'use strict';

/**
 * The shadow comparison: read the same window from OpenVibe.Network and from Report's tables, then record every
 * number that differs in report_shadow_diffs, one run per pass (report_shadow_runs). A clean run has zero diffs.
 *
 * The two sides are normalized with the same function the ingest uses (metricRowsFromStats), so an equal answer
 * compares equal; a changed number, a missing one or an extra stale one is a difference. Billing is not in the
 * shadow: Report quotes Billing directly and never keeps a second copy of money.
 */
const crypto = require('crypto');
const { metricRowsFromStats } = require('./ingest');
const { normaliseDays } = require('../data/source');
const { windowOf } = require('./query');

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const same = (a, b) => a == null || b == null ? a == b : Math.abs(a - b) < 1e-6;
function stable(v) {
    if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
    return JSON.stringify(v == null ? null : v);
}
const keyOf = (r) => r.kind === 'window'
    ? `w|${r.scope}|${r.scope_id}|${r.metric}|${r.window_days}`
    : `d|${r.scope}|${r.scope_id}|${r.metric}|${r.day}`;

function runId() { return `shr_${crypto.randomBytes(10).toString('hex')}`; }

async function reportRows(store, days, nowMs) {
    const w = windowOf(nowMs, days);
    const rows = await store.db.many(`SELECT metric, scope, scope_id, day::text AS day, value FROM report_metric_days
        WHERE scope IN ('network', 'site') AND day >= $1`, [w.currentStart]);
    const wins = await store.db.many(`SELECT metric, scope, scope_id, window_days, value FROM report_metric_windows
        WHERE scope IN ('network', 'site') AND window_days = $1`, [days]);
    return [
        ...rows.map((r) => ({ kind: 'day', metric: r.metric, scope: r.scope, scope_id: r.scope_id, day: r.day, value: num(r.value) })),
        ...wins.map((r) => ({ kind: 'window', metric: r.metric, scope: r.scope, scope_id: r.scope_id, window_days: r.window_days, value: num(r.value) })),
    ];
}

function createShadow({ store, network, now = () => Date.now(), log = console }) {
    if (!store || !store.db) throw new TypeError('createShadow needs an open Report store');

    /** Compare one window. `stats` may be supplied (a fixture or a cached Network answer); otherwise Network is asked. */
    async function compare({ days = 7, stats } = {}) {
        const windowDays = normaliseDays(days);
        const id = runId();
        const startedAt = new Date(now()).toISOString();
        await store.db.prepare(`INSERT INTO report_shadow_runs (run_id, window_days, status, checked, differences, started_at)
            VALUES (?, ?, 'running', 0, 0, ?)`).run(id, windowDays, startedAt);
        try {
            let source = stats;
            if (source === undefined) source = await network.stats(windowDays);
            if (!source) {
                await store.db.prepare(`UPDATE report_shadow_runs SET status = 'network_unavailable', checked = 0, differences = 0, finished_at = ? WHERE run_id = ?`)
                    .run(new Date(now()).toISOString(), id);
                return { run_id: id, status: 'network_unavailable', checked: 0, differences: 0, diffs: [] };
            }
            const networkRows = metricRowsFromStats(source);
            const stored = await reportRows(store, windowDays, now());
            const reportByKey = new Map(stored.map((r) => [keyOf(r), r]));
            const netKeys = new Set(networkRows.map(keyOf));
            const keys = new Set([...netKeys, ...stored.map(keyOf)]);
            const diffs = [];
            let checked = 0;
            const reportJson = await store.db.maybe(`SELECT value FROM report_metric_json WHERE metric = 'busiest_pages' AND scope = 'network' AND scope_id = 'network' AND window_days = $1`, [windowDays]);
            const networkJson = Array.isArray(source.busiest_pages_24h) ? source.busiest_pages_24h : null;
            if ((networkJson || reportJson) && stable(networkJson) !== stable(reportJson ? reportJson.value : null)) {
                checked++;
                diffs.push({
                    metric: 'busiest_pages', scope: 'network', scope_id: 'network', day: null, window_days: windowDays,
                    network_value: null, report_value: null, delta: null,
                    network_json: networkJson, report_json: reportJson ? reportJson.value : null,
                });
            }
            for (const key of keys) {
                const net = networkRows.find((r) => keyOf(r) === key) || null;
                const rep = reportByKey.get(key) || null;
                if (!net && !rep) continue;
                // Only compare a stored number whose metric Network actually reports in this window; an unrelated
                // stored scope is not a shadow difference.
                if (!net && !netKeys.has(key) && !networkRows.some((r) => r.metric === (rep && rep.metric))) continue;
                checked++;
                const nv = net ? net.value : null;
                const rv = rep ? rep.value : null;
                if (same(nv, rv)) continue;
                diffs.push({
                    metric: (net || rep).metric, scope: (net || rep).scope, scope_id: (net || rep).scope_id,
                    day: (net || rep).kind === 'day' ? (net || rep).day : null,
                    window_days: (net || rep).kind === 'window' ? (net || rep).window_days : null,
                    network_value: nv, report_value: rv, delta: (rv == null ? 0 : rv) - (nv == null ? 0 : nv),
                });
            }
            for (const d of diffs) {
                await store.db.prepare(`INSERT INTO report_shadow_diffs (run_id, metric, scope, scope_id, day, window_days, network_value, report_value, delta, network_json, report_json)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb)`)
                    .run(id, d.metric, d.scope, d.scope_id, d.day, d.window_days, d.network_value, d.report_value, d.delta,
                        d.network_json == null ? null : JSON.stringify(d.network_json), d.report_json == null ? null : JSON.stringify(d.report_json));
            }
            await store.db.prepare(`UPDATE report_shadow_runs SET status = ?, checked = ?, differences = ?, finished_at = ? WHERE run_id = ?`)
                .run(diffs.length ? 'differences' : 'equal', checked, diffs.length, new Date(now()).toISOString(), id);
            return { run_id: id, status: diffs.length ? 'differences' : 'equal', checked, differences: diffs.length, diffs };
        } catch (err) {
            const message = String((err && err.message) || err).replace(/\s+/g, ' ').slice(0, 400);
            await store.db.prepare(`UPDATE report_shadow_runs SET status = 'error', error = ?, finished_at = ? WHERE run_id = ?`)
                .run(message, new Date(now()).toISOString(), id).catch(() => {});
            if (log && log.warn) log.warn(`[OpenVibe.Report] shadow run failed: ${message}`);
            return { run_id: id, status: 'error', error: message, checked: 0, differences: 0, diffs: [] };
        }
    }

    /** The latest run(s) and their differences, for GET /internal/shadow. */
    async function summary({ limit = 5, days = null } = {}) {
        const n = Math.min(Math.max(parseInt(limit, 10) || 5, 1), 50);
        const windowDays = days == null || days === '' ? null : normaliseDays(days);
        const runs = windowDays
            ? await store.db.many(`SELECT run_id, window_days, status, checked, differences, error, started_at, finished_at
                FROM report_shadow_runs WHERE window_days = $1 ORDER BY run_seq DESC LIMIT $2`, [windowDays, n])
            : await store.db.many(`SELECT run_id, window_days, status, checked, differences, error, started_at, finished_at
                FROM report_shadow_runs ORDER BY run_seq DESC LIMIT $1`, [n]);
        const latest = runs[0] || null;
        const diffs = latest ? await store.db.many(`SELECT metric, scope, scope_id, day::text AS day, window_days, network_value, report_value, delta, network_json, report_json
            FROM report_shadow_diffs WHERE run_id = $1 ORDER BY id LIMIT 500`, [latest.run_id]) : [];
        return {
            as_of: new Date(now()).toISOString(),
            latest: latest ? { ...latest, checked: Number(latest.checked), differences: Number(latest.differences) } : null,
            runs: runs.map((r) => ({ ...r, checked: Number(r.checked), differences: Number(r.differences) })),
            diffs: diffs.map((d) => ({
                ...d, network_value: num(d.network_value), report_value: num(d.report_value), delta: num(d.delta),
            })),
        };
    }

    return { compare, summary, runId };
}

module.exports = { createShadow, reportRows };
