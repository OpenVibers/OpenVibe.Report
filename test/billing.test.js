'use strict';

/**
 * Billing's read API: network money counts (billing.stats.read) and one subject's settled creator_payable
 * entries (billing.balance.read). The stub checks the URL and the service bearer token; Report only sums the
 * amounts Billing returned, and excludes test rows.
 */
const assert = require('assert');
const { createBillingClient } = require('../server/data/billing');
const { SUBJECT, NOW, billingTransactions } = require('./fixtures/analytics');
const { check, done } = require('./helpers/boot');

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

(async () => {
    await check('a channel revenue read uses Billing\'s transactions endpoint and bearer capability', async () => {
        const calls = [];
        const client = createBillingClient({
            config: { billing: { url: 'http://billing.test', token: 'test-billing-token', timeoutMs: 1000 } },
            fetchImpl: async (url, opts) => {
                calls.push({ url: String(url), auth: opts.headers.Authorization });
                return json(billingTransactions);
            },
            now: () => NOW,
        });
        const revenue = await client.revenue({ subject: SUBJECT, days: 7, now: NOW });
        assert.deepStrictEqual(revenue, {
            source: 'billing', capability: 'billing.balance.read', subject: SUBJECT, days: 7, currency: 'vibes-bits',
            as_of: new Date(NOW).toISOString(), settled_bits: 500, refunded_bits: 100, net_bits: 400, transactions: 2,
        });
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].url, `http://billing.test/api/v1/transactions?subject=${encodeURIComponent(SUBJECT)}&limit=200`);
        assert.strictEqual(calls[0].auth, 'Bearer test-billing-token');
        assert.deepStrictEqual(client.capabilities, ['billing.stats.read', 'billing.balance.read']);
    });

    await check('network money counts come from GET /api/v1/stats as Billing answers them', async () => {
        const body = { as_of: new Date(NOW).toISOString(), purchases: { bits_total: 1000, windows: { d: 10, w: 100, m: 200, pw: 50 }, series: [] }, subscriptions: { active: 3, windows: { d: 0, w: 1, m: 2, pw: 1 }, series: [] } };
        const urls = [];
        const client = createBillingClient({
            config: { billing: { url: 'http://billing.test', token: 't' } },
            fetchImpl: async (url) => { urls.push(String(url)); return json(body); },
        });
        const got = await client.stats(7);
        assert.deepStrictEqual(got, { ...body, source: 'billing' });
        assert.deepStrictEqual(urls, ['http://billing.test/api/v1/stats?days=7']);
    });

    await check('no token and no OAuth client means null, and no request is made', async () => {
        let calls = 0;
        const client = createBillingClient({ config: { billing: { url: 'http://billing.test' } }, fetchImpl: async () => { calls++; return json({}); } });
        assert.strictEqual(await client.revenue({ subject: SUBJECT, days: 7, now: NOW }), null);
        assert.strictEqual(await client.stats(7), null);
        assert.strictEqual(calls, 0);
    });

    done();
})().catch((e) => { console.error(e); process.exit(1); });
