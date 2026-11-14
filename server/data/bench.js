'use strict';

/**
 * OpenVibe.Bench's public reads (plan 2026-10-28 §4.12; the 2026-11-08 move adds the registry reads):
 *   GET /api/v1/kinds                        every benchmark kind
 *   GET /api/v1/boards/:kind?type=elo|pareto|cost
 *   GET /api/v1/models/:model                one model across every kind (the legacy boards)
 *   GET /api/v1/benchmarks                   every public benchmark, its runs and last run
 *   GET /api/v1/benchmarks/:id               one benchmark and its definition
 *   GET /api/v1/rankings?benchmark=&metric=  verified per-model medians
 *   GET /api/v1/runs?benchmark=&model=&kind= public runs newest first
 *   GET /api/v1/overview                     public counts and the newest runs
 *   GET /api/v1/models/:model/summary         a model's runs, tasks, cost and last run
 *
 * Reads are public and held for sixty seconds in this process. A read that has answered once keeps its copy
 * for as long as Bench is down: the client answers the last good one with the moment it was read (`at`) and
 * `stale: true`, so a board page stays a page — never an error page. A read that has never answered is null
 * after one short log line. A kind id, benchmark id, board type or model name that cannot exist is refused
 * before any request is made.
 */
const { trim, requestJson, TIMEOUT_MS } = require('./source');
const { createClient } = require('openvibe-sdk/core');
const { createCompareClient: createSdkBench } = require('openvibe-sdk/compare');

const TTL_MS = 60_000;
const KIND_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const BENCHMARK_RE = /^bmk_[0-9A-HJKMNP-TV-Z]{26}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:+\/~\-]{0,119}$/;
const BOARD_TYPES = Object.freeze(['elo', 'pareto', 'cost']);
const METRICS = Object.freeze(['score', 'value', 'speed', 'consistency', 'horizon']);

const isKindId = (value) => typeof value === 'string' && KIND_RE.test(value);

/** A benchmark id as Bench mints it (bmk_ + a 26-character ULID), never a kind or a path. */
const isBenchmarkId = (value) => typeof value === 'string' && BENCHMARK_RE.test(value);

/** A model as Bench pins it: one path segment (its own /models/:model route cannot serve more), 120 characters at most. */
const isModelName = (value) => typeof value === 'string' && MODEL_RE.test(value);

/** A ranking metric; anything else is the score, exactly as Bench's own rankings route defaults. */
function normaliseMetric(value) {
    const raw = Array.isArray(value) ? value[0] : value;
    return METRICS.includes(raw) ? raw : 'score';
}

/** A public run limit: 1 to 100, the API's own cap; anything else is 20. */
function normaliseLimit(value) {
    const n = parseInt(Array.isArray(value) ? value[0] : value, 10);
    return Number.isFinite(n) ? Math.min(100, Math.max(1, n)) : 20;
}

/** ?tab=elo|pareto|cost; anything else is the Elo board, exactly as the page tabs read it. */
function normaliseTab(value) {
    const raw = Array.isArray(value) ? value[0] : value;
    return BOARD_TYPES.includes(raw) ? raw : 'elo';
}

/**
 * opts: config ({ benchUrl }), fetchImpl, log, now, timeoutMs
 */
