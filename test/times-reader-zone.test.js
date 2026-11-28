'use strict';
// Plan item 13: Report says a moment in the reader's own zone and clock. whenTag writes a <time data-ov-time="day"> that
// Shared's theme loader rewrites; the UTC words stay for crawlers and no-script (11-28: /stats said "Read Nov 28, 07:50
// UTC" and /traffic's "Last" column every time in UTC, to everyone).
const assert = require('assert');
const { whenTag } = require('../server/views');

assert.strictEqual(whenTag('2026-11-28T07:50:12.000Z'), '<time datetime="2026-11-28T07:50:12.000Z" data-ov-time="day">Nov 28, 07:50 UTC</time>');
// Live's zone-less "YYYY-MM-DD HH:MM:SS" is UTC: the same instant.
assert.strictEqual(whenTag('2026-11-28 07:50:12'), '<time datetime="2026-11-28T07:50:12.000Z" data-ov-time="day">Nov 28, 07:50 UTC</time>');
assert.strictEqual(whenTag(null), '');
assert.strictEqual(whenTag('not a time'), '');
console.log('times-reader-zone: Report writes each moment as a <time> the reader\'s zone rewrites, UTC words as the fallback');
