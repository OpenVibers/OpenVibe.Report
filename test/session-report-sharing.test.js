'use strict';
/**
 * Who sees a session report (design 2026-11-06, "Report: session reports"): the owner chooses one of the sharing
 * system's four audiences, and every read path asks the share row.
 *
 *   node test/session-report-sharing.test.js
 *
 * What this proves:
 *   - the four audiences on the page and the API, for the owner, a person on the list, another signed-in person and
 *     someone signed out: Everyone and the link open for all; Specific people and Only me are a 404 for the last two,
 *     the same 404 a missing report gets, so nothing hints that it exists;
 *   - a report that leaves Everyone leaves the lists, the sitemap and Search at once;
 *   - the owner's default for new reports, and that the old visibility column still says what an older release reads;
 *   - the backfill maps private/unlisted/public to Only me/the link/Everyone, is idempotent, and never overrules an
 *     audience the owner chose;
 *   - the after-show cache: Live's public header decides, a 404 is a miss, and no stale copy is served.
 */
const assert = require('assert');
const crypto = require('crypto');
const { createSsoClient } = require('openvibe-sdk/sso');
const { boot, check, done } = require('./helpers/boot');
const sharing = require('../server/sharing');
const { plan, backfill } = require('../scripts/backfill-session-shares');

const OWNER = 'usr_7M1EV8N2FW9P3GXAQ4HYBR5JZC';
const FRIEND = 'usr_EV8N2FW9P3GXAQ4HYBR5JZCS6K';
const STRANGER = 'usr_N2FW9P3GXAQ4HYBR5JZCS6K0DT';
const OTHER_OWNER = 'usr_W9P3GXAQ4HYBR5JZCS6K0DT7M1';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(claims) {
    const head = b64({ alg: 'RS256', typ: 'JWT', kid: 'test' });
    const at = Math.floor(Date.now() / 1000);
    const body = b64({ iss: 'https://openvibe.network', aud: ['openvibe.network'], iat: at, exp: at + 600, ...claims });
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
    return `${head}.${body}.${sig}`;
}
const asOwner = token({ sub: '7', subject_id: OWNER, username: 'goosely', display_name: 'goosely' });
const asFriend = token({ sub: '8', subject_id: FRIEND, username: 'friend', display_name: 'friend' });
const asStranger = token({ sub: '9', subject_id: STRANGER, username: 'stranger', display_name: 'stranger' });
const cookie = (t) => ({ cookie: `ov_token=${t}` });

function body(over = {}) {
    return {
        owner: OWNER,
        source: 'codes',
        task: { title: 'Ship the checkout page', ref: 'tsk_01JAN2C3D4E5F6G7H8J9K0MNPS' },
        started_at: '2026-11-06T18:00:00.000Z',
        ended_at: '2026-11-06T18:42:00.000Z',
        worked_seconds: 2520,
        outcome: 'done',
        summary: 'Asked for a checkout page; the agent built it and ran the tests.',
        timeline: [{ at: '2026-11-06T18:20:00.000Z', title: 'Run the tests', status: 'passed' }],
        outputs: [],
        proof: { tests: { passed: 12, failed: 0 }, screenshots: [], review: null },
        cost_usd: 0.31,
        models: ['claude-sonnet-4'],
        highlights: [],
        visibility: 'private',
        ...over,
    };
}

/** The person Network's identity lookups know, and the key directory's answers for them. */
function identityNetwork() {
    const people = {
        friend: { subject: { type: 'user', id: FRIEND }, username: 'friend', display_name: 'friend', banned: false, deleted: false },
        stranger: { subject: { type: 'user', id: STRANGER }, username: 'stranger', display_name: 'stranger', banned: false, deleted: false },
        goosely: { subject: { type: 'user', id: OWNER }, username: 'goosely', display_name: 'goosely', banned: false, deleted: false },
    };
    return {
        async json({ path: p, method, query, json }) {
            if (p === '/internal/identity/resolve') {
                const found = people[String((query && query.username) || '').toLowerCase()];
                if (!found) { const err = new Error('not found'); err.status = 404; throw err; }
                return found;
            }
            if (p === '/internal/identity/resolve-batch') {
                const results = {};
                for (const id of (json && json.subject_ids) || []) {
                    const found = Object.values(people).find((x) => x.subject.id === id);
                    results[id] = found || null;
                }
                return { results };
            }
            if (/^\/api\/v1\/people\/.+\/keys$/.test(p)) { const err = new Error('no locker'); err.status = 404; throw err; }
            const err = new Error('no such route ' + p);
            err.status = 404;
            throw err;
        },
    };
}