function createBenchClient({ config = {}, fetchImpl = globalThis.fetch, log = console, now = () => Date.now(), timeoutMs = TIMEOUT_MS } = {}) {
    const baseUrl = trim(config.benchUrl || 'http://127.0.0.1:5230');
    const clock = typeof now === 'function' ? now : () => Date.now();
    const shared = createSdkBench(createClient({ fetch: fetchImpl, retries: 0 }), { baseUrl });

    // The last good copy of every read, kept beyond its minute so a Bench outage never empties a page. Kinds and
    // boards are a fixed small set; models are capped, the oldest inserted out first.
    const boards = new Map();
    const models = new Map();
    const catalog = new Map();
    const results = new Map();

    function keep(store, key, data, cap) {
        store.set(key, data);
        while (store.size > cap) store.delete(store.keys().next().value);
    }

    /** One read: the fresh copy, the last good one (stale) while Bench is down, or null when there is none yet. */
    async function read(store, key, path, label, cap, loader = null) {
        const atMs = clock();
        const hit = store.get(key);
        if (hit && hit.atMs + TTL_MS > atMs) return { data: hit.data, at: hit.at, stale: false };
        if (hit && hit.retryAtMs > atMs) return { data: hit.data, at: hit.at, stale: true };
        let data = null;
        if (loader) {
            try { data = await loader(); }
            catch (err) { log.warn(`[report] ${label} unavailable: ${String(err.message || err).slice(0, 160)}`); }
        } else data = await requestJson(`${baseUrl}${path}`, { fetchImpl, log, timeoutMs, label });
        if (data === null) {
            if (hit) hit.retryAtMs = atMs + TTL_MS;
            return hit ? { data: hit.data, at: hit.at, stale: true } : null;
        }
        const entry = { data, atMs, at: new Date(atMs).toISOString() };
        keep(store, key, entry, cap);
        return { data, at: entry.at, stale: false };
    }

    /** Every kind: { count, kinds: [{ id, room, entry, judge, name, metrics, created_at }] }. */
    function kinds() {
        return read(boards, 'kinds', '/api/v1/kinds', 'bench kinds', 500);
    }

    /** One kind's board: { board: { kind_id, category, period, type, rows } }. */
    async function board(kindId, type = 'elo') {
        if (!isKindId(kindId) || !BOARD_TYPES.includes(type)) return null;
        return read(
            boards,
            `board:${kindId}:${type}`,
            `/api/v1/boards/${encodeURIComponent(kindId)}?type=${type}`,
            `bench board (${kindId}, ${type})`,
            500,
            type === 'elo' ? async () => {
                const data = await shared.ratings.get(kindId, { signal: AbortSignal.timeout(timeoutMs) });
                return { ...data, board: { ...data.board, rows: (data.board?.rows || []).filter((row) => row.games >= 20) } };
            } : null,
        );
    }

    /** One model across every kind: { model, ratings, entries, total_cost_usd }. */
    async function modelSummary(model) {
        if (!isModelName(model)) return null;
        return read(models, `model:${model}`, `/api/v1/models/${encodeURIComponent(model)}`, `bench model (${model})`, 200);
    }

    /** Every public benchmark the registry lists, with its runs and last run. */
    function benchmarks() {
        return read(catalog, 'benchmarks', '/api/v1/benchmarks?limit=200', 'bench benchmarks', 100);
    }

    /** One public benchmark: { benchmark, version, definition, task_meta }. */
    async function benchmark(id) {
        if (!isBenchmarkId(id)) return null;
        return read(catalog, `benchmark:${id}`, `/api/v1/benchmarks/${encodeURIComponent(id)}`, `bench benchmark (${id})`, 500);
    }

    /** Public counts and the newest runs: { kinds, benchmarks, tasks, runs, models, last_run, list, recent }. */
    function overview() {
        return read(catalog, 'overview', '/api/v1/overview', 'bench overview', 20);
    }

    /** One benchmark's verified medians: { rankings: { benchmark, metric, entries } }. */
    async function rankings(benchmarkId, metric = 'score') {
        if (!isBenchmarkId(benchmarkId) || !METRICS.includes(metric)) return null;
        return read(results, `rankings:${benchmarkId}:${metric}`, `/api/v1/rankings?benchmark=${encodeURIComponent(benchmarkId)}&metric=${metric}`, `bench rankings (${benchmarkId}, ${metric})`, 500);
    }

    /**
     * Public runs newest first. opts: { benchmark, model, kind, limit }. A kind is the task-kind filter the kind
     * page reads; a benchmark and a model are the registry ids. A value that cannot exist is refused before any
     * request, so a stray query never becomes a Bench call.
     */
    async function runs({ benchmark = null, model = null, kind = null, limit = 20 } = {}) {
        if (benchmark != null && !isBenchmarkId(benchmark)) return null;
        if (model != null && !isModelName(model)) return null;
        if (kind != null && !isKindId(kind)) return null;
        const params = new URLSearchParams();
        if (benchmark) params.set('benchmark', benchmark);
        if (model) params.set('model', model);
        if (kind) params.set('kind', kind);
        params.set('limit', String(normaliseLimit(limit)));
        const query = params.toString();
        return read(results, `runs:${query}`, `/api/v1/runs?${query}`, `bench runs (${query})`, 500);
    }

    /** A model's public record: { model, runs, benchmarks, tasks, best_task, worst_task, recent_runs, total_cost_usd, last_run }. */
    async function modelDetail(model) {
        if (!isModelName(model)) return null;
        return read(models, `detail:${model}`, `/api/v1/models/${encodeURIComponent(model)}/summary`, `bench model detail (${model})`, 200);
    }

    return {
        kinds, board, modelSummary, benchmarks, benchmark, overview, rankings, runs, modelDetail,
        baseUrl, ttlMs: TTL_MS, isKindId, isBenchmarkId, isModelName, normaliseTab, normaliseMetric, normaliseLimit,
    };
}

module.exports = {
    createBenchClient, TTL_MS, BOARD_TYPES, METRICS, isKindId, isBenchmarkId, isModelName, normaliseTab, normaliseMetric, normaliseLimit,
};
