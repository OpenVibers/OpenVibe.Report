'use strict';

// Many requests per test file would trip the 120/min per-address limit. The app's limit is configurable, so the
// tests raise it once through the environment the helper passes to config.load.
process.env.RELEASE_COMMIT = process.env.RELEASE_COMMIT || '0000000';

/**
 * Boots OpenVibe.Report on an ephemeral port with a stub fetch (no network, no running site) and returns a small
 * HTTP client. Each test file gets its own app, clients and captured log lines. `boot({ db: true })` adds a migrated
 * PGlite and `store` (the analytics tests); without it the app runs with `store: null`, as a network-only front.
 *
 *   const t = await boot();
 *   t.get('/api/v1/stats?days=30') → { status, headers, text, json() }
 *   t.get('/internal/events', { method: 'POST', headers, body }) → a raw-body request
 *   t.logs()
 */
const http = require('http');
const configLib = require('../../server/config');
const { createApp } = require('../../server/app');
const { createStore } = require('../../server/db');
const { testDb } = require('./db');

const NETWORK = 'http://127.0.0.1:4000';
const LIVE = 'http://127.0.0.1:3000';

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function defaults() {
    return {
        stats: {
            generated_at: '2026-10-28T12:00:00.000Z',
            window_days: 7,
            totals: {
                pageviews: 77408, pageviews_prev: 102633, change_pct: -25, sites_open: 37,
                services: { up: 38, checked: 38 }, accounts: 496, requests_24h: 1037412,
            },
            sites: [{ name: 'OpenVibe.Live', host: 'openvibe.live', pageviews: 32000, change_pct: 4 }],
        },
        rundown: {
            on_air: [{ stream_id: 7, user: { username: 'goosely', display_name: 'goosely' }, stream_title: 'Seattle', topic: { slug: 'seattle', title: 'Seattle' } }],
            lead: { title: 'A lead take', what: 'What the lead said.', user: { username: 'goosely', display_name: 'goosely' }, topic: { slug: 'seattle', title: 'Seattle' }, stream_id: 7 },
            streams: [{ stream_id: 7, user: { username: 'goosely', display_name: 'goosely' }, title: 'Seattle', episode: { title: 'A written-up stream' } }],
            trending: [{ slug: 'seattle', title: 'Seattle', kind: 'life', takes: 3, streamers: 1 }],
            counts: { topics: 5, episodes: 4, takes: 20 },
        },
        topics: {
            topics: [
                { slug: 'seattle', title: 'Seattle', kind: 'life', takes: 3, streamers: 1 },
                { slug: 'ai-progress', title: 'AI progress', kind: 'tech', takes: 5, streamers: 2 },
            ],
            kinds: ['news', 'games', 'tech', 'life'],
        },
        topic: {
            topic: { slug: 'seattle', title: 'Seattle', kind: 'life', headline: 'A headline', summary: 'A summary.', takes: 3, streamers: 1, first_seen_at: '2026-10-20 10:00:00', last_seen_at: '2026-10-27 10:00:00' },
            takes: [{ title: 'A take', quip: 'A quip.', user: { username: 'goosely', display_name: 'goosely' }, topic: { slug: 'seattle', title: 'Seattle' }, stream_id: 7 }],
            related: [{ slug: 'ai-progress', title: 'AI progress', kind: 'tech' }],
        },
        episode: {
            episode: { stream_id: 7, title: 'A written-up stream', logline: 'The logline.', minutes: 34, aired_at: '2026-10-27 10:00:00' },
            stream: { id: 7, title: 'Seattle', is_live: false, user: { username: 'goosely', display_name: 'goosely' } },
            segments: [{ title: 'A segment', user: { username: 'goosely', display_name: 'goosely' }, topic: { slug: 'seattle', title: 'Seattle' } }],
            more: [{ stream_id: 6, title: 'An older episode', aired_at: '2026-10-26 10:00:00' }],
        },
        speaker: {
            user: { username: 'goosely', display_name: 'goosely' },
            opted_out: false,
            episodes: [{ stream_id: 7, title: 'A written-up stream', aired_at: '2026-10-27 10:00:00', minutes: 34 }],
            topics: [{ slug: 'seattle', title: 'Seattle', takes: 3 }],
            lines: [],
            crossovers: [],
        },
        recap: {
            recap: {
                stream: { id: 7, title: 'Seattle Today', duration_seconds: 2017, ended_at: '2026-10-27 10:33:00' },
                streamer: { username: 'goosely', display_name: 'goosely' },
                viewers: { avg: 1 },
                chat: { messages: 53, chatters: 2 },
                write: { headline: 'A tiny but mighty vibe', summary: 'What happened, in a paragraph.' },
                generated_at: '2026-10-27T10:35:00.000Z',
            },
            more: [],
        },
        channel: {
            recaps: [{ stream_id: 7, title: 'Seattle Today', headline: 'A tiny but mighty vibe', grade: 'A', duration_seconds: 2017, ended_at: '2026-10-27 10:33:00' }],
        },
    };
}

/**
 * A URL-aware stand-in for OpenVibe.Network and OpenVibe.Live. `data` overrides any of the default answers; a
 * null answer becomes a 404, exactly as a source that has nothing. `health` says which source's /api/health
 * answers: { network: true, live: false } makes only Live fail.
 */
