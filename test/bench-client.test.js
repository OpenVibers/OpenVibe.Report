'use strict';

const assert = require('assert');
const { createBenchClient } = require('../server/data/bench');
const { check, done, jsonResponse } = require('./helpers/boot');

(async () => {
    let time = Date.parse('2026-10-28T12:00:00Z');
    let down = false;
    let calls = 0;
    const fetchImpl = async () => {
        calls++;
        if (down) throw new Error('Bench offline');
        return jsonResponse({ count: 1, kinds: [{ id: 'design.page', room: 'design' }] });
    };
    const logs = [];
    const bench = createBenchClient({ config: { benchUrl: 'http://bench.test' }, fetchImpl, now: () => time, log: { warn: (line) => logs.push(line) } });

    await check('Bench reads stay fresh for 60 seconds and keep their source time', async () => {
        const first = await bench.kinds();
        time += 59_999;
        const second = await bench.kinds();
        assert.deepStrictEqual(second, first);
        assert.strictEqual(calls, 1);
        assert.strictEqual(first.at, '2026-10-28T12:00:00.000Z');
    });

    await check('a failed refresh serves the last good copy with its time', async () => {
        down = true;
        time++;
        const stale = await bench.kinds();
        assert.strictEqual(stale.stale, true);
        assert.strictEqual(stale.at, '2026-10-28T12:00:00.000Z');
        assert.strictEqual(stale.data.kinds[0].id, 'design.page');
        assert.strictEqual(calls, 2);
        assert.strictEqual(logs.length, 1);
        time += 30_000;
        assert.strictEqual((await bench.kinds()).stale, true);
        assert.strictEqual(calls, 2, 'the failed refresh also has a 60-second retry pause');
    });

    await check('invalid parameters never reach Bench', async () => {
        assert.strictEqual(await bench.board('../bad'), null);
        assert.strictEqual(await bench.board('design.page', 'wrong'), null);
        assert.strictEqual(await bench.modelSummary('bad?name'), null);
        assert.strictEqual(await bench.benchmark('../bad'), null);
        assert.strictEqual(await bench.rankings('not-a-benchmark'), null);
        assert.strictEqual(await bench.runs({ benchmark: '../bad' }), null);
        assert.strictEqual(await bench.modelDetail('bad?name'), null);
        assert.strictEqual(calls, 2);
        assert.strictEqual(bench.isModelName('openai/gpt-4o'), true);
        assert.strictEqual(bench.isBenchmarkId('bmk_01M65KA3H4Y4ZENBYYZQA8SRNN'), true);
        assert.strictEqual(bench.normaliseLimit(0), 1);
        assert.strictEqual(bench.normaliseLimit(1000), 100);
    });

    done();
})().catch((e) => { console.error(e); process.exit(1); });
