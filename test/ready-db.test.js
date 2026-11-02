'use strict';
/**
 * The readiness `db` check reads the store app.js hands it. createServiceReadiness took no `store`, so the check threw
 * "store is not defined" and openvibe.report answered degraded with a working database (2026-11-02).
 *
 *   node test/ready-db.test.js
 */
const assert = require('assert');
const { createServiceReadiness } = require('../server/observability');

(async () => {
    const config = { db: { url: 'postgres://report' }, source: 'shadow', networkUrl: 'http://127.0.0.1:1', liveUrl: 'http://127.0.0.1:1' };
    const fetchImpl = async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    const run = async (store) => {
        const r = createServiceReadiness({ config, fetchImpl, release: 'test', store });
        const body = typeof r.run === 'function' ? await r.run() : await r.check();
        return body.checks.db;
    };
    const ok = await run({ db: { value: async () => 1 } });
    assert.strictEqual(ok.status, 'ok', JSON.stringify(ok));
    const down = await run({ db: { value: async () => { throw new Error('connection refused'); } } });
    assert.notStrictEqual(down.status, 'ok');
    assert.match(String(down.error), /database did not answer: connection refused/);
    const none = await run(null);
    assert.match(String(none.error), /no database handle/);
    console.log('ready db: the check reads the store it is given');
})().catch((err) => { console.error(err); process.exit(1); });
