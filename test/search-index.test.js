'use strict';
/**
 * The Rundown topic pages in OpenVibe.Search (server/search-index.js): a sweep puts every topic in the outbox as one
 * report.index_document.upserted, exactly the contract (contracts 0.275.0), for a /rundown/t/<slug> page that answers;
 * a second sweep sends nothing; a topic that left the Rundown becomes a tombstone, once; a Live that does not answer
 * stops the sweep instead of tombstoning every topic.
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { boot } = require('./helpers/boot');
const { createSearchIndex, describeTopic } = require('../server/search-index');

const TOPICS = [
    { slug: 'taking-a-break', title: 'Taking a break', kind: 'life', headline: 'Streamers debate stepping away', summary: 'Fresh air and robot faces.', takes: 5, streamers: 2, first_seen_at: '2026-10-25 22:37:36', last_seen_at: '2026-11-01 10:00:00' },
    { slug: 'seattle', title: 'Seattle', kind: 'life', headline: 'A headline', summary: 'A summary.', takes: 3, streamers: 1, first_seen_at: '2026-10-20 10:00:00', last_seen_at: '2026-10-27 10:00:00' },
    { slug: 'ai-progress', title: 'AI progress', kind: 'tech', headline: 'Models got better', summary: 'Two streamers on new models.', takes: 0, streamers: 0, first_seen_at: '2026-10-21 10:00:00', last_seen_at: '2026-10-21 10:00:00' },
];

let failures = 0;
async function check(name, fn) {
    try { await fn(); process.stdout.write(`  ✓ ${name}\n`); } catch (e) { failures++; process.stdout.write(`  ✗ ${name}\n      ${(e.stack || String(e)).split('\n').slice(0, 8).join('\n      ')}\n`); }
}

(async () => {
    const t = await boot({ db: true });
    try {
        let answer = { topics: TOPICS.slice() };
        const live = { topics: async () => answer };
        const searchIndex = createSearchIndex({ config: t.config, store: t.ctx.store, live, log: { log() {}, warn() {} } });
        const db = t.ctx.store.db;
        const outbox = async () => (await db.many('SELECT envelope FROM event_outbox ORDER BY id')).map((r) => r.envelope);
        const valid = (env) => {
            assert.ok(contracts.validate('events.event-envelope@1', env).valid, 'envelope');
            const p = contracts.validate(env.event_type, env.payload);
            assert.ok(p.valid, `${env.event_type}: ${JSON.stringify(p.errors)}`);
            assert.strictEqual(env.source, 'report');
            return env;
        };

        await check('a sweep sends every topic once, as the contract says, and the page it names answers', async () => {
            const res = await searchIndex.sweep();
            assert.deepStrictEqual(res.topic, { seen: 3, sent: 3, removed: 0, failed: 0 });
            const docs = (await outbox()).map(valid).map((e) => e.payload);
            const doc = docs.find((d) => d.id === 'seattle');
            assert.strictEqual(doc.canonical_url, 'https://openvibe.report/rundown/t/seattle');
            assert.strictEqual(doc.title, 'Seattle: The Rundown');
            assert.strictEqual((await t.get('/rundown/t/seattle')).status, 200);
            assert.strictEqual(docs.find((d) => d.id === 'ai-progress').indexability.decision, 'noindex', 'a topic with no take is noindex');
            assert.strictEqual((await searchIndex.sweep()).topic.sent, 0, 'a second sweep sends nothing');
        });

        await check('a topic that left the Rundown becomes a tombstone, once', async () => {
            answer = { topics: TOPICS.filter((x) => x.slug !== 'seattle') };
            const before = (await outbox()).length;
            assert.strictEqual((await searchIndex.sweep()).topic.removed, 1);
            const env = valid((await outbox()).slice(before).find((e) => e.event_type === 'report.index_document.deleted'));
            assert.deepStrictEqual([env.payload.type, env.payload.id], ['topic', 'seattle']);
            assert.strictEqual((await searchIndex.sweep()).topic.removed, 0);
        });

        await check('when Live does not answer, the sweep stops and tombstones nothing', async () => {
            answer = null;
            const before = (await outbox()).length;
            await assert.rejects(() => searchIndex.sweep(), /did not answer/);
            assert.strictEqual((await outbox()).length, before);
        });

        await check('the words: headline, takes and streamers; Live\'s zone-less times are UTC', async () => {
            const d = describeTopic(TOPICS[0]);
            assert.strictEqual(d.summary, 'Streamers debate stepping away. 5 takes from 2 streamers on OpenVibe.Live.');
            assert.deepStrictEqual(d.facets, { kind: 'life', takes: 5, streamers: 2 });
            assert.strictEqual(d.publishedAt, '2026-10-25T22:37:36.000Z');
            assert.strictEqual(d.noindex, false);
        });
    } finally {
        await t.close();
        process.stdout.write(failures ? `\n${failures} failed\n` : '\nall passed\n');
        process.exit(failures ? 1 : 0);
    }
})();
