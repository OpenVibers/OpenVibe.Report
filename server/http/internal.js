'use strict';

/**
 * /internal — loopback-only operator and Events endpoints. nginx answers 404 for /internal/; the app also checks
 * that the socket really is loopback (a spoofed X-Forwarded-For cannot reach these).
 *
 *   POST /internal/events                       OpenVibe.Events delivery (HMAC v2, REPORT_EVENTS_SECRET)
 *   GET  /internal/shadow?days=7                the latest shadow runs and their differences
 *   POST /internal/shadow?days=7                run a comparison now
 *   GET  /internal/metrics?scope=&id=&days=     the flat report.metric@1 rows
 *   GET  /internal/channels/:channel/analytics  a channel's creator analytics and Billing revenue
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const { parseDelivery } = require('openvibe-sdk/events');

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1']);

function isLoopback(req) {
    const raw = req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : '';
    return LOOPBACK.has(raw) || LOOPBACK.has(raw.replace(/^::ffff:/, ''));
}

function createInternalRoutes({ analytics = null, shadow = null, config = {}, now = () => Date.now(), log = console } = {}) {
    const r = express.Router();
    r.use((req, res, next) => {
        if (isLoopback(req)) return next();
        return contracts.http.sendProblem(res, 403, 'internal.loopback_only', { detail: 'This endpoint is for the host itself.', ctx: req.ov });
    });

    r.get('/shadow', async (req, res) => {
        if (!shadow) return contracts.http.sendProblem(res, 503, 'report.no_database', { detail: 'Report has no database in this process.', ctx: req.ov });
        try {
            const body = await shadow.summary({ limit: req.query.limit, days: req.query.days });
            res.set('Cache-Control', 'no-store').json(body);
        } catch (err) {
            log.error('[OpenVibe.Report] shadow summary failed:', err && err.message ? String(err.message).slice(0, 200) : err);
            contracts.http.sendProblem(res, 500, 'report.shadow_failed', { detail: 'The shadow summary could not be read.', ctx: req.ov });
        }
    });

    r.post('/shadow', async (req, res) => {
        if (!shadow) return contracts.http.sendProblem(res, 503, 'report.no_database', { detail: 'Report has no database in this process.', ctx: req.ov });
        try {
            const run = await shadow.compare({ days: req.query.days });
            res.set('Cache-Control', 'no-store').json(run);
        } catch (err) {
            log.error('[OpenVibe.Report] shadow run failed:', err && err.message ? String(err.message).slice(0, 200) : err);
            contracts.http.sendProblem(res, 500, 'report.shadow_failed', { detail: 'The shadow comparison could not run.', ctx: req.ov });
        }
    });

    r.get('/metrics', async (req, res) => {
        if (!analytics) return contracts.http.sendProblem(res, 503, 'report.no_database', { detail: 'Report has no database in this process.', ctx: req.ov });
        const body = await analytics.metrics({ scope: req.query.scope, scopeId: req.query.id, days: req.query.days });
        if (!body) return contracts.http.sendProblem(res, 404, 'report.metric_not_found', { detail: 'No such metric scope.', ctx: req.ov });
        res.set('Cache-Control', 'no-store').json(body);
    });

    r.get('/channels/:channel/analytics', async (req, res) => {
        if (!analytics) return contracts.http.sendProblem(res, 503, 'report.no_database', { detail: 'Report has no database in this process.', ctx: req.ov });
        const body = await analytics.channel(req.params.channel, req.query.days);
        if (!body) return contracts.http.sendProblem(res, 404, 'report.channel_not_found', { detail: 'No such channel in Report\'s tables.', ctx: req.ov });
        res.set('Cache-Control', 'no-store').json(body);
    });

    // OpenVibe.Events delivery. The raw body is read before any JSON parser; the signature is v2 only.
    r.post('/events', express.raw({ type: () => true, limit: '256kb' }), async (req, res) => {
        const secrets = (config.events && config.events.secrets) || [];
        if (!secrets.length) return contracts.http.sendProblem(res, 503, 'report.events_disabled', { detail: 'REPORT_EVENTS_SECRET is not set.', ctx: req.ov });
        if (!analytics) return contracts.http.sendProblem(res, 503, 'report.no_database', { detail: 'Report has no database in this process.', ctx: req.ov });
        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        let delivery = null;
        for (const secret of secrets) {
            delivery = parseDelivery(raw, req.headers, secret, { requireV2: true, now: now() });
            if (delivery) break;
        }
        if (!delivery) return contracts.http.sendProblem(res, 401, 'report.bad_signature', { detail: 'The delivery does not verify or is outside the replay window.', ctx: req.ov });
        try {
            const out = await analytics.recordEvent(delivery.event);
            return res.set('Cache-Control', 'no-store').json({ ok: true, event_id: delivery.event.event_id, ...out });
        } catch (err) {
            log.error('[OpenVibe.Report] event ingest failed:', err && err.message ? String(err.message).slice(0, 200) : err);
            return contracts.http.sendProblem(res, 500, 'report.ingest_failed', { detail: 'The event could not be stored; Events will retry.', ctx: req.ov });
        }
    });

    return r;
}

module.exports = { createInternalRoutes, isLoopback };
