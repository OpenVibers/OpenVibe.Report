'use strict';
/**
 * The Arena on Report (/ai/arena, beside the rankings it feeds; plan "Exchange is the API platform"). Exchange keeps the
 * Arena's data, private-round access and Bench vote rules; Report shows its rounds and passes asks and votes through:
 *
 *   GET  /ai/arena, /ai/arena/:id      → Exchange GET /api/v1/arena/rounds[/:id]  (an escaped HTML fragment)
 *   POST /ai/arena                     → Exchange POST /api/v1/arena/rounds         (a new round → 303 to it)
 *   POST /ai/arena/:id/vote            → Exchange POST /api/v1/arena/rounds/:id/votes
 *
 * A POST needs a signed-in person (else to sign-in) and this site's Origin (else 403). The person's token goes along
 * so Exchange applies their access; links in the fragment that pointed at Exchange's old /arena paths point here.
 */
const express = require('express');
const views = require('../views');

const EXCHANGE_ARENA = 'https://openvibe.exchange/api/v1/arena';
const LOCATION = /^\/ai\/arena(?:\/[a-zA-Z0-9_-]+)?$/;

/** Exchange's fragment, with its links moved to Report's paths. */
function relink(html) {
    return html
        .replace(/(href|action)="\/arena\/ask"/g, '$1="/ai/arena"')
        .replace(/(href|action)="\/arena/g, '$1="/ai/arena')
        .replace(/href="\/rankings/g, 'href="/ai')
        .replace(/next=%2Farena/g, 'next=%2Fai%2Farena');
}

function createArenaRoutes({ config, fetchImpl = globalThis.fetch }) {
    const r = express.Router();
    r.use(express.urlencoded({ extended: false, limit: '64kb' }));
    const page = (req, res, status, body, robots = 'noindex, nofollow') =>
        res.status(status).type('html').send(views.layout({ title: 'The Arena', path: req.path, active: '/ai', robots, body }));

    r.all(['/ai/arena', '/ai/arena/:id', '/ai/arena/:id/vote'], async (req, res, next) => {
        if (!['GET', 'POST'].includes(req.method)) return next();
        res.set('Cache-Control', 'no-store');
        if (req.method === 'POST' && (!req.user || !req.token)) return res.redirect(303, `/auth/login?next=${encodeURIComponent(req.originalUrl)}`);
        if (req.method === 'POST' && req.get('origin') !== new URL(config.baseUrl).origin) return res.sendStatus(403);
        let path = '/rounds';
        if (req.params.id) path += `/${encodeURIComponent(req.params.id)}`;
        if (req.path.endsWith('/vote')) path += '/votes';
        try {
            const upstream = await fetchImpl(EXCHANGE_ARENA + path, {
                method: req.method,
                headers: { ...(req.token ? { authorization: `Bearer ${req.token}` } : {}), 'content-type': 'application/json' },
                ...(req.method === 'POST' ? { body: JSON.stringify(req.body) } : {}),
                redirect: 'error',
                signal: AbortSignal.timeout(120000),
            });
            const data = await upstream.json();
            if (data.location && LOCATION.test(data.location)) return res.redirect(303, data.location);
            // Exchange renders the fragment escaped, with its own private-round access and Bench vote rules.
            const body = typeof data.html === 'string' ? relink(data.html) : '<p>The Arena is unavailable. Try again shortly.</p>';
            return page(req, res, upstream.status, `<link rel="stylesheet" href="/css/arena.css">${body}`);
        } catch {
            return page(req, res, 502, '<p>The Arena could not answer. Please try again.</p>', undefined);
        }
    });
    return r;
}

module.exports = { createArenaRoutes, relink };
