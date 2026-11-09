'use strict';
/**
 * A person's stats (the owner, 2026-11-09): /me, GET /api/v1/me/stats, the per-section publish switches, the public
 * /u/<name> page and GET /api/v1/u/:name/stats. The sources are stubbed: Network's cross-site history, Report's
 * analytics, the AI meter and session reports; the store is a real migrated PGlite, so the snapshot and the switches
 * are tested where they live.
 *
 * The rules under test: the subject is the session's and never a query value; a source that does not answer leaves its
 * section out (never a zero); a public reader sees only the published sections; a private person's API is a 404 and
 * their page is noindex; the public page carries real words, a heading, a canonical and Person JSON-LD.
 */
const assert = require('assert');
const crypto = require('crypto');
const { createSsoClient } = require('openvibe-sdk/sso');
const { boot, check, done } = require('./helpers/boot');

let contracts = null;
try {
    contracts = require('openvibe-contracts');
    contracts.resolve('report.me-stats@1');
} catch { contracts = null; }

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(claims) {
    const head = b64({ alg: 'RS256', typ: 'JWT', kid: 'test' });
    const now = Math.floor(Date.now() / 1000);
    const body = b64({ iss: 'https://openvibe.network', aud: ['openvibe.network'], iat: now, exp: now + 600, ...claims });
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
    return `${head}.${body}.${sig}`;
}
const goosely = token({ sub: '7', subject_id: 'usr_01JTESTGOOSELY0000000000000', username: 'goosely', display_name: 'Goosely' });
const quiet = token({ sub: '8', subject_id: 'usr_01JTESTQUIET00000000000000', username: 'quiet', display_name: 'Quiet' });

const NOW = Date.UTC(2026, 10, 9, 12, 0, 0); // 2026-11-09, a Monday
const viewed = [];
const analytics = {
    source: 'network',
    async channel(name) {
        if (name === 'quiet') return null;
        return {
            channel: name, days: 30,
            totals: { streams: 3, stream_seconds: 9000, peak_viewers: 41, avg_viewers: 12, unique_chatters: 9, messages: 230, watch_minutes: 2100 },
            daily: [],
            revenue: { source: 'billing', currency: 'vibes-bits', days: 30, transactions: 2, settled_bits: 1200, refunded_bits: 0 },
        };
    },
    async stats() { return null; },
    metrics: async () => null,
    reportStats: () => null,
};
const aiUsage = {
    async forPerson({ subject, from, group }) {
        viewed.push({ subject, from, group });
        if (subject.includes('QUIET')) return null;
        return {
            group, source: 'raw',
            rows: [{ key: '2026-11-08', calls: 12, cost_usd: 0.2 }, { key: '2026-11-09', calls: 9, cost_usd: 0.22 }],
            totals: { calls: 21, input_tokens: 30000, output_tokens: 18000, cached_tokens: 9000, cost_usd: 0.42, fee_usd: 0.02, charged_usd: 0.44, saved_usd: 0.01 },
            by_paid_by: { openvibe_key: { calls: 21, charged_usd: 0.44, fee_usd: 0.02 } },
            insights: ['Your calls cost $0.44, including $0.02 in fees.'],
        };
    },
};
const sessionReports = {
    async listForOwner(owner) { return [{ id: 'rps_01JTESTREPORT0000000000000', owner, created_at: '2026-11-08T10:00:00Z', task: { title: 'A session' } }]; },
    async listPublic() { return []; },
    async defaultAudience() { return 'private'; },
};

