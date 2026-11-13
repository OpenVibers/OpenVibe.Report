'use strict';
/**
 * The Arena moved to OpenVibe.Compare (plan §V.2 / 16a, 11-13: openvibe.compare/arena is the front door). Report's old
 * addresses answer in one hop:
 *
 *   GET  /ai/arena, /ai/arena/:id   → 301 https://openvibe.compare/arena[/:id]
 *   POST /ai/arena, …/:id/vote      → 303 to the same round on Compare (a vote cannot cross sites; the person votes there)
 *
 * Compare signs people in itself and passes asks and votes to Exchange, as Report did.
 */
const express = require('express');

const COMPARE_ARENA = 'https://openvibe.compare/arena';
const ID = /^[a-zA-Z0-9_-]{1,80}$/;

function targetOf(id) {
    return id && ID.test(id) ? `${COMPARE_ARENA}/${encodeURIComponent(id)}` : COMPARE_ARENA;
}

function createArenaRoutes() {
    const r = express.Router();
    r.all(['/ai/arena', '/ai/arena/:id', '/ai/arena/:id/vote'], (req, res, next) => {
        if (req.method === 'GET' || req.method === 'HEAD') {
            res.set('Cache-Control', 'public, max-age=3600');
            return res.redirect(301, targetOf(req.params.id));
        }
        if (req.method === 'POST') return res.redirect(303, targetOf(req.params.id));
        return next();
    });
    return r;
}

module.exports = { createArenaRoutes, targetOf, COMPARE_ARENA };
