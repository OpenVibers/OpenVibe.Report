'use strict';

/**
 * OpenVibe.Bench's public reads (plan 2026-10-28 §4.12):
 *   GET /api/v1/kinds                        every benchmark kind
 *   GET /api/v1/boards/:kind?type=elo|pareto|cost
 *   GET /api/v1/models/:model                one model across every kind
 *
 * Reads are public and held for sixty seconds in this process. A read that has answered once keeps its copy
 * for as long as Bench is down: the client answers the last good one with the moment it was read (`at`) and
 * `stale: true`, so a board page stays a page — never an error page. A read that has never answered is null
 * after one short log line. A kind id, board type or model name that cannot exist is refused before any request
 * is made.
 */
const { trim, requestJson, TIMEOUT_MS } = require('./source');

const TTL_MS = 60_000;
const KIND_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:+\/~\-]{0,119}$/;
const BOARD_TYPES = Object.freeze(['elo', 'pareto', 'cost']);

const isKindId = (value) => typeof value === 'string' && KIND_RE.test(value);

/** A model as Bench pins it: one path segment (its own /models/:model route cannot serve more), 120 characters at most. */
const isModelName = (value) => typeof value === 'string' && MODEL_RE.test(value);

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

    // The last good copy of every read, kept beyond its minute so a Bench outage never empties a page. Kinds and
    // boards are a fixed small set; models are capped, the oldest inserted out first.
    const boards = new Map();
    const models = new Map();

    function keep(store, key, data, cap) {
        store.set(key, data);
        while (store.size > cap) store.delete(store.keys().next().value);
    }

    /** One read: the fresh copy, the last good one (stale) while Bench is down, or null when there is none yet. */
    async function read(store, key, path, label, cap) {
        const atMs = clock();
        const hit = store.get(key);
        if (hit && hit.atMs + TTL_MS > atMs) return { data: hit.data, at: hit.at, stale: false };
        if (hit && hit.retryAtMs > atMs) return { data: hit.data, at: hit.at, stale: true };
        const data = await requestJson(`${baseUrl}${path}`, { fetchImpl, log, timeoutMs, label });
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
        );
    }

    /** One model across every kind: { model, ratings, entries, total_cost_usd }. */
    async function modelSummary(model) {
        if (!isModelName(model)) return null;
        return read(models, `model:${model}`, `/api/v1/models/${encodeURIComponent(model)}`, `bench model (${model})`, 200);
    }

    return { kinds, board, modelSummary, baseUrl, ttlMs: TTL_MS, isKindId, isModelName, normaliseTab };
}

module.exports = { createBenchClient, TTL_MS, BOARD_TYPES, isKindId, isModelName, normaliseTab };
