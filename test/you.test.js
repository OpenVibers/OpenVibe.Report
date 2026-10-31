'use strict';
/**
 * You (plan L41 R1): a person's own numbers. Signed out, /you says what it is and offers a sign-in; signed in, it
 * reads their own channel's numbers, after-show reports, Billing's payment count and The Rundown, leads with one
 * sentence, and is never cached or indexed. Another person's token never shows someone else's numbers; a service's
 * token is not a session. Sign-in itself is openvibe-sdk/sso at /auth.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createSsoClient } = require('openvibe-sdk/sso');
const { boot, check, done } = require('./helpers/boot');

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(claims) {
    const head = b64({ alg: 'RS256', typ: 'JWT', kid: 'test' });
    const now = Math.floor(Date.now() / 1000);
    const body = b64({ iss: 'https://openvibe.network', aud: ['openvibe.network'], iat: now, exp: now + 600, ...claims });
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
    return `${head}.${body}.${sig}`;
}
const goosely = token({ sub: '7', subject_id: 'usr_01JTESTGOOSELY0000000000000', username: 'goosely', display_name: 'goosely' });

(async () => {
    const asked = [];
    const analytics = {
        source: 'network',
        async channel(name, days) {
            asked.push([name, days]);
            return {
                channel: name, days, totals: { streams: 3, stream_seconds: 3 * 3600, peak_viewers: 41, avg_viewers: 12, unique_chatters: 9, messages: 230, watch_minutes: 2100 },
                daily: [{ day: '2026-10-29', watch_minutes: 900 }, { day: '2026-10-30', watch_minutes: 1200 }],
                streams: [], revenue: { days, transactions: 2, refunded_bits: 0 },
            };
        },
        stats: async () => null, metrics: async () => null, reportStats: () => null,
    };
    const sso = createSsoClient({ site: 'report', baseUrl: 'https://openvibe.report', clientId: 'report', clientSecret: 'x', networkUrl: 'https://openvibe.network', publicKey: publicKey.export({ type: 'spki', format: 'pem' }), log: { warn() {}, info() {}, log() {}, error() {} } });
    // The AI ledger (plan L40/L41), answered by hand: the rows of the person the session names.
    const aiAsked = [];
    const aiUsage = {
        async forPerson({ subject, from, group }) {
            aiAsked.push({ subject, from, group });
            return {
                group, source: 'raw',
                rows: [{ key: '2026-10-30', calls: 1, cost_usd: 0.05 }, { key: '2026-10-31', calls: 2, cost_usd: 0.002 }],
                totals: { calls: 3, input_tokens: 1250, output_tokens: 590, cached_tokens: 800, cost_usd: 0.0531, fee_usd: 0.01, charged_usd: 0.06, saved_usd: 0.0017 },
                by_paid_by: { own_key: { calls: 2, charged_usd: 0, fee_usd: 0 }, openvibe_key: { calls: 1, charged_usd: 0.06, fee_usd: 0.01 } },
                insights: ['67% of your calls ran on your own keys, so no fee on those.', 'Your calls cost $0.06, including $0.01 in fees.'],
            };
        },
    };
    const t = await boot({ sso, analytics, aiUsage });
    try {
        await check('signed out: what it is, a sign-in back to /you, private and not indexed', async () => {
            const r = await t.get('/you');
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
            assert.match(r.text, /<meta name="robots" content="noindex, nofollow">/);
            assert.ok(r.text.includes('Everything you do on OpenVibe, counted for you'));
            assert.ok(r.text.includes('href="/auth/login?next=%2Fyou"'));
            assert.strictEqual(asked.length, 0, 'nothing is read for nobody');
        });

        await check('signed in: their own numbers, a sentence first, then streams, money and The Rundown', async () => {
            const r = await t.get('/you?days=7', { headers: { cookie: `ov_token=${goosely}` } });
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
            assert.deepStrictEqual(asked[asked.length - 1], ['goosely', 7], 'their own channel, the asked window');
            const html = r.text;
            assert.ok(html.includes('In the last 7 days, goosely, you streamed 3 times for 3 h, with up to 41 viewers at once, drew 230 chat messages from 9 people, received 2 payments in Vibes and were written up in The Rundown 1 time.'), 'the sentence');
            assert.ok(html.includes('<h2 id="rp-you-st">Your streams</h2>') && html.includes('Most at once'));
            assert.ok(html.includes('href="/after-show/7"'), 'their after-show reports');
            assert.ok(html.includes('2 payments in Vibes reached you') && html.includes('https://billing.openvibe.network/'), 'money says where the amounts are');
            assert.ok(html.includes('<h2 id="rp-you-rd">In The Rundown</h2>') && html.includes('href="/rundown/t/seattle"'));
            assert.ok(html.includes('aria-current="page">7 days'));
            // Your AI (L40/L41): the person's own ledger, by the session's subject, never a query value.
            assert.deepStrictEqual(aiAsked[aiAsked.length - 1].subject, 'usr_01JTESTGOOSELY0000000000000', 'the session\'s own subject');
            assert.strictEqual(aiAsked[aiAsked.length - 1].from, new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10), 'the window asked for');
            assert.ok(html.includes('<h2 id="rp-you-ai">Your AI</h2>'));
            assert.ok(html.includes('67% of your calls ran on your own keys, so no fee on those.'), 'the first insight leads');
            assert.ok(html.includes('>From cache<') && html.includes('>39%<'), 'the share from cache: 800 of 2,050 input tokens');
            assert.ok(html.includes('<b>Your own keys</b> 2 calls'), 'who paid, in words');
            assert.ok(html.includes('<b>The OpenVibe key</b> 1 call') && html.includes('incl. $0.01 fee'));
            assert.ok(html.includes('href="https://ai.openvibe.services/you"'), 'where the keys are');
            const before = await t.get('/you?days=7&subject=usr_01JSOMEONEELSE00000000000000', { headers: { cookie: `ov_token=${goosely}` } });
            assert.strictEqual(before.status, 200);
            assert.strictEqual(aiAsked[aiAsked.length - 1].subject, 'usr_01JTESTGOOSELY0000000000000', 'a subject in the address changes nothing');
            const pagesSrc = fs.readFileSync(path.join(__dirname, '..', 'server/http/pages.js'), 'utf8');
            assert.match(pagesSrc, /ctx\.aiUsage\.forPerson\(\{ subject, from, group: 'day' \}\)/, 'the page reads the ledger in-process, by the session\'s subject');
        });

        await check('only the parts with something in them: no streams or money, just The Rundown', async () => {
            const quiet = token({ sub: '8', subject_id: 'usr_01JTESTQUIET00000000000000', username: 'quiet', display_name: 'Quiet' });
            analytics.channel = async () => null;
            const r = await t.get('/you', { headers: { cookie: `ov_token=${quiet}` } });
            assert.ok(r.text.includes('In the last 30 days, Quiet, you were written up in The Rundown 1 time.'));
            assert.ok(!r.text.includes('Most at once') && !r.text.includes('id="rp-you-mo"'), 'no tiles without numbers, no money without payments');
        });

        await check('someone with nothing yet gets a plain sentence', async () => {
            const views = require('../server/views');
            const html = views.you({ user: { username: 'new', display_name: 'New' }, days: 30 });
            assert.ok(html.includes('Nothing to count for you in the last 30 days yet. Go live, and every stream gets its own report here.'));
        });

        await check('a service token or a forged one is not a session', async () => {
            const svc = token({ sub: 'svc:live', actor_type: 'service', username: 'goosely' });
            assert.ok((await t.get('/you', { headers: { cookie: `ov_token=${svc}` } })).text.includes('Sign in to see yours'));
            const forged = goosely.slice(0, -4) + 'AAAA';
            assert.ok((await t.get('/you', { headers: { cookie: `ov_token=${forged}` } })).text.includes('Sign in to see yours'));
        });

        await check('sign-in lives at /auth, and the navbar knows it', async () => {
            const login = await t.get('/auth/login?next=/you');
            assert.strictEqual(login.status, 302);
            assert.match(login.headers.get('location'), /^https:\/\/openvibe\.network\/oauth\/authorize\?.*client_id=report/);
            const page = await t.get('/stats');
            assert.ok(page.text.includes('"loginUrl":"/auth/login?next={path}"') && page.text.includes('"href":"/you"'));
            assert.strictEqual(page.headers.get('cache-control'), 'public, max-age=120', 'public pages stay public');
        });
    } finally {
        await t.close();
    }
    done();
})().catch((err) => { console.error(err); process.exit(1); });
