'use strict';
/**
 * You (plan L41 R1): a person's own numbers. Signed out, /you says what it is and offers a sign-in; signed in, it
 * reads their own channel's numbers, after-show reports, Billing's payment count and The Rundown, leads with one
 * sentence, and is never cached or indexed. Another person's token never shows someone else's numbers; a service's
 * token is not a session. Sign-in itself is openvibe-sdk/sso at /auth.
 */
const assert = require('assert');
const crypto = require('crypto');
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
    const t = await boot({ sso, analytics });
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
            assert.ok(html.includes('whose key paid'), 'what joins next (L40)');
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
