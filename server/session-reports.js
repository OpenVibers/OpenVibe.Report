'use strict';

/**
 * Agent Streams S3: the report of every agent session (report.session@1).
 *
 * A session report is one agent session's story: what was asked, what came out, what it cost, how it ended. It is
 * written by the first-party service that ran the session (Codes, Actor, Live) through
 * POST /internal/session-reports under the capability report.session.write, and the write is idempotent per
 * (source, task ref): the same session's task always answers the same report, so a repeat never makes a second one.
 *
 * What is never in a report: the raw transcript (the source service keeps it for the owner, privately), a secret
 * (the house redactor - openvibe-sdk/redact - runs over every text field before anything is stored) and code or
 * diffs (a pull request is a link; its content shows only when the repository is public).
 */
const { redact } = require('openvibe-sdk/redact');
const contracts = require('openvibe-contracts');

const ID_RE = /^rps_[0-9A-HJKMNP-TV-Z]{26}$/;
const SOURCES = new Set(['codes', 'actor', 'desk', 'node']);
const VISIBILITIES = new Set(['private', 'unlisted', 'public']);

/** The house redactor over one string. The SDK answers { text, count }. */
function scrub(text) {
    if (typeof text !== 'string' || !text) return text;
    const out = redact(text);
    return out && typeof out.text === 'string' ? out.text : text;
}

/** The house redactor over every string inside a value (strings, arrays, plain objects). */
function scrubDeep(value) {
    if (typeof value === 'string') return scrub(value);
    if (Array.isArray(value)) return value.map(scrubDeep);
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = scrubDeep(v);
        return out;
    }
    return value;
}

function str(value, max) {
    if (value == null) return null;
    const s = String(value);
    return s.length > max ? s.slice(0, max) : s;
}

function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

/**
 * The body of POST /internal/session-reports → the report it stores. Every text field goes through the redactor
 * first, so a secret or an .env line never reaches the database.
 */
function cleanBody(body) {
    const b = body && typeof body === 'object' ? body : {};
    const task = b.task && typeof b.task === 'object' ? b.task : {};
    const source = SOURCES.has(b.source) ? b.source : null;
    const title = str(scrub(task.title), 200);
    const ref = str(scrub(task.ref), 200);
    if (!source) throw new Error('source is missing or unknown');
    if (!title || !ref) throw new Error('the task needs a title and a ref');
    const owner = str(b.owner, 64);
    if (!owner) throw new Error('owner is missing');
    const outcome = ['done', 'stopped', 'failed'].includes(b.outcome) ? b.outcome : 'done';
    const summary = str(scrub(b.summary), 600);
    if (!summary) throw new Error('summary is missing');
    const timeline = (Array.isArray(b.timeline) ? b.timeline : []).slice(0, 200).map((s) => ({
        at: s && s.at ? String(s.at) : null,
        title: str(scrub(s && s.title), 120) || '',
        status: ['started', 'passed', 'failed', 'skipped'].includes(s && s.status) ? s.status : 'started',
        detail: s && s.detail ? str(scrub(s.detail), 500) : null,
        tests: s && s.tests ? { passed: num(s.tests.passed) || 0, failed: num(s.tests.failed) || 0 } : null,
        cost_usd: s && s.cost_usd != null ? num(s.cost_usd) : null,
    })).filter((s) => s.title);
    const outputs = (Array.isArray(b.outputs) ? b.outputs : []).slice(0, 50).map((o) => ({
        kind: ['pr', 'file', 'page', 'deploy', 'clip', 'vod'].includes(o && o.kind) ? o.kind : 'file',
        url: o && o.url ? str(o.url, 2048) : null,
        title: str(scrub(o && o.title), 200) || '',
        state: o && o.state ? str(scrub(o.state), 60) : null,
    })).filter((o) => o.title);
    const p = b.proof && typeof b.proof === 'object' ? b.proof : {};
    const proof = {
        tests: p.tests ? { passed: num(p.tests.passed) || 0, failed: num(p.tests.failed) || 0 } : null,
        screenshots: (Array.isArray(p.screenshots) ? p.screenshots : []).slice(0, 20).map((s) => str(s, 200)).filter(Boolean),
        review: p.review ? {
            verdict: str(scrub(p.review.verdict), 40) || '',
            notes: p.review.notes ? str(scrub(p.review.notes), 2000) : null,
        } : null,
    };
    if (proof.review && !proof.review.verdict) proof.review = null;
    const stream = b.stream && typeof b.stream === 'object' && b.stream.ags_id
        ? { ags_id: str(b.stream.ags_id, 64), vod_id: b.stream.vod_id ? str(b.stream.vod_id, 120) : null }
        : null;
    return {
        owner,
        source,
        task_ref: ref,
        task_title: title,
        task_url: task.url ? str(task.url, 2048) : null,
        started_at: b.started_at ? String(b.started_at) : null,
        ended_at: b.ended_at ? String(b.ended_at) : null,
        worked_seconds: Math.max(0, Math.round(num(b.worked_seconds) || 0)),
        outcome,
        stopped_because: b.stopped_because ? str(scrub(b.stopped_because), 300) : null,
        summary,
        timeline,
        outputs,
        proof,
        cost_usd: b.cost_usd != null ? num(b.cost_usd) : null,
        models: (Array.isArray(b.models) ? b.models : []).slice(0, 20).map((m) => str(scrub(m), 120)).filter(Boolean),
        highlights: (Array.isArray(b.highlights) ? b.highlights : []).slice(0, 5).map((h) => str(scrub(h), 200)).filter(Boolean),
        stream,
        visibility: VISIBILITIES.has(b.visibility) ? b.visibility : 'private',
        stream_only: Boolean(b.stream_only),
    };
}

