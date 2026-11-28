'use strict';
// /stats shows how fast OpenVibe.Live feels for real visitors (11-28, plan AD.37 Reflect): Live's GET /api/rum/summary,
// one row per page and device, graded like Core Web Vitals; nothing when Live has no summary.
const assert = require('assert');
const views = require('../server/views');

const base = { totals: { pageviews: 10 }, sites: [], generated_at: '2026-11-28T08:00:00Z', window_days: 7 };
const speed = {
    generated_at: '2026-11-28T08:30:00.000Z',
    pages: {
        'home|tablet': { lcp: { p75: 4116, n: 45 }, inp: { p75: 408, n: 51 }, cls: { p75: 0.345, n: 51 } },
        'home|phone': { lcp: { p75: 1388, n: 400 }, inp: { p75: 152, n: 400 }, cls: { p75: 0.06, n: 400 } },
        'channel|desktop<script>': { lcp: { p75: 1, n: 30 } },
    },
};
const html = views.stats({ stats: base, days: 7, speed }).html || views.stats({ stats: base, days: 7, speed });
const page = String(html);
assert.ok(page.includes('How fast OpenVibe.Live feels'), 'the section is there');
assert.match(page, /Home<small>phone<\/small>[\s\S]*1\.4 s <span class="rp-pill is-up">good<\/span>[\s\S]*152 ms <span class="rp-pill is-up">good<\/span>[\s\S]*0\.06 <span class="rp-pill is-up">good<\/span>/);
assert.match(page, /Home<small>tablet<\/small>[\s\S]*4\.1 s <span class="rp-pill is-down">slow<\/span>[\s\S]*408 ms <span class="rp-pill is-flat">needs work<\/span>[\s\S]*0\.35 <span class="rp-pill is-down">slow<\/span>/);
assert.ok(page.indexOf('Home<small>phone') < page.indexOf('Home<small>tablet'), 'phone, then tablet, then desktop');
assert.ok(!page.includes('<script>') || !page.includes('channel|desktop<script>'), 'only known pages and devices are drawn');
assert.ok(!String(views.stats({ stats: base, days: 7 }).html || views.stats({ stats: base, days: 7 })).includes('How fast OpenVibe.Live feels'), 'no summary, no section');
console.log('stats-live-speed: /stats shows what real visitors felt on Live, graded, per page and device');
