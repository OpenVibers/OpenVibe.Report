'use strict';

/**
 * Shared pieces for the two read-only source clients (server/data/network.js and server/data/live.js):
 * one short failure log line, the 8 s timeout, and the parameter rules. A source that cannot answer is
 * never an exception the page has to catch — it is null.
 */

const TIMEOUT_MS = 8_000;
const SLUG_RE = /^[a-z0-9-]{1,80}$/;
const USERNAME_RE = /^[A-Za-z0-9_]{1,32}$/;

const trim = (s) => String(s || '').replace(/\/+$/, '');

function reasonOf(err) {
    if (!err) return 'no response';
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timeout';
    return String(err.message || err).replace(/\s+/g, ' ').slice(0, 160);
}

/** One short line, never the request body, never a stack. */
function warn(log, message) {
    const line = `[OpenVibe.Report] ${String(message).replace(/\s+/g, ' ').slice(0, 240)}`;
    try {
        const fn = (log && (log.warn || log.error)) || console.warn;
        fn.call(log || console, line);
    } catch {
        /* logging must never fail the page */
    }
}

/**
 * GET a JSON document with an 8 s timeout. Returns the parsed body, or null after one log line.
 * A 404 is the source answering "no such thing", so it is null without a log line.
 */
async function requestJson(url, { fetchImpl = globalThis.fetch, log = console, label = 'source', timeoutMs = TIMEOUT_MS } = {}) {
    let res;
    try {
        const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
            ? AbortSignal.timeout(timeoutMs)
            : undefined;
        res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal });
    } catch (err) {
        warn(log, `${label} failed: ${reasonOf(err)}`);
        return null;
    }

    if (!res || !res.ok) {
        if (!res || res.status !== 404) warn(log, `${label} failed: HTTP ${res ? res.status : 'no response'}`);
        return null;
    }

    try {
        return await res.json();
    } catch (err) {
        warn(log, `${label} failed: ${reasonOf(err)}`);
        return null;
    }
}

/** ?days=7|30|90; anything else is 30, exactly as OpenVibe.Network's own route reads it. */
function normaliseDays(value) {
    const raw = Array.isArray(value) ? value[0] : value;
    const days = parseInt(raw, 10);
    return [7, 30, 90].includes(days) ? days : 30;
}

const isSlug = (value) => typeof value === 'string' && SLUG_RE.test(value);

/** A positive integer stream id. Returns the number, or null. */
function streamIdOf(value) {
    const raw = String(value == null ? '' : value);
    if (!/^\d{1,18}$/.test(raw)) return null;
    const id = Number(raw);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

const isStreamId = (value) => streamIdOf(value) !== null;
const isUsername = (value) => typeof value === 'string' && USERNAME_RE.test(value);

module.exports = { TIMEOUT_MS, trim, warn, requestJson, normaliseDays, isSlug, streamIdOf, isStreamId, isUsername };
