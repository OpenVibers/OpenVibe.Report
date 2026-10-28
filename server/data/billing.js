'use strict';

/**
 * OpenVibe.Billing's read API. Report never computes money: it quotes the amounts Billing returns.
 *
 *   GET /api/v1/stats?days=N          billing.stats.read      network-wide purchases and subscriptions
 *   GET /api/v1/transactions?subject= billing.balance.read    one subject's entries, for a channel's settled
 *                                                             revenue and refunds (creator_payable, vibes-bits)
 *
 * A service token is used. When OV_OAUTH_CLIENT_ID / OV_OAUTH_CLIENT_SECRET are set, Report asks Network's token
 * endpoint for the audience openvibe.billing; REPORT_BILLING_TOKEN is an explicit alternative for an operator
 * run. Unset means the revenue part is null, never zero.
 */
const { createServiceTokenClient } = require('openvibe-sdk/auth');
const { trim, warn, TIMEOUT_MS } = require('./source');

const DEFAULTS = { url: 'http://127.0.0.1:4600', timeoutMs: 5000 };
const CAPABILITIES = ['billing.stats.read', 'billing.balance.read'];
const DAY = 86_400_000;

const n = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

function createBillingClient({ config = {}, fetchImpl = globalThis.fetch, log = console, now = () => Date.now(), tokenProvider = null, timeoutMs } = {}) {
    const cfg = config.billing || {};
    const baseUrl = trim(cfg.url || config.billingUrl || DEFAULTS.url);
    const deadline = timeoutMs || cfg.timeoutMs || DEFAULTS.timeoutMs;
    let tokenClient = null;
    if (!tokenProvider && !cfg.token && config.oauth && config.oauth.clientId && config.oauth.clientSecret) {
        try {
            tokenClient = createServiceTokenClient({
                network: config.networkPublicUrl || config.networkUrl || 'https://openvibe.network',
                tokenUrl: config.oauth.tokenUrl,
                clientId: config.oauth.clientId,
                clientSecret: config.oauth.clientSecret,
                audience: 'openvibe.billing',
                scope: CAPABILITIES,
                fetch: fetchImpl,
                now,
            });
        } catch { tokenClient = null; }
    }

    async function token() {
        if (tokenProvider) return await tokenProvider();
        if (cfg.token) return cfg.token;
        if (!tokenClient) return null;
        try { return await tokenClient.getToken({ audience: 'openvibe.billing' }); } catch (err) {
            warn(log, `billing token failed: ${(err && err.message) || 'no token'}`);
            return null;
        }
    }

    async function get(path) {
        const auth = await token();
        if (!auth) return null;
        let res;
        try {
            res = await fetchImpl(`${baseUrl}${path}`, {
                headers: { Accept: 'application/json', Authorization: `Bearer ${auth}` },
                signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(deadline) : undefined,
            });
        } catch (err) {
            warn(log, `billing ${path.split('?')[0]} failed: ${(err && err.message) || 'no response'}`);
            return null;
        }
        if (!res || !res.ok) {
            if (!res || res.status !== 404) warn(log, `billing ${path.split('?')[0]} failed: HTTP ${res ? res.status : 'no response'}`);
            return null;
        }
        try { return await res.json(); } catch (err) { warn(log, `billing ${path.split('?')[0]} failed: ${(err && err.message) || 'bad JSON'}`); return null; }
    }

    /** Network-wide money counts, exactly as Billing answers them. */
    async function stats(days = 30) {
        const d = Math.min(Math.max(parseInt(days, 10) || 30, 1), 90);
        const body = await get(`/api/v1/stats?days=${d}`);
        return body ? { ...body, source: 'billing' } : null;
    }

    /**
     * One channel's settled revenue and refunds, read from Billing's transaction history. The sums are of Billing's
     * own `creator_payable` entries; Report never derives a price, a fee or a rate.
     */
    async function revenue({ subject, days = 30, now: at = now() } = {}) {
        if (!subject) return null;
        const d = Math.min(Math.max(parseInt(days, 10) || 30, 1), 365);
        const since = at - d * DAY;
        let settledBits = 0;
        let refundedBits = 0;
        let transactions = 0;
        let cursor = null;
        for (let page = 0; page < 20; page++) {
            const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
            const body = await get(`/api/v1/transactions?subject=${encodeURIComponent(subject)}&limit=200${suffix}`);
            if (!body || !Array.isArray(body.transactions)) return null;
            for (const txn of body.transactions) {
                if (!txn || txn.test === true) continue;
                const created = Date.parse(txn.created_at || '');
                if (!Number.isFinite(created) || created < since) continue;
                const refundLike = txn.type === 'refund' || txn.type === 'chargeback' || !!txn.reverses_txn;
                const earning = txn.type === 'donation' || txn.type === 'subscription' || txn.type === 'subscription_share';
                let seen = false;
                for (const e of Array.isArray(txn.entries) ? txn.entries : []) {
                    if (!e || !e.account || e.account.kind !== 'creator_payable' || e.account.currency !== 'vibes-bits') continue;
                    const amount = n(e.amount);
                    if (amount == null) continue;
                    seen = true;
                    if (amount > 0 && earning) settledBits += amount;
                    else if (amount < 0 && refundLike) refundedBits += -amount;
                }
                if (seen) transactions++;
            }
            cursor = body.next_cursor || null;
            if (!cursor) break;
        }
        return finish();
        function finish() {
            return {
                source: 'billing', capability: 'billing.balance.read', subject, days: d, currency: 'vibes-bits',
                as_of: new Date(at).toISOString(), settled_bits: settledBits, refunded_bits: refundedBits,
                net_bits: settledBits - refundedBits, transactions,
            };
        }
    }

    return { stats, revenue, baseUrl, capabilities: CAPABILITIES, ttlMs: deadline, get };
}

module.exports = { createBillingClient, CAPABILITIES, DEFAULTS, TIMEOUT_MS };
