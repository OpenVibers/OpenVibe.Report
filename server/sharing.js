'use strict';
/**
 * Session reports in the sharing system (openvibe-sdk/share, share.v1), kind 'session-report'.
 *
 * The owner of a report chooses who sees it: Everyone, Anyone with the link, Specific people or Only me. That is the
 * sharing system's own setting — the same words and the same sheet as everywhere else on the network — and it lives in
 * the share row, not in a column of Report's own. The `visibility` column report_sessions already had is kept and is
 * still written for N-1 (private → private, unlisted → link, public → public), so an older release reads what it always
 * read; every read path here asks this module instead.
 *
 * A report registers itself when it is written, with the visibility the writing service named (private, the S3 default,
 * when it named none). A report that already has a share row keeps its audience: a later write never overrules the
 * owner's choice in the sheet.
 *
 * The SDK module is optional at runtime, as in Live: Report must boot and serve its other pages on a release whose
 * pinned openvibe-sdk predates `share`. Without it the old column decides and only the old three levels work — fail
 * closed, never open. The share_* tables are created by Report's own migration 0008 from the SDK's schema; nothing is
 * created at runtime.
 *
 * The sheet's saves reach this module through the SDK's router (mountShareRouter in server/app.js); every read path
 * calls canView. When the audience changes, onAudienceChange drops the report from Search in the same transaction
 * (the sweep would too, an hour later; rule 4 says at once).
 */
const SERVICE = 'report';
const KIND = 'session-report';
/** The old column's three words, mapped 1:1 onto the four audiences (design, "How each product moves"). */
const FROM_VISIBILITY = { private: 'private', unlisted: 'link', public: 'public' };
/** And back: what the old column says for an audience. 'people' has no old word; Only me is the safe one. */
const TO_VISIBILITY = { private: 'private', link: 'unlisted', public: 'public', people: 'private' };
const AUDIENCES = ['public', 'link', 'people', 'private'];
const STAFF_ROLES = ['global_mod', 'admin', 'owner'];

let state = { store: null, shares: null, loaded: false, network: null, events: null, notify: null, onAudienceChange: null };

/**
 * Build the share store. Called once by the app with the store and config; tests may pass their own network client and
 * notification adapter.
 */
function init({ store, network = null, events = null, notify = null, onAudienceChange = null } = {}) {
    state = { store: store || null, shares: null, loaded: false, network, events, notify, onAudienceChange };
    return available();
}

function sdk() {
    if (state.loaded) return state.shares;
    state.loaded = true;
    let mod;
    try { mod = require('openvibe-sdk/share'); } catch { mod = null; }
    if (!mod || typeof mod.createShares !== 'function' || !state.store || !state.store.db) return (state.shares = null);
    try {
        state.shares = mod.createShares({
            db: state.store.db,
            network: state.network || networkClient(),
            events: state.events || eventsClient(),
            notify: state.notify || (async () => {}),
            onAudienceChange: state.onAudienceChange || defaultAudienceChange,
        });
    } catch (err) {
        console.warn(`[Sharing] sharing unavailable: ${err.message}`);
        state.shares = null;
    }
    return state.shares;
}

/**
 * A report that leaves Everyone leaves Search at once: the same transaction writes the tombstone (search-feed's
 * publication on the transaction the share store gave us). A failure is logged and never fails the owner's save — the
 * hourly sweep is the backstop.
 */
async function defaultAudienceChange(ref, audience, tx) {
    try {
        const index = require('./search-index').instance && require('./search-index').instance();
        if (index && typeof index.syncReport === 'function') await index.syncReport(ref.id, audience, tx);
    } catch (err) {
        console.warn(`[Sharing] the search copy of ${ref.id} was not updated: ${err.message}`);
    }
}

/** Network's internal JSON client (the sheet's @name lookups and the people it shows). */
function networkClient() {
    try { return require('./data/network-json').client(); } catch { return { json: async () => { throw new Error('Network is not reachable'); } }; }
}

/**
 * Report's events client. The share store queues every event in share_deliveries inside the change's transaction and
 * flush() sends them here; a publish that fails leaves the row pending for the next flush, which is the retry.
 */
function eventsClient() {
    return {
        async publish(envelope) {
            const client = eventsSingleton();
            if (!client) throw new Error('Report has no events URL or OAuth client secret');
            await client.publish(envelope);
        },
    };
}

let _events = null;
function eventsSingleton() {
    if (_events) return _events;
    const { createEventsClient } = require('openvibe-sdk/events');
    const { createClient } = require('openvibe-sdk/core');
    const { createServiceTokenClient } = require('openvibe-sdk/auth');
    let config;
    try { config = require('./config').load(); } catch { return null; }
    const url = config.events && config.events.url;
    const secret = config.oauth && config.oauth.clientSecret;
    if (!url || !secret) return null;
    const tokenProvider = createServiceTokenClient({
        tokenUrl: config.oauth.tokenUrl, clientId: config.oauth.clientId || 'report', clientSecret: secret,
        scope: { 'openvibe.events': 'events.event.publish' },
    });
    _events = createEventsClient(createClient({ baseUrls: { events: url }, tokenProvider, retries: 0 }), { source: SERVICE });
    return _events;
}

