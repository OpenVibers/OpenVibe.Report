'use strict';

/**
 * POST /internal/session-reports: the door for the first-party services that ran an agent session.
 *
 * The caller is Codes, Actor or Live, with a Network service token that holds the capability report.session.write
 * for the audience openvibe.report (the grant is in Network's principals seed). The body names the person the
 * session was theirs; a token that acts for a person may only write that person's report.
 *
 * The answer is the report's id and its page (openvibe.report/s/<id>), and the write is idempotent per
 * (source, task ref): the same session's task always answers the same report.
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const { verifyServiceToken } = require('openvibe-sdk/auth');

const CAP = 'report.session.write';
const AUDIENCE = 'openvibe.report';

function bearer(req) {
    const h = String(req.headers.authorization || '');
    const m = h.match(/^Bearer\s+(.+)$/i);
    return m ? m[1].trim() : null;
}

function createSessionReportRoutes({ config, sessionReports, log = console, verify = null }) {
    const r = express.Router();
    const net = String((config && (config.networkPublicUrl || config.networkUrl)) || 'https://openvibe.network').replace(/\/+$/, '');
    const issuer = (config && config.network && config.network.issuer) || config.networkIssuer || 'https://openvibe.network';
    const jwks = `${net}/api/.well-known/jwks`;

    r.post('/session-reports', express.json({ limit: '256kb' }), async (req, res) => {
        const token = bearer(req);
        if (!token) return res.status(401).json({ error: 'token.required', detail: 'a service token is required' });
        const check = verify || verifyServiceToken;
        const v = await check(token, { jwks, issuer, audience: AUDIENCE, contracts, log });
        if (!v.ok) {
            const code = v.code === 'token.unavailable' ? 503 : 401;
            return res.status(code).json({ error: v.code || 'token.invalid', detail: v.reason || 'the token was not accepted' });
        }
        const claims = v.claims || {};
        const caps = [].concat(claims.cap || claims.scope || []);
        if (!caps.includes(CAP)) {
            return res.status(403).json({ error: 'capability.forbidden', detail: `the token does not hold ${CAP}` });
        }
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const subject = claims.on_behalf_of || claims.subject || null;
        if (subject && subject !== body.owner) {
            return res.status(403).json({ error: 'subject.forbidden', detail: 'the token may only write the report of the person it acts for' });
        }
        try {
            const out = await sessionReports.write(body);
            return res.status(out.created ? 201 : 200).json(out);
        } catch (err) {
            return res.status(400).json({ error: 'report.invalid', detail: String((err && err.message) || err).slice(0, 300) });
        }
    });


    // The stream part: Live tells Report that an agent stream ended. The report the tool wrote gets the stream added
    // to it; when there is no such report, a stream-only report is written.
    r.post('/session-reports/stream', express.json({ limit: '64kb' }), async (req, res) => {
        const token = bearer(req);
        if (!token) return res.status(401).json({ error: 'token.required', detail: 'a service token is required' });
        const check = verify || verifyServiceToken;
        const v = await check(token, { jwks, issuer, audience: AUDIENCE, contracts, log });
        if (!v.ok) {
            const code = v.code === 'token.unavailable' ? 503 : 401;
            return res.status(code).json({ error: v.code || 'token.invalid', detail: v.reason || 'the token was not accepted' });
        }
        const caps = [].concat((v.claims || {}).cap || (v.claims || {}).scope || []);
        if (!caps.includes(CAP)) {
            return res.status(403).json({ error: 'capability.forbidden', detail: 'the token does not hold ' + CAP });
        }
        try {
            const out = await sessionReports.writeStream(req.body || {});
            return res.status(out.created ? 201 : 200).json(out);
        } catch (err) {
            return res.status(400).json({ error: 'report.invalid', detail: String((err && err.message) || err).slice(0, 300) });
        }
    });

    return r;
}

module.exports = { createSessionReportRoutes, CAP, AUDIENCE };
