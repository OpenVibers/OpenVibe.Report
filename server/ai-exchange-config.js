'use strict';
/**
 * The `report.ai_exchange` namespace (D11 owner settings): the switch the owner changes from openvibe.network's
 * AI tab. REPORT_AI_EXCHANGE stays the pin: while it is set it wins, is read-only in the summary and a write
 * answers 409 config.pinned_in_env.
 *
 * /internal/config is openvibe-shared/config's adminRoutes, guarded by report.config.manage (Network's service
 * token only). actor is the owner Network names in X-OV-Subject; X-OV-Fresh: 1 gates a secret or x-danger write
 * (this namespace has neither). Every activation writes one audit line with the actor and the keys, never a value.
 */
const express = require('express');
const shared = require('openvibe-shared/config');
const { http, ids } = require('openvibe-contracts');
const { createServiceAuth } = require('./auth');

const SERVICE = 'report';
const NAMESPACE = 'report.ai_exchange';
const CAPABILITY = 'report.config.manage';

const SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'AI Exchange analytics',
    description: 'Consume Billing\'s billing.credit.settled events into the AI Exchange aggregates, and open the staff page and API.',
    type: 'object',
    additionalProperties: false,
    required: ['enabled'],
    properties: {
        enabled: {
            type: 'boolean', title: 'AI Exchange analytics', 'x-group': 'AI Exchange', 'x-env': 'REPORT_AI_EXCHANGE',
            description: 'Record each settlement as aggregates by day, model and provider access (never the raw settlement) and serve /ai/exchange and GET /api/v1/ai/exchange to staff.',
        },
    },
};
const DEFAULTS = Object.freeze({ enabled: false });

function actor(req) {
    const named = String((req.headers && req.headers['x-ov-subject']) || '').trim();
    return ids.isSubjectId('user', named) ? { type: 'user', id: named } : null;
}

const requireFresh = (req) => String((req.headers && req.headers['x-ov-fresh']) || '') === '1';

function capabilityGuard({ serviceAuth, log }) {
    return async function guard(req, res, next) {
        try {
            const r = await serviceAuth.authenticate(req);
            if (!r.ok) return http.sendProblem(res, r.status, r.code, { detail: r.detail, ctx: req.ov });
            const sub = String((r.claims && r.claims.sub) || '');
            if (!sub.startsWith('svc:')) return http.sendProblem(res, 403, 'capability.denied', { detail: `${CAPABILITY} is first-party; an app may not change Report configuration`, ctx: req.ov });
            if (!serviceAuth.hasCap(r.claims, CAPABILITY)) return http.sendProblem(res, 403, 'capability.denied', { detail: `${CAPABILITY} not granted`, ctx: req.ov });
            req.configClaims = r.claims;
            return next();
        } catch (err) {
            log.error(`[config] report.ai_exchange guard failed: ${(err && err.message) || err}`);
            return http.sendProblem(res, 500, 'internal.error', { detail: 'the configuration request failed', ctx: req.ov });
        }
    };
}

async function create({ db, config, env = process.env, log = console, now = () => Date.now(), onActivate = null }) {
    // REPORT_AI_EXCHANGE has always accepted anything but 0/false/no/off; the shared store's boolean pin reads true/1.
    const storeEnv = { ...env };
    const rawReportFlag = String(storeEnv.REPORT_AI_EXCHANGE || '');
    if (rawReportFlag && !/^(0|false|no|off)$/i.test(rawReportFlag)) storeEnv.REPORT_AI_EXCHANGE = '1';
    const store = await shared.createConfigStore({
        db, service: SERVICE, namespace: NAMESPACE, schema: SCHEMA, defaults: DEFAULTS, env: storeEnv, log,
        onActivate: async (values) => { if (onActivate) await onActivate(values); },
        onChange: ({ namespace, keys, actor: who, revision }) => {
            log.info(`[config] ${SERVICE} ${namespace} revision ${revision} by ${who && who.id ? `${who.type}:${who.id}` : 'unknown'}: ${keys.join(', ')}`);
        },
    });
    if (env.OV_CONFIG_KEKS) {
        try { await store.reseal(); } catch (err) { log.warn(`[config] ${NAMESPACE}: reseal failed: ${(err && err.message) || err}`); }
    }
    const serviceAuth = createServiceAuth({ config, now });
    const router = shared.adminRoutes([store], {
        basePath: '/internal/config', requireAdmin: capabilityGuard({ serviceAuth, log }), actor, requireFresh, log,
    });
    return {
        store, router,
        get: (key) => store.get(key),
        mount(app) { app.use('/internal/config', express.json({ limit: '128kb' })); router.mount(app); },
    };
}

module.exports = { create, SCHEMA, NAMESPACE, CAPABILITY };