/** Whether the sharing system is installed in this release. */
function available() { try { return !!sdk(); } catch { return false; } }

/** The old column's word for an audience (what report_sessions.visibility says). */
function visibilityFor(audience) { return TO_VISIBILITY[audience] || 'private'; }

/** The audience the old column means. */
function audienceFor(visibility) { return FROM_VISIBILITY[String(visibility || '').trim().toLowerCase()] || 'private'; }

/** A person's signed-in viewer, as the sharing system reads one: { subject: { type, id }, staff? }. */
function viewerOf(user) {
    if (!user) return null;
    const id = typeof user.subject_id === 'string' ? user.subject_id.trim() : '';
    if (!id) return null;
    return { subject: { type: 'user', id }, staff: user.staff === true || STAFF_ROLES.includes(String(user.role || '')) };
}

/**
 * Register a report the moment it is written, with the audience its visibility means. An existing row is left alone
 * (the owner's choice in the sheet wins over the write's default) and the answer says whether this call made the row.
 */
async function register(id, owner, visibility) {
    const shares = sdk();
    if (!shares || !owner) return false;
    try {
        await shares.register({ service: SERVICE, kind: KIND, id: String(id) }, {
            owner_subject: { type: 'user', id: String(owner) },
            audience: audienceFor(visibility),
        });
        return true;
    } catch (err) {
        // 409 share.exists: already registered, which is the normal repeat of an idempotent write.
        if (err && (err.status === 409 || /share\.exists/.test(String(err.code || '')))) return false;
        console.warn(`[Sharing] registration for ${id} failed: ${err.message}`);
        return false;
    }
}

/**
 * May this viewer open the report? The share row decides. Without the sharing system (an old release, or no database)
 * the old column decides, so nothing that worked stops working — and nothing hidden opens.
 */
async function canView(viewer, report) {
    if (!report) return false;
    const shares = sdk();
    if (shares) {
        try {
            return await shares.canView(viewer || null, { service: SERVICE, kind: KIND, id: String(report.id) });
        } catch (err) {
            console.warn(`[Sharing] the access check for ${report.id} failed: ${err.message}`);
            // A failing check is never an open door: fall through to the column.
        }
    }
    const audience = audienceFor(report.visibility);
    if (audience === 'public' || audience === 'link') return true;
    const id = viewer && viewer.subject ? viewer.subject.id : null;
    return Boolean(id && id === report.owner);
}

/** The audience a report has now: the share row's, else the column's. */
async function audienceOf(report) {
    if (!report) return 'private';
    const row = await shareRow(report.id);
    if (row && AUDIENCES.includes(row.audience)) return row.audience;
    return audienceFor(report.visibility);
}

/** The raw share row (audience and revision), or null when the report has none. */
async function shareRow(id) {
    if (!state.store || !state.store.db) return null;
    try {
        return await state.store.db.maybe('SELECT audience, revision FROM shares WHERE service = $1 AND kind = $2 AND resource_id = $3',
            [SERVICE, KIND, String(id)]);
    } catch { return null; }
}

/** The people a report is shared with, as subject ids (the count the owner's chip shows). */
async function memberSubjects(id) {
    if (!state.store || !state.store.db) return [];
    try {
        const rows = await state.store.db.many(`SELECT subject->>'id' AS id FROM share_members
            WHERE service = $1 AND kind = $2 AND resource_id = $3 AND (expires_at IS NULL OR expires_at > NOW())`,
            [SERVICE, KIND, String(id)]);
        return rows.map((r) => r.id).filter(Boolean);
    } catch { return []; }
}

/** The Share sheet's description of a report: its title and where it lives. */
async function describe(ref) {
    let base = 'https://openvibe.report';
    try { base = String(require('./config').load().baseUrl || base).replace(/\/+$/, ''); } catch { /* the default */ }
    const db = state.store && state.store.db;
    const row = db ? await db.maybe('SELECT task_title FROM report_sessions WHERE id = $1', [String(ref.id)]).catch(() => null) : null;
    return {
        title: row && row.task_title ? row.task_title : 'A session report',
        link: `${base}/s/${encodeURIComponent(String(ref.id))}`,
        roles: ['viewer'],
        // A session report is a story, not a document to edit, and it stays its writer's: no transfer.
        transferable: false,
    };
}

/** The share router, mounted at the app root so it sees /api/v1/<kind>/<id>/share. Null when the SDK has no sharing. */
function router(options) {
    const shares = sdk();
    if (!shares) return null;
    return shares.router({ service: SERVICE, ...options });
}

/** Send the sharing system's queued deliveries (the housekeeping loop calls this, never a page). */
async function flushDeliveries() {
    const shares = sdk();
    if (!shares) return 0;
    try { return await shares.flush(); } catch { return 0; }
}

module.exports = {
    SERVICE, KIND, AUDIENCES, FROM_VISIBILITY, TO_VISIBILITY,
    init, available, register, canView, audienceOf, shareRow, memberSubjects, describe, router, flushDeliveries,
    visibilityFor, audienceFor, viewerOf,
    _reset() { state = { store: null, shares: null, loaded: false, network: null, events: null, notify: null, onAudienceChange: null }; _events = null; },
};
