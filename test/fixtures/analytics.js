'use strict';

/**
 * Fixed analytics facts for the tests: seven days ending 2026-10-28, two sites, two ended streams.
 * Every expected number is written down here, independent of the implementation.
 */
const NOW = Date.parse('2026-10-28T12:00:00.000Z');
const DAY = 86_400_000;
const DAYS = Array.from({ length: 7 }, (_, i) => new Date(NOW - (6 - i) * DAY).toISOString().slice(0, 10));
const SUBJECT = 'usr_01J0000000000000000000000A';

const PAGVIEWS_DAILY = [20, 20, 20, 20, 20, 40, 60];       // 200 from the navbar site
const ACCOUNTS_DAILY = [0, 0, 1, 0, 1, 1, 0];              // 3 new
const COINS_DAILY = [10, 10, 10, 10, 10, 10, 10];          // 70 this window

const stats = {
    generated_at: '2026-10-28T12:00:00.000Z',
    window_days: 7,
    note: 'Counts only, never about a person.',
    totals: {
        pageviews: 300, pageviews_prev: 200, change_pct: 50, sites_open: 2,
        services: { up: 1, checked: 2 }, accounts: 10, requests_24h: 1000,
    },
    pageviews_daily: DAYS.map((day, i) => ({ day, n: PAGVIEWS_DAILY[i] })),
    accounts: { total: 10, new: 3, prev: 2, daily: DAYS.map((day, i) => ({ day, n: ACCOUNTS_DAILY[i] })) },
    coins: {
        earned: 500, spent: 100, holders: 4, transactions: 20, earned_window: 70, earned_prev: 50,
        daily: DAYS.map((day, i) => ({ day, n: COINS_DAILY[i] })),
    },
    live: {
        live_now: 2, watching: 9, streamers: 5, streams: 6, visitors: 7, messages: 80, chatted_7d: 4,
        vods: 3, clips: 2, hours_watched: 11, hours_archived: 12, ai_moments: 1, pastes: 0, follows: 13,
    },
    busiest_pages_24h: [{ service: 'network', route: '/stats', requests: 100 }],
    sites: [
        {
            id: 'network', name: 'OpenVibe.Network', short: 'Network', host: 'openvibe.network', url: 'https://openvibe.network/',
            pageviews: 200, pageviews_prev: 150, change_pct: 33, daily: DAYS.map((day, i) => ({ day, n: PAGVIEWS_DAILY[i] })),
            unique_visitors: 20, traffic_24h: { requests: 800, server_errors: 2, p95_ms: 120 },
        },
        {
            id: 'live', name: 'OpenVibe.Live', short: 'Live', host: 'openvibe.live', url: 'https://openvibe.live/',
            pageviews: 100, pageviews_prev: 50, change_pct: 100, daily: null,
            unique_visitors: 30, signed_in_people: 10, traffic_24h: null,
        },
    ],
};

const expected = {
    generated_at: new Date(NOW).toISOString(),
    window_days: 7,
    totals: {
        pageviews: 300, pageviews_prev: 200, change_pct: 50, sites_open: 2,
        services: { up: 1, checked: 2 }, accounts: 10, requests_24h: 1000,
    },
    pageviews_daily: DAYS.map((day, i) => ({ day, n: PAGVIEWS_DAILY[i] })),
    accounts: { total: 10, new: 3, prev: 2, daily: DAYS.map((day, i) => ({ day, n: ACCOUNTS_DAILY[i] })) },
    coins: {
        earned: 500, spent: 100, holders: 4, transactions: 20, earned_window: 70, earned_prev: 50,
        daily: DAYS.map((day, i) => ({ day, n: COINS_DAILY[i] })),
    },
    live: {
        live_now: 2, watching: 9, streamers: 5, streams: 6, visitors: 7, messages: 80, chatted_7d: 4,
        vods: 3, clips: 2, hours_watched: 11, hours_archived: 12, ai_moments: 1, pastes: 0, follows: 13,
    },
    busiest_pages_24h: [{ service: 'network', route: '/stats', requests: 100 }],
};

function streamEnded(streamId, { channel = 'goosely', startedAt, endedAt, duration, peak, avg, chatters, messages, watch, subject = SUBJECT } = {}) {
    return {
        event_id: `evt_TESTSTREAM${streamId}`,
        event_type: 'live.stream.ended',
        source: 'live',
        occurred_at: endedAt,
        payload: {
            stream_id: streamId,
            channel: { username: channel, display_name: channel, url: `https://openvibe.live/@${channel}`, subject: { type: 'user', id: subject } },
            title: `Stream ${streamId}`,
            category: 'tech',
            protocol: 'webrtc',
            is_nsfw: false,
            started_at: startedAt,
            ended_at: endedAt,
            duration_seconds: duration,
            stats: { peak_viewers: peak, avg_viewers: avg, unique_chatters: chatters, messages, watch_minutes: watch },
        },
    };
}

const streams = [
    streamEnded(101, { startedAt: '2026-10-26T10:00:00.000Z', endedAt: '2026-10-26T11:00:00.000Z', duration: 3600, peak: 50, avg: 20.5, chatters: 8, messages: 120, watch: 900 }),
    streamEnded(102, { startedAt: '2026-10-27T10:00:00.000Z', endedAt: '2026-10-27T10:30:00.000Z', duration: 1800, peak: 30, avg: 10, chatters: 4, messages: 40, watch: 300 }),
];

const expectedChannel = {
    totals: { streams: 2, stream_seconds: 5400, peak_viewers: 50, unique_chatters: 12, messages: 160, watch_minutes: 1200, avg_viewers: 17 },
    daily: [
        { day: '2026-10-26', streams: 1, stream_seconds: 3600, peak_viewers: 50, unique_chatters: 8, messages: 120, watch_minutes: 900, avg_viewers: 20.5 },
        { day: '2026-10-27', streams: 1, stream_seconds: 1800, peak_viewers: 30, unique_chatters: 4, messages: 40, watch_minutes: 300, avg_viewers: 10 },
    ],
};

const billingTransactions = {
    transactions: [
        {
            id: 'txn_1', type: 'donation', status: 'settled', test: false, created_at: '2026-10-27T09:00:00.000Z',
            entries: [
                { account: { kind: 'creator_payable', owner: SUBJECT, currency: 'vibes-bits' }, amount: 500 },
                { account: { kind: 'user_credit', owner: 'usr_01J0000000000000000000000B', currency: 'vibes-bits' }, amount: -500 },
            ],
        },
        {
            id: 'txn_2', type: 'refund', status: 'settled', test: false, reverses_txn: 'txn_1', created_at: '2026-10-28T09:00:00.000Z',
            entries: [{ account: { kind: 'creator_payable', owner: SUBJECT, currency: 'vibes-bits' }, amount: -100 }],
        },
        {
            id: 'txn_3', type: 'donation', status: 'settled', test: true, created_at: '2026-10-28T09:30:00.000Z',
            entries: [{ account: { kind: 'creator_payable', owner: SUBJECT, currency: 'vibes-bits' }, amount: 999 }],
        },
    ],
};

module.exports = { NOW, DAY, DAYS, SUBJECT, stats, expected, streams, expectedChannel, billingTransactions };
