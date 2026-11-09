'use strict';
// The Arena on Report: anyone reads it, a POST needs a signed-in person and this site's Origin, asks and votes pass
// through to Exchange's Arena API with the person's token, and Exchange's /arena links point at /ai/arena.
const assert = require('node:assert/strict');
const express = require('express');
const { createArenaRoutes } = require('../server/http/arena');

(async () => {
    const app = express();
    const calls = [];
    app.use((req, res, next) => {
        if (req.get('x-test-user')) { req.user = { id: 'test' }; req.token = 'test-token'; }
        next();
    });
    app.use(createArenaRoutes({
        config: { baseUrl: 'https://openvibe.report' },
        fetchImpl: async (url, opts) => {
            calls.push({ url, opts });
            const body = opts.method === 'POST' ? { location: '/ai/arena/round1' } : { html: '<form action="/arena/ask"><button>Ask</button></form>' };
            return new Response(JSON.stringify(body), { status: 200 });
        },
    }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const anon = await fetch(`${base}/ai/arena`, { redirect: 'manual' });
        assert.equal(anon.status, 200, 'anyone reads the Arena');
        const page = await fetch(`${base}/ai/arena`, { headers: { 'x-test-user': '1' } });
        assert.ok((await page.text()).includes('action="/ai/arena"'), "Exchange's /arena links point here");
        const bad = await fetch(`${base}/ai/arena`, { method: 'POST', headers: { 'x-test-user': '1', origin: 'https://evil.example' } });
        assert.equal(bad.status, 403, 'another Origin may not post');
        const signedOut = await fetch(`${base}/ai/arena`, { method: 'POST', redirect: 'manual', headers: { origin: 'https://openvibe.report' } });
        assert.equal(signedOut.status, 303, 'a signed-out POST goes to sign-in');
        assert.match(signedOut.headers.get('location'), /^\/auth\/login\?next=/);
        const vote = await fetch(`${base}/ai/arena/round1/vote`, {
            method: 'POST', redirect: 'manual',
            headers: { 'x-test-user': '1', origin: 'https://openvibe.report', 'content-type': 'application/x-www-form-urlencoded' },
            body: 'outcome=left',
        });
        assert.equal(vote.status, 303);
        assert.ok(calls.at(-1).url.endsWith('/rounds/round1/votes'));
        assert.equal(JSON.parse(calls.at(-1).opts.body).outcome, 'left');
        assert.equal(calls.at(-1).opts.headers.authorization, 'Bearer test-token', "the person's own token");
        console.log('Report Arena: sign-in, Origin, the API pass-through and redirects passed');
    } finally {
        await new Promise((r) => server.close(r));
    }
})().catch((e) => { console.error(e); process.exitCode = 1; });
