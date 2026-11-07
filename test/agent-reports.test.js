'use strict';
/**
 * Report, S7: chapter links and topic citations, and the third-party report door.
 *
 *   - an episode's chapters link into OpenVibe.Video at their second, from the episode's own vod_id;
 *   - a topic page cites a public agent report when the agent worked on the topic's whole name, never a hidden report
 *     and never a partial name;
 *   - POST /api/v1/me/session-reports writes with the person's token: the owner comes from the token, never the body,
 *     and the report is private by default; GET /api/v1/me/session-reports is only that person's.
 */
const assert = require('assert');
const express = require('express');
const { boot, check, done } = require('./helpers/boot');
const views = require('../server/views');

const OWNER = 'usr_01JAN2C3D4E5F6G7H8J9K0MNPS';
const OTHER = 'usr_01JAN2C3D4E5F6G7H8J9K0MNPT';

const sso = {
    router: () => express.Router(),
    optionalAuth: () => (req, _res, next) => {
        if (req.headers['x-test-user'] === 'owner') req.user = { subject_id: OWNER, role: 'user', username: 'ann' };
        next();
    },
};
const verifyServiceToken = async (token) => (token === 'good'
    ? { ok: true, claims: { sub: 'svc:codes', cap: ['report.session.write'], aud: ['openvibe.report'] } }
    : { ok: false, code: 'token.invalid' });
const report = (over = {}) => ({
    owner: OWNER, source: 'codes', task: { ref: 'tsk_' + Math.random().toString(36).slice(2), title: 'Fix the checkout page' },
    summary: 'The agent fixed the checkout page and ran the tests.', visibility: 'public', ...over,
});

(async () => {
    const t = await boot({ db: true, sso, verifyServiceToken, now: () => Date.parse('2026-11-07T12:00:00Z') });
    try {
        await check('the third-party door takes the owner from the token, not the body', async () => {
            const r = await t.get('/api/v1/me/session-reports', {
                json: { ...report({ visibility: 'private' }), owner: OTHER, summary: 'Mine, with a body owner that must lose.' },
                headers: { 'x-test-user': 'owner', 'sec-fetch-site': 'same-origin' },
            });
            assert.strictEqual(r.status, 201, r.text);
            const stored = await t.ctx.sessionReports.get(r.json().id);
            assert.strictEqual(stored.owner, OWNER, 'the body owner never wins');
            assert.strictEqual(stored.visibility, 'private', 'private by default');
        });

        await check('signed out is a 401, and the own list is only that person\'s', async () => {
            const anon = await t.get('/api/v1/me/session-reports', { json: report() });
            assert.strictEqual(anon.status, 401);
            await t.get('/internal/session-reports', { json: report({ owner: OTHER, visibility: 'public' }), headers: { authorization: 'Bearer good' } });
            const mine = await t.get('/api/v1/me/session-reports?days=7', { headers: { 'x-test-user': 'owner' } });
            assert.strictEqual(mine.status, 200, mine.text);
            assert.ok(mine.json().reports.every((r) => r.owner === OWNER), 'never another person\'s report');
            assert.strictEqual(mine.headers.get('cache-control'), 'private, no-store');
        });

        await check('a public report cites a topic by its whole name; a private one is never a citation', async () => {
            const wrote = await t.get('/internal/session-reports', {
                json: report({ task: { ref: 'tsk_login_page_1', title: 'Fix the login page' }, summary: 'The login page redirects again.', visibility: 'public' }),
                headers: { authorization: 'Bearer good' },
            });
            assert.strictEqual(wrote.status, 201, wrote.text);
            await t.get('/internal/session-reports', {
                json: report({ task: { ref: 'tsk_private_1', title: 'Fix the login page privately' }, visibility: 'private' }),
                headers: { authorization: 'Bearer good' },
            });
            const matches = await t.ctx.sessionReports.listPublicMatchingTopic('Login page');
            assert.ok(matches.length >= 1, 'the public report is cited');
            assert.ok(matches.every((r) => /login page/i.test(r.task.title + ' ' + r.summary)), 'every citation speaks of the topic');
            assert.ok(!matches.some((r) => /privately/.test(r.task.title)), 'a private report is never cited');
            assert.deepStrictEqual(await t.ctx.sessionReports.listPublicMatchingTopic('login pag'), [], 'a partial name is not the topic');
            assert.deepStrictEqual(await t.ctx.sessionReports.listPublicMatchingTopic('ogin'), [], 'a name inside a word is not the topic');
        });

        await check('the topic page draws the citations and the episode draws its chapters into the recording', async () => {
            const topic = views.topic({ topic: { topic: { title: 'Login page', kind: 'tech' }, takes: [] }, citations: [{ id: 'rps_01JAN2C3D4E5F6G7H8J9K0MNPS', task: { title: 'Fix the login page' }, summary: 'Done', outcome: 'done' }] });
            assert.match(topic, /Agents that worked on this/);
            assert.match(topic, /Fix the login page/);
            const episode = views.episode({ episode: { episode: { title: 'An episode', vod_id: 4242, chapters: [{ sec: 95, title: 'The login bug' }, { sec: 600, title: 'Tests pass' }] }, stream: {} } });
            assert.match(episode, /https:\/\/openvibe\.video\/v\/4242\?t=95/);
            assert.match(episode, /01:35/);
            const noVod = views.episode({ episode: { episode: { title: 'No recording', chapters: [{ sec: 5, title: 'A chapter' }] }, stream: {} } });
            assert.ok(!/openvibe\.video/.test(noVod), 'no recording: a chapter is text, never a broken link');
        });

    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
