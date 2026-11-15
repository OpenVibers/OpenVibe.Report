'use strict';
// The browser check (11-15): /stats carries the Dataset JSON-LD "Every number on OpenVibe" (the home names it so since
// #251), and /stats never said that name, so its structured data named something a reader could not see.
const assert = require('assert');
const views = require('../server/views');

const html = views.stats({ stats: { note: 'Counted by each site.', sites: [], window_days: 30 }, days: 30 });
const ld = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1])).flat();
const dataset = ld.find((n) => n && n['@type'] === 'Dataset');
assert.ok(dataset, 'the page carries the Dataset');
const visible = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<title[\s\S]*?<\/title>/g, '').replace(/<[^>]+>/g, ' ');
assert.ok(visible.includes(dataset.name), `"${dataset.name}" is on the page`);
console.log('stats-dataset-visible: /stats says the name its Dataset gives');
