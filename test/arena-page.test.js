'use strict';
// The Arena moved to OpenVibe.Compare (11-13): Report's old addresses answer in one hop. A page or a round is a 301 to
// the same place on openvibe.compare/arena; a POST from an old open tab (an ask or a vote) is a 303 to the round there,
// because a vote cannot cross sites; anything else falls through.
const assert = require('node:assert/strict');
const express = require('express');
const { createArenaRoutes, targetOf } = require('../server/http/arena');

(async () => {
    assert.equal(targetOf(null), 'https://openvibe.compare/arena');
    assert.equal(targetOf('rnd_01ABC'), 'https://openvibe.compare/arena/rnd_01ABC');
    assert.equal(targetOf('../../etc'), 'https://openvibe.compare/arena', 'an id that is not one goes to the front door');

    const app = express();
    app.use(createArenaRoutes());
    app.use((_req, res) => res.status(404).send('nope'));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const front = await fetch(base + '/ai/arena', { redirect: 'manual' });
        assert.equal(front.status, 301);
        assert.equal(front.headers.get('location'), 'https://openvibe.compare/arena');
        const round = await fetch(base + '/ai/arena/rnd_01ABC', { redirect: 'manual' });
        assert.equal(round.status, 301);
        assert.equal(round.headers.get('location'), 'https://openvibe.compare/arena/rnd_01ABC');
        const vote = await fetch(base + '/ai/arena/rnd_01ABC/vote', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'winner=a' });
        assert.equal(vote.status, 303, 'an old tab\'s vote is sent to the round on Compare');
        assert.equal(vote.headers.get('location'), 'https://openvibe.compare/arena/rnd_01ABC');
        const ask = await fetch(base + '/ai/arena', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'prompt=hi' });
        assert.equal(ask.status, 303);
        assert.equal(ask.headers.get('location'), 'https://openvibe.compare/arena');
        const put = await fetch(base + '/ai/arena', { method: 'PUT', redirect: 'manual' });
        assert.equal(put.status, 404, 'other methods fall through');
        console.log('arena-page: Report\'s Arena addresses go to openvibe.compare/arena in one hop');
    } finally {
        server.close();
    }
})().catch((e) => { console.error(e); process.exit(1); });