function rowToReport(row) {
    if (!row) return null;
    const json = (v, fallback) => {
        if (v == null) return fallback;
        if (typeof v === 'object') return v;
        try { return JSON.parse(v); } catch { return fallback; }
    };
    return {
        id: row.id,
        owner: row.owner,
        source: row.source,
        task: { title: row.task_title, ref: row.task_ref, url: row.task_url || null },
        started_at: row.started_at,
        ended_at: row.ended_at,
        worked_seconds: Number(row.worked_seconds) || 0,
        outcome: row.outcome,
        stopped_because: row.stopped_because || null,
        summary: row.summary,
        timeline: json(row.timeline, []),
        outputs: json(row.outputs, []),
        proof: json(row.proof, { tests: null, screenshots: [], review: null }),
        cost_usd: row.cost_usd == null ? null : Number(row.cost_usd),
        models: json(row.models, []),
        highlights: json(row.highlights, []),
        stream: json(row.stream, null),
        visibility: row.visibility,
        created_at: row.created_at,
    };
}

function createSessionReports({ store, config, log = console }) {
    const db = store && store.db;
    const base = String((config && config.baseUrl) || 'https://openvibe.report').replace(/\/+$/, '');
    const urlFor = (id) => `${base}/s/${id}`;

    /** Store the report. Idempotent per (source, task ref): a repeat answers the report that is already there. */
    async function write(body) {
        if (!db) throw new Error('no database');
        const clean = cleanBody(body);
        const id = 'rps_' + contracts.ids.ulid();
        try {
            await db.prepare(`INSERT INTO report_sessions
                (id, owner, source, task_ref, task_title, task_url, started_at, ended_at, worked_seconds, outcome,
                 stopped_because, summary, timeline, outputs, proof, cost_usd, models, highlights, stream, visibility,
                 created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?::jsonb, ?, ?::jsonb, ?::jsonb, ?::jsonb, ?, now(), now())`)
                .run(id, clean.owner, clean.source, clean.task_ref, clean.task_title, clean.task_url,
                    clean.started_at, clean.ended_at, clean.worked_seconds, clean.outcome, clean.stopped_because,
                    clean.summary, JSON.stringify(clean.timeline), JSON.stringify(clean.outputs), JSON.stringify(clean.proof),
                    clean.cost_usd, JSON.stringify(clean.models), JSON.stringify(clean.highlights),
                    clean.stream ? JSON.stringify(clean.stream) : null, clean.visibility);
            return { id, url: urlFor(id), created: true };
        } catch (err) {
            const again = await db.prepare('SELECT id FROM report_sessions WHERE source = ? AND task_ref = ?')
                .get(clean.source, clean.task_ref);
            if (again) return { id: again.id, url: urlFor(again.id), created: false };
            throw err;
        }
    }

    /** One report, by id. */
    async function get(id) {
        if (!db || !ID_RE.test(String(id || ''))) return null;
        const row = await db.prepare('SELECT * FROM report_sessions WHERE id = ?').get(id);
        return rowToReport(row);
    }

    /**
     * Live's stream part: the agent stream a session streamed on.
     *
     * The tool that ran the session wrote the report; when the stream ends, the stream is added to that report
     * (matched by the same source and task ref). When there is no such report - the session was the stream itself and
     * no tool finished it - a stream-only report is written instead.
     */
    async function writeStream({ source, task_ref: taskRef, ags_id: agsId, vod_id: vodId = null, owner = null, task = null, started_at: startedAt = null, ended_at: endedAt = null, worked_seconds: workedSeconds = 0, visibility = 'private' } = {}) {
        if (!db) throw new Error('no database');
        if (!agsId) throw new Error('the agent stream id is missing');
        const attached = await attachStream({ source, task_ref: taskRef, stream: { ags_id: agsId, vod_id: vodId } });
        if (attached) return { ...attached, created: false, stream_only: false };
        if (!owner) throw new Error('the owner is missing');
        const title = (task && task.title) || 'An agent session';
        const ref = taskRef || agsId;
        return write({
            owner,
            source: source || 'desk',
            task: { title, ref },
            started_at: startedAt,
            ended_at: endedAt,
            worked_seconds: workedSeconds,
            outcome: 'done',
            summary: 'The agent streamed this session; there is no tool to finish it, so this is the stream itself.',
            timeline: [],
            outputs: vodId ? [{ kind: 'vod', title: 'The recording', url: null }] : [],
            proof: { tests: null, screenshots: [], review: null },
            cost_usd: null,
            models: [],
            highlights: [],
            stream: { ags_id: agsId, vod_id: vodId || null },
            visibility,
            stream_only: true,
        });
    }

    /** The public reports, newest first. Only these are ever listed, indexed or in the sitemap. */
    async function listPublic({ limit = 24 } = {}) {
        if (!db) return [];
        const rows = await db.prepare(
            `SELECT * FROM report_sessions WHERE visibility = 'public' ORDER BY created_at DESC, id DESC LIMIT ?`)
            .all(Math.max(1, Math.min(200, Number(limit) || 24)));
        return rows.map(rowToReport);
    }

    /** The public reports written today (the Rundown's "What agents built today"). */
    async function listPublicToday({ limit = 24, now = () => new Date() } = {}) {
        const all = await listPublic({ limit: 200 });
        const d = now();
        const day = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
        return all.filter((r) => String(r.created_at || '').slice(0, 10) === day).slice(0, limit);
    }

    /**
     * Live's stream part: the agent stream a session streamed on, matched by the same source and task ref the tool
     * used. The tool's report keeps its id; the stream is added to it.
     */
    async function attachStream({ source, task_ref: taskRef, stream }) {
        if (!db || !stream || !stream.ags_id) return null;
        const out = await db.prepare(
            'UPDATE report_sessions SET stream = ?::jsonb, updated_at = now() WHERE source = ? AND task_ref = ? RETURNING id')
            .run(JSON.stringify({ ags_id: stream.ags_id, vod_id: stream.vod_id || null }), source, taskRef);
        const id = out && out.rows && out.rows[0] && out.rows[0].id;
        return id ? { id, url: urlFor(id) } : null;
    }

    return { write, writeStream, get, listPublic, listPublicToday, attachStream, urlFor };
}

module.exports = { createSessionReports, cleanBody, scrub, scrubDeep, rowToReport, ID_RE };