function stubFetch(data = {}, { health = { network: true, live: true } } = {}) {
    const answers = { ...defaults(), ...data };
    const calls = [];

    const fetchImpl = async (url) => {
        const raw = String(url);
        calls.push(raw);
        const u = new URL(raw);
        const p = u.pathname;
        const port = u.port;

        if (p.endsWith('/api/health')) {
            const source = port === '3000' ? 'live' : 'network';
            if (!health[source]) throw new Error(`${source} health failed`);
            return jsonResponse({ status: 'ok' });
        }

        if (p.endsWith('/api/v1/stats')) {
            return answers.stats == null ? jsonResponse({ error: 'unavailable' }, 404) : jsonResponse(answers.stats);
        }
        if (p.endsWith('/api/rundown/')) {
            return answers.rundown == null ? jsonResponse({ error: 'unavailable' }, 404) : jsonResponse(answers.rundown);
        }
        if (p.endsWith('/api/rundown/topics')) {
            return answers.topics == null ? jsonResponse({ error: 'unavailable' }, 404) : jsonResponse(answers.topics);
        }
        let m = /^\/api\/rundown\/t\/([^/]+)$/.exec(p);
        if (m) return answers.topic == null ? jsonResponse({ error: 'not found' }, 404) : jsonResponse(answers.topic);
        m = /^\/api\/rundown\/e\/(\d+)$/.exec(p);
        if (m) return answers.episode == null ? jsonResponse({ error: 'not found' }, 404) : jsonResponse(answers.episode);
        m = /^\/api\/rundown\/s\/([^/]+)$/.exec(p);
        if (m) return answers.speaker == null ? jsonResponse({ error: 'not found' }, 404) : jsonResponse(answers.speaker);
        m = /^\/api\/recap\/channel\/([^/]+)$/.exec(p);
        if (m) return answers.channel == null ? jsonResponse({ error: 'not found' }, 404) : jsonResponse(answers.channel);
        m = /^\/api\/recap\/(\d+)$/.exec(p);
        if (m) return answers.recap == null ? jsonResponse({ error: 'not found' }, 404) : jsonResponse(answers.recap);

        return jsonResponse({ error: 'no stub for ' + p }, 404);
    };
    fetchImpl.calls = calls;
    return fetchImpl;
}

async function boot(opts = {}) {
    const captured = [];
    const log = {
        log: (...a) => captured.push(a.map(String).join(' ')),
        info: (...a) => captured.push(a.map(String).join(' ')),
        warn: (...a) => captured.push(a.map(String).join(' ')),
        error: (...a) => captured.push(a.map(String).join(' ')),
    };
    const fetchImpl = opts.fetchImpl || stubFetch(opts.data, opts.stub);
    const env = {
        NODE_ENV: 'test',
        PORT: '0',
        BASE_URL: 'https://openvibe.report',
        TRUST_PROXY: '1',
        OV_NETWORK_INTERNAL_URL: NETWORK,
        OV_LIVE_INTERNAL_URL: LIVE,
        REPORT_API_RATE_LIMIT_PER_MIN: '100000',
        ...(opts.env || {}),
    };
    const config = configLib.load(env);
    // Most tests never touch the database; `boot({ db: true })` gives them a migrated PGlite of their own.
    const testdatabase = (opts.db === true || opts.store) ? await testDb({ store: opts.dbStore }) : null;
    const store = opts.store || (testdatabase ? createStore(testdatabase.db, { now: opts.now }) : null);
    const built = await createApp({
        config,
        store,
        fetchImpl,
        log,
        now: opts.now,
        billing: opts.billing,
        analytics: opts.analytics,
        shadow: opts.shadow,
        releaseEnv: { ...process.env, RELEASE_COMMIT: '0000000' },
    });
    const server = await new Promise((resolve) => {
        const s = http.createServer(built.app);
        s.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = `http://127.0.0.1:${server.address().port}`;

    async function get(pathname, o = {}) {
        const headers = { ...(o.headers || {}) };
        let body = o.body;
        if (o.json !== undefined) { body = JSON.stringify(o.json); headers['content-type'] = 'application/json'; }
        const method = o.method || (body ? 'POST' : 'GET');
        const res = await fetch(base + pathname, { method, headers, body, redirect: 'manual' });
        const text = await res.text();
        return {
            status: res.status,
            headers: res.headers,
            text,
            json() { return JSON.parse(text); },
        };
    }

    return {
        base, config, ctx: built.ctx, fetchImpl, get, testdatabase,
        logs: () => captured.join('\n'),
        async close() {
            built.ctx.metricsStop();
            await new Promise((resolve) => server.close(resolve));
            if (testdatabase) await testdatabase.close().catch(() => {});
        },
    };
}

let failures = 0;
async function check(name, fn) {
    try {
        await fn();
        process.stdout.write(`  ✓ ${name}\n`);
    } catch (e) {
        failures++;
        process.stdout.write(`  ✗ ${name}\n      ${(e.stack || String(e)).split('\n').slice(0, 8).join('\n      ')}\n`);
    }
}
function done() {
    process.stdout.write(failures ? `\n${failures} failed\n` : '\nall passed\n');
    process.exit(failures ? 1 : 0);
}

module.exports = { boot, check, done, stubFetch, jsonResponse, defaults, NETWORK, LIVE };