(async () => {
    const verifyServiceToken = async () => ({ ok: true, claims: { sub: 'svc:codes', cap: ['report.session.write'], aud: ['openvibe.report'] } });
    const sso = createSsoClient({
        site: 'report', baseUrl: 'https://openvibe.report', clientId: 'report', clientSecret: 'x',
        networkUrl: 'https://openvibe.network', publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
        log: { warn() {}, info() {}, log() {}, error() {} },
    });
    const t = await boot({ db: true, sso, verifyServiceToken, shareNetwork: identityNetwork(), now: () => Date.parse('2026-11-06T20:00:00Z') });
    const db = t.ctx.store.db;
    const write = async (over) => {
        const r = await t.get('/internal/session-reports', { json: body(over), headers: { authorization: 'Bearer good' } });
        assert.strictEqual(r.status, 201, r.text.slice(0, 200));
        return r.json().id;
    };
    const setShare = async (id, input, as = asOwner) => {
        const r = await t.get(`/api/v1/session-report/${id}/share`, {
            method: 'PUT', json: input, headers: { ...cookie(as), 'x-requested-with': 'ov-share' },
        });
        assert.strictEqual(r.status, 200, r.text.slice(0, 300));
        return r.json();
    };
    const audienceOf = (id) => db.maybe('SELECT audience FROM shares WHERE service = $1 AND kind = $2 AND resource_id = $3', ['report', 'session-report', id]).then((r) => r && r.audience);

    try {
        await check('a new report is Only me by default, in the share row and in the old column', async () => {
            const id = await write({});
            assert.strictEqual(await audienceOf(id), 'private', 'the share row says Only me');
            const row = await db.maybe('SELECT visibility FROM report_sessions WHERE id = $1', [id]);
            assert.strictEqual(row.visibility, 'private', 'the old column is still written for N-1');
            const page = await t.get('/s/' + id, { headers: cookie(asOwner) });
            assert.strictEqual(page.status, 200, 'the owner opens their own report');
            assert.ok(page.text.includes('Only you can open this report'), 'the owner sees the audience');
        });

        await check('Everyone: the page and the API open for all four viewers, cached only for a signed-out reader', async () => {
            const id = await write({ task: { title: 'Everyone one', ref: 'tsk_everyone' }, visibility: 'public' });
            assert.strictEqual(await audienceOf(id), 'public');
            for (const [who, headers] of [['owner', cookie(asOwner)], ['friend', cookie(asFriend)], ['stranger', cookie(asStranger)], ['signed out', {}]]) {
                const page = await t.get('/s/' + id, { headers });
                assert.strictEqual(page.status, 200, `the page opens for the ${who}`);
                // Only the signed-out copy may enter a shared cache: a signed-in page carries that reader's own parts,
                // and Cloudflare on our zones ignores Vary and Authorization.
                const expected = who === 'signed out' ? 'public, max-age=120' : 'private, no-store';
                assert.strictEqual(page.headers.get('cache-control'), expected, `the ${who} page's cache policy`);
                assert.match(page.text, /<meta name="robots" content="index, follow">/);
                const api = await t.get('/api/v1/session-reports/' + id, { headers });
                assert.strictEqual(api.status, 200, `the API answers the ${who}`);
                assert.strictEqual(api.headers.get('cache-control'), expected, `the ${who} API answer's cache policy`);
                assert.strictEqual(api.json().audience, 'public');
            }
            const ownerPage = await t.get('/s/' + id, { headers: cookie(asOwner) });
            assert.ok(ownerPage.text.includes('data-ov-share-sheet') && ownerPage.text.includes('data-kind="session-report"') && ownerPage.text.includes(`data-id="${id}"`), 'the owner gets the access sheet');
            assert.ok(ownerPage.text.includes('Everyone can open this report'));
            const strangerPage = await t.get('/s/' + id, { headers: cookie(asStranger) });
            assert.ok(strangerPage.text.includes(`data-url="https://openvibe.report/s/${id}"`), 'everyone else gets the link part of the sheet');
            assert.ok(!strangerPage.text.includes('data-kind="session-report"'), 'and never the access part');
        });

        await check('a shared cache never receives the owner\'s copy of a public report', async () => {
            const id = await write({ task: { title: 'Shared with a few', ref: 'tsk_shared_cache' }, visibility: 'public' });
            await setShare(id, { audience: 'people', members: [{ name: 'friend', role: 'viewer' }] });
            await setShare(id, { audience: 'public' });
            const friend = await db.maybe('SELECT subject FROM share_members WHERE resource_id = $1', [id]);
            const friendId = friend && friend.subject && friend.subject.id;
            assert.strictEqual(friendId, FRIEND, 'the report is shared with someone, so the owner\'s page has a list to leak');

            // The owner's page names the Share sheet's kind and id and says who else may open it: a shared cache must
            // never store it, whatever header the reader's own browser would accept.
            const ownerPage = await t.get('/s/' + id, { headers: cookie(asOwner) });
            assert.strictEqual(ownerPage.status, 200);
            assert.strictEqual(ownerPage.headers.get('cache-control'), 'private, no-store', 'the owner\'s page is private, no-store');
            assert.ok(ownerPage.text.includes('data-kind="session-report"') && ownerPage.text.includes(`data-id="${id}"`));
            assert.ok(ownerPage.text.includes('Everyone can open this report'));

            // The signed-out copy is the only one a shared cache may keep, and it carries none of that.
            const anon = await t.get('/s/' + id);
            assert.strictEqual(anon.status, 200);
            assert.strictEqual(anon.headers.get('cache-control'), 'public, max-age=120', 'a signed-out reader\'s copy is the cacheable one');
            assert.ok(!anon.text.includes('data-kind="session-report"'), 'no access sheet for a signed-out reader');
            assert.ok(!anon.text.includes(`data-id="${id}"`), 'and never the owner\'s report id as a sheet target');
            assert.ok(!/can open this report/.test(anon.text), 'no audience line, so no member count');
            assert.ok(!anon.text.includes(FRIEND), 'and no member id anywhere in the page');
            assert.ok(!/You and \d+ other/.test(anon.text) && !/You and \d+ people/.test(anon.text), 'and no "You and N" line');
            // The signed-in reader who is not the owner gets their own private copy too: the page is never the owner's.
            assert.strictEqual((await t.get('/s/' + id, { headers: cookie(asStranger) })).headers.get('cache-control'), 'private, no-store');
            // The list and the owner's own page are private as well.
            assert.strictEqual((await t.get('/api/v1/session-reports', { headers: cookie(asOwner) })).headers.get('cache-control'), 'private, no-store');
            assert.strictEqual((await t.get('/api/v1/session-reports')).headers.get('cache-control'), 'public, max-age=120', 'a signed-out list is the public one');
            assert.strictEqual((await t.get('/you', { headers: cookie(asOwner) })).headers.get('cache-control'), 'private, no-store');
            assert.strictEqual((await t.get('/rundown')).headers.get('cache-control'), 'public, max-age=120', 'the Rundown carries only public cards, so it stays cacheable');
        });

        await check('Anyone with the link: opens for all four, never listed, cached private and not indexed', async () => {
            const id = await write({ task: { title: 'Link one', ref: 'tsk_link' }, visibility: 'unlisted' });
            assert.strictEqual(await audienceOf(id), 'link');
            for (const [who, headers] of [['owner', cookie(asOwner)], ['friend', cookie(asFriend)], ['stranger', cookie(asStranger)], ['signed out', {}]]) {
                const page = await t.get('/s/' + id, { headers });
                assert.strictEqual(page.status, 200, `the page opens for the ${who}`);
                assert.strictEqual(page.headers.get('cache-control'), 'private, no-store', `the ${who} page is not cached`);
                assert.match(page.text, /<meta name="robots" content="noindex, nofollow">/);
                assert.strictEqual((await t.get('/api/v1/session-reports/' + id, { headers })).status, 200);
            }
            const listed = await t.ctx.sessionReports.listPublic({ limit: 50 });
            assert.ok(!listed.some((r) => r.id === id), 'a link report is not in any list');
            assert.ok(!(await t.get('/sitemap.xml')).text.includes('/s/' + id), 'and not in the sitemap');
        });

        await check('Specific people: the owner and the people on the list, a 404 that says nothing for anyone else', async () => {
            const id = await write({ task: { title: 'People one', ref: 'tsk_people' } });
            const saved = await setShare(id, { audience: 'people', members: [{ name: 'friend', role: 'viewer' }] });
            assert.strictEqual(saved.audience, 'people');
            assert.strictEqual(saved.members.length, 1);
            assert.strictEqual(await audienceOf(id), 'people');

            const owner = await t.get('/s/' + id, { headers: cookie(asOwner) });
            assert.strictEqual(owner.status, 200);
            assert.ok(owner.text.includes('You and 1 other person can open this report'), 'the owner sees who else');
            assert.ok(owner.text.includes('People one'));
            assert.strictEqual((await t.get('/api/v1/session-reports/' + id, { headers: cookie(asOwner) })).status, 200);

            const friend = await t.get('/s/' + id, { headers: cookie(asFriend) });
            assert.strictEqual(friend.status, 200, 'a person on the list opens it');
            assert.strictEqual(friend.headers.get('cache-control'), 'private, no-store');
            assert.ok(!friend.text.includes('data-kind="session-report"'), 'and does not get the owner\'s sheet');
            const friendApi = await t.get('/api/v1/session-reports/' + id, { headers: cookie(asFriend) });
            assert.strictEqual(friendApi.status, 200);
            assert.strictEqual(friendApi.json().audience, 'people');

            const missing = await t.get('/s/rps_01AAAAAAAAAAAAAAAAAAAAAAAA');
            const stranger = await t.get('/s/' + id, { headers: cookie(asStranger) });
            const out = await t.get('/s/' + id);
            assert.strictEqual(stranger.status, 404, 'another signed-in person gets a 404');
            assert.strictEqual(out.status, 404, 'a signed-out reader gets a 404');
            assert.strictEqual(stranger.text, missing.text, 'the same page a missing report gets: no hint that it exists');
            assert.strictEqual(out.text, missing.text);
            assert.strictEqual(stranger.headers.get('cache-control'), missing.headers.get('cache-control'));

            const strangerApi = await t.get('/api/v1/session-reports/' + id, { headers: cookie(asStranger) });
            assert.strictEqual(strangerApi.status, 404);
            assert.strictEqual(strangerApi.json().code, 'report.session_not_found');
            assert.strictEqual((await t.get('/api/v1/session-reports/' + id)).status, 404, 'and the API is a 404 signed out');
            assert.ok(!(await t.ctx.sessionReports.listPublic({ limit: 50 })).some((r) => r.id === id));
        });

        await check('Only me: the owner alone, a 404 for the person who was on the list', async () => {
            const id = await write({ task: { title: 'Mine one', ref: 'tsk_mine' } });
            await setShare(id, { audience: 'people', members: [{ name: 'friend', role: 'viewer' }] });
            assert.strictEqual((await t.get('/s/' + id, { headers: cookie(asFriend) })).status, 200);
            await setShare(id, { audience: 'private' });
            assert.strictEqual(await audienceOf(id), 'private');
            assert.strictEqual((await t.get('/s/' + id, { headers: cookie(asOwner) })).status, 200);
            assert.strictEqual((await t.get('/s/' + id, { headers: cookie(asFriend) })).status, 404, 'leaving the list closes it at once');
            assert.strictEqual((await t.get('/api/v1/session-reports/' + id, { headers: cookie(asFriend) })).status, 404);
        });

        await check('the owner of another report cannot change this one\'s audience', async () => {
            const id = await write({ task: { title: 'Not yours', ref: 'tsk_not_yours' } });
            const r = await t.get(`/api/v1/session-report/${id}/share`, {
                method: 'PUT', json: { audience: 'public' }, headers: { ...cookie(asStranger), 'x-requested-with': 'ov-share' },
            });
            assert.strictEqual(r.status, 404, 'the sheet\'s store refuses anyone who is not the owner, as a 404');
            assert.strictEqual(await audienceOf(id), 'private');
            assert.strictEqual((await t.get('/s/' + id, { headers: cookie(asStranger) })).status, 404);
        });

        await check('a report that leaves Everyone leaves the list, the sitemap and Search at once', async () => {
            const id = await write({ task: { title: 'Leaving one', ref: 'tsk_leaving' }, visibility: 'public' });
            assert.ok((await t.ctx.sessionReports.listPublic({ limit: 50 })).some((r) => r.id === id));
            assert.ok((await t.get('/sitemap.xml')).text.includes('/s/' + id));
            // Search had it: the sweep put a document in the outbox.
            const searchIndex = require('../server/search-index');
            const index = searchIndex.instance();
            assert.ok(index, 'the app built the search feed');
            await index.sweep();
            const before = (await db.many('SELECT envelope FROM event_outbox ORDER BY id')).map((r) => r.envelope)
                .filter((e) => e && e.payload && e.payload.type === 'session' && e.payload.id === id);
            assert.ok(before.length, 'Search holds the public report');

            await setShare(id, { audience: 'private' });
            // Out of every list, at once - the share row wins over the column, which still says public until a backfill.
            assert.ok(!(await t.ctx.sessionReports.listPublic({ limit: 50 })).some((r) => r.id === id), 'out of the lists');
            assert.ok(!(await t.get('/sitemap.xml')).text.includes('/s/' + id), 'out of the sitemap');
            assert.ok(!(await t.get('/api/v1/session-reports')).json().reports.some((r) => r.id === id), 'out of the API list');
            assert.strictEqual((await t.get('/s/' + id)).status, 404, 'and no longer a page');
            const after = (await db.many('SELECT envelope FROM event_outbox ORDER BY id')).map((r) => r.envelope)
                .filter((e) => e && e.payload && e.payload.type === 'session' && e.payload.id === id);
            assert.ok(after.length > before.length, 'a tombstone went out in the same transaction as the audience change');
            assert.strictEqual(after[after.length - 1].event_type, 'report.index_document.deleted', 'the last word for Search is the tombstone');

            // And it comes back when the owner widens it again.
            await setShare(id, { audience: 'public' });
            assert.ok((await t.ctx.sessionReports.listPublic({ limit: 50 })).some((r) => r.id === id), 'back in the list');
        });

        await check('the owner sets their default for new reports, and it is Only me until they change it', async () => {
            const signedOut = await t.get('/api/v1/me/session-reports/default', { method: 'POST', json: { audience: 'public' } });
            assert.strictEqual(signedOut.status, 401);
            const crossSite = await t.get('/api/v1/me/session-reports/default', { method: 'POST', json: { audience: 'public' }, headers: { ...cookie(asOwner), 'sec-fetch-site': 'cross-site' } });
            assert.strictEqual(crossSite.status, 403, 'a cross-site save is refused');
            const bad = await t.get('/api/v1/me/session-reports/default', { method: 'POST', json: { audience: 'everyone' }, headers: { ...cookie(asOwner), 'x-requested-with': 'ov-share' } });
            assert.strictEqual(bad.status, 422);
            const ok = await t.get('/api/v1/me/session-reports/default', { method: 'POST', json: { audience: 'link' }, headers: { ...cookie(asOwner), 'x-requested-with': 'ov-share' } });
            assert.strictEqual(ok.status, 200);
            assert.deepStrictEqual(ok.json(), { audience: 'link', visibility: 'unlisted' });

            const id = await write({ task: { title: 'By the default', ref: 'tsk_default' } });
            assert.strictEqual(await audienceOf(id), 'link', 'the next report starts at the owner\'s default');
            assert.strictEqual((await db.maybe('SELECT visibility FROM report_sessions WHERE id = $1', [id])).visibility, 'unlisted', 'and the old column agrees');

            // The default is the owner's, not everyone's.
            const other = await write({ task: { title: 'Another owner', ref: 'tsk_other_owner' }, owner: OTHER_OWNER });
            assert.strictEqual(await audienceOf(other), 'private');

            const you = await t.get('/you', { headers: cookie(asOwner) });
            assert.ok(you.text.includes('data-ov-default-share'), 'the owner can change it on their own page');
            assert.ok(you.text.includes('New reports:'));
            assert.ok(you.text.includes('Ship the checkout page'), 'their own reports are listed with their audience');
            assert.ok(you.text.includes('Anyone with the link'));
            // Back to Only me for the rest of the run.
            await t.get('/api/v1/me/session-reports/default', { method: 'POST', json: { audience: 'private' }, headers: { ...cookie(asOwner), 'x-requested-with': 'ov-share' } });
        });

        await check('the backfill maps the column, writes nothing in a dry run, and never overrules the owner', async () => {
            // Two reports as an older release left them: a share row is what this script adds.
            const rows = [
                ['rps_01BBBBBBBBBBBBBBBBBBBBBBBB', OWNER, 'private'],
                ['rps_01CCCCCCCCCCCCCCCCCCCCCCCC', OWNER, 'unlisted'],
                ['rps_01DDDDDDDDDDDDDDDDDDDDDDDD', OWNER, 'public'],
            ];
            for (const [id, owner, visibility] of rows) {
                await db.prepare(`INSERT INTO report_sessions (id, owner, source, task_ref, task_title, outcome, summary, visibility, created_at, updated_at)
                    VALUES (?, ?, 'codes', ?, 'Old one', 'done', 'Written before sharing.', ?, now(), now())`).run(id, owner, 'tsk_' + id, visibility);
            }
            // One the owner has already chosen for: the script must leave its audience exactly as it is.
            const chosen = await write({ task: { title: 'Chosen', ref: 'tsk_chosen' } });
            await setShare(chosen, { audience: 'public' });

            const before = await plan(db, { limit: 1000 });
            assert.deepStrictEqual(before.map((p) => [p.id, p.from, p.to]), [
                ['rps_01BBBBBBBBBBBBBBBBBBBBBBBB', 'private', 'private'],
                ['rps_01CCCCCCCCCCCCCCCCCCCCCCCC', 'unlisted', 'link'],
                ['rps_01DDDDDDDDDDDDDDDDDDDDDDDD', 'public', 'public'],
            ], 'private -> Only me, unlisted -> the link, public -> Everyone; a report with a row is not in the plan');

            const written = (await db.many('SELECT 1 AS one FROM shares WHERE kind = $1', ['session-report'])).length;
            const dry = await backfill({ db, register: sharing.register, apply: false });
            assert.strictEqual(dry.made, 0);
            assert.strictEqual((await db.many('SELECT 1 AS one FROM shares WHERE kind = $1', ['session-report'])).length, written, 'a dry run wrote nothing');

            const done = await backfill({ db, register: sharing.register, apply: true });
            assert.strictEqual(done.planned, 3);
            assert.strictEqual(done.made, 3);
            assert.strictEqual(done.failed, 0);
            assert.strictEqual(await audienceOf('rps_01BBBBBBBBBBBBBBBBBBBBBBBB'), 'private');
            assert.strictEqual(await audienceOf('rps_01CCCCCCCCCCCCCCCCCCCCCCCC'), 'link');
            assert.strictEqual(await audienceOf('rps_01DDDDDDDDDDDDDDDDDDDDDDDD'), 'public');
            assert.strictEqual(await audienceOf(chosen), 'public', 'the owner\'s own choice is untouched');
            const col = await db.maybe('SELECT visibility FROM report_sessions WHERE id = $1', ['rps_01DDDDDDDDDDDDDDDDDDDDDDDD']);
            assert.strictEqual(col.visibility, 'public', 'the column is left as it was');

            const again = await backfill({ db, register: sharing.register, apply: true });
            assert.strictEqual(again.planned, 0, 'idempotent: a second run finds nothing to do');
            assert.strictEqual(again.made, 0);
            assert.strictEqual((await db.many('SELECT 1 AS one FROM shares WHERE kind = $1', ['session-report'])).length, written + 3);
        });

        await check('the after-show page shows what Live answered, and a 404 from Live takes it down', async () => {
            const live = require('../server/data/live');
            const { jsonResponse, recapResponse } = require('./helpers/boot');
            let answer = () => recapResponse({ recap: { stream_id: 5, title: 'The after-show' } });
            let now = 0;
            const client = live.createLiveClient({ config: { liveUrl: 'http://live' }, fetchImpl: async () => answer(), now: () => now, log: { warn() {} } });
            assert.ok((await client.recap(5)).recap.title, 'a public answer is shown');
            answer = () => jsonResponse({ error: 'No report for this stream' }, 404);
            now += 61_000;
            assert.strictEqual(await client.recap(5), null, 'Live answering 404 is no report, at once');
        });
    } finally {
        await t.close();
    }
    done();
})().catch((err) => { console.error(err); process.exit(1); });