(async () => {
    const sso = createSsoClient({ site: 'report', baseUrl: 'https://openvibe.report', clientId: 'report', clientSecret: 'x', networkUrl: 'https://openvibe.network', publicKey: publicKey.export({ type: 'spki', format: 'pem' }), log: { warn() {}, info() {}, log() {}, error() {} } });
    const t = await boot({
        db: true,
        now: () => NOW,
        sso,
        analytics,
        aiUsage,
        sessionReports,
        env: { OV_NETWORK_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }) },
    });
    const auth = { cookie: `ov_token=${goosely}` };
    const publicApi = '/api/v1/u/goosely/stats';
    try {
        await check('signed out: the API is 401 and /me asks for a sign-in', async () => {
            const api = await t.get('/api/v1/me/stats');
            assert.strictEqual(api.status, 401);
            assert.strictEqual(api.json().code, 'auth.sign_in_required');
            const page = await t.get('/me');
            assert.strictEqual(page.status, 200);
            assert.strictEqual(page.headers.get('cache-control'), 'private, no-store');
            assert.ok(page.text.includes('Sign in to see yours'), 'the sign-in call to action');
            assert.match(page.text, /<meta name="robots" content="noindex, nofollow">/);
        });

        await check('signed in: one document with every section the sources answered for', async () => {
            const r = await t.get('/api/v1/me/stats?days=30', { headers: auth });
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
            const body = r.json();
            assert.strictEqual(body.person.username, 'goosely');
            assert.deepStrictEqual(body.window, { days: 30, from: '2026-10-11', to: '2026-11-09' });
            assert.deepStrictEqual(body.published, { sites: false, activity: false, made: false, ai: false, money: false });
            assert.strictEqual(body.sections.sites.month[0].service, 'live');
            assert.strictEqual(body.sections.sites.month[0].visits, 2);
            assert.strictEqual(body.sections.sites.week[0].visits, 2);
            assert.ok(body.sections.sites.top.length <= 8);
            assert.strictEqual(body.sections.activity.weeks.length, 12);
            assert.strictEqual(body.sections.activity.weeks[11].days.length, 7);
            assert.strictEqual(body.sections.activity.streak_days, 3, 'the 9th, 8th and 7th have history');
            assert.strictEqual(body.sections.ai.calls, 21);
            assert.strictEqual(body.sections.ai.tokens, 48000);
            assert.strictEqual(body.sections.money.settled_bits, 1200);
            assert.strictEqual(body.sections.money.transactions, 2);
            assert.ok(body.sections.made.items.some((i) => i.key === 'streams' && i.count === 3));
            assert.ok(body.sections.made.items.some((i) => i.key === 'agent_reports' && i.count === 1));
            assert.strictEqual(viewed[viewed.length - 1].subject, 'usr_01JTESTGOOSELY0000000000000', 'the session subject, not a query');
            if (contracts) {
                const v = contracts.validate('report.me-stats@1', body);
                assert.ok(v.valid, `report.me-stats@1: ${JSON.stringify(v.errors)}`);
            }
        });

        await check('/me: real words, a heading, each section, the switches and the numbers as text', async () => {
            const r = await t.get('/me?days=30', { headers: auth });
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
            assert.match(r.text, /<meta name="robots" content="noindex, nofollow">/);
            for (const words of ['Make my stats public', 'Sites you used', 'Your activity', 'Things you made', 'Your AI', 'Vibes', 'Visits, 30 days', 'Visits by day, last twelve weeks', 'Live', 'Community', 'Chat']) {
                assert.ok(r.text.includes(words), `the page says ${words}`);
            }
            assert.ok(r.text.includes('Only you'), 'each switch says its private state');
            assert.ok(r.text.includes('action="/api/v1/me/stats/published"'), 'the publish form');
            assert.ok(r.text.includes('aria-label="Visits a week'), 'the chart carries its numbers for screen readers');
            assert.ok(r.text.includes('href="/api/v1/me/stats?days=30"'), 'the JSON link');
        });

        await check('a source that does not answer leaves its section out, never a zero', async () => {
            const direct = await t.ctx.meStats.compute({ user: { subject_id: 'usr_01JTESTQUIET00000000000000', username: 'quiet', display_name: 'Quiet' }, token: null, days: 7 });
            assert.ok(!direct.sections.sites && !direct.sections.activity, 'no history: no sites and no activity');
            assert.ok(!direct.sections.ai, 'no AI meter: no AI section');
            assert.ok(direct.note && /Network|analytics/.test(direct.note), 'the note says what did not answer');
        });

        await check('the switches: a JSON PUT sets the five public choices', async () => {
            const r = await t.get('/api/v1/me/stats?days=30', { headers: auth });
            assert.strictEqual(r.status, 200);
            const all = r.json();
            assert.ok(all.sections.ai, 'the owner sees AI');
            const put = await t.get('/api/v1/me/stats/published', {
                method: 'PUT',
                headers: { ...auth, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
                json: { published: { sites: true, activity: true, made: false, ai: false, money: false } },
            });
            assert.strictEqual(put.status, 200, put.text);
            const body = put.json();
            assert.deepStrictEqual(body.published, { sites: true, activity: true, made: false, ai: false, money: false });
            assert.ok(body.sections.sites && body.sections.activity);
            assert.ok(body.sections.ai && body.sections.money && body.sections.made, 'the owner still sees the sections they kept private');
        });

        await check('the public API and page carry only the published sections', async () => {
            const api = await t.get(publicApi);
            assert.strictEqual(api.status, 200);
            const body = api.json();
            assert.deepStrictEqual(body.published, { sites: true, activity: true, made: false, ai: false, money: false });
            assert.ok(body.sections.sites && body.sections.activity);
            assert.ok(!body.sections.ai && !body.sections.money && !body.sections.made, 'a stranger never sees an unpublished section');
            if (contracts) assert.ok(contracts.validate('report.me-stats@1', body).valid);
            const page = await t.get('/u/goosely');
            assert.strictEqual(page.status, 200);
            assert.match(page.text, /<meta name="robots" content="index, follow">/);
            assert.ok(page.text.includes('Goosely’s OpenVibe') || page.text.includes('Goosely\'s OpenVibe'));
            assert.ok(page.text.includes('"@type":"Person"'), 'Person JSON-LD');
            assert.ok(page.text.includes('canonical" href="https://openvibe.report/u/goosely"'));
            assert.ok(page.text.includes('Sites used') && page.text.includes('Activity'));
            assert.ok(!page.text.includes('Your AI') && !page.text.includes('Things made'), 'unpublished sections are absent');
            assert.ok(page.text.includes('Published'), 'the snapshot is dated');
        });

        await check('a private person: the API is a 404 and the page is a noindex notice', async () => {
            const put = await t.get('/api/v1/me/stats/published', {
                method: 'PUT',
                headers: { ...auth, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
                json: { published: { sites: false, activity: false, made: false, ai: false, money: false } },
            });
            assert.strictEqual(put.status, 200);
            const api = await t.get(publicApi);
            assert.strictEqual(api.status, 404);
            assert.strictEqual(api.json().code, 'report.person_stats_not_found');
            const page = await t.get('/u/goosely');
            assert.strictEqual(page.status, 200);
            assert.match(page.text, /<meta name="robots" content="noindex, nofollow">/);
            assert.ok(page.text.includes('keeps their numbers private'));
            assert.ok(!page.text.includes('Visits, 30 days'), 'no numbers on a private page');
            const unknown = await t.get('/u/nobody');
            assert.strictEqual(unknown.status, 404);
        });

        await check('the page form saves all five switches, then /me shows them', async () => {
            const body = 'sites=true&activity=true&made=true&ai=true&money=true';
            const post = await t.get('/api/v1/me/stats/published', {
                method: 'POST',
                headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
                body,
            });
            assert.strictEqual(post.status, 303);
            assert.strictEqual(post.headers.get('location'), '/me');
            const page = await t.get('/u/goosely');
            assert.ok(page.text.includes('Things made') && page.text.includes('id="rp-u-ai"') && page.text.includes('Vibes'), 'all five published');
            const me = await t.get('/me', { headers: auth });
            assert.ok(me.text.includes('Public now'));
            const sitemap = await t.get('/sitemap.xml');
            assert.ok(sitemap.text.includes('https://openvibe.report/u/goosely'), 'the public page is in the sitemap');
        });

        await check('the switches are same-origin and the person is never taken from the query', async () => {
            const cross = await t.get('/api/v1/me/stats/published', {
                method: 'PUT',
                headers: { ...auth, 'content-type': 'application/json' },
                json: { published: { sites: true, activity: true, made: true, ai: true, money: true } },
            });
            assert.strictEqual(cross.status, 403);
            const bad = await t.get('/api/v1/me/stats/published', {
                method: 'PUT',
                headers: { ...auth, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
                json: { published: { sites: true } },
            });
            assert.strictEqual(bad.status, 422);
            const other = await t.get('/api/v1/me/stats?subject=usr_01JTESTGOOSELY0000000000000', { headers: { cookie: `ov_token=${quiet}` } });
            assert.strictEqual(other.json().person.username, 'quiet');
            assert.strictEqual(viewed[viewed.length - 1].subject, 'usr_01JTESTQUIET00000000000000');
        });
    } finally {
        await t.close();
    }
    done();
})().catch((err) => { console.error(err); process.exit(1); });
