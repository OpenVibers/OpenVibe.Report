'use strict';
// design-lint/test.js — the lint's own tests: plain node and assert, over small fixtures.
//
//   node test.js
//
// Each rule has to find what it should, and a clean fixture has to stay clean.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { scanRepo, scoreOf } = require('../server/design-health/scan.js');

// ── the fixtures ─────────────────────────────────────────────────────────────────────────────────────────────
// a repo where every style already goes through the kit
const CLEAN_CSS = [
    '/* a site that already uses the kit */',
    '.card {',
    '    background: var(--bg-primary);',
    '    color: var(--text-primary);',
    '    border: 1px solid var(--border);',
    '    transition: transform var(--ov-dur-2) var(--ov-ease-out);',
    '}',
    '.card:hover { transform: translateY(-2px); }',
    '.fade { animation: fade var(--ov-dur-3) var(--ov-ease-in-out) both; }',
    '@keyframes fade { from { opacity: 0; } to { opacity: 1; } }',
    '@media (prefers-reduced-motion: reduce) {',
    '    .card, .fade { transition: none; animation: none; }',
    '}',
    ''
].join('\n');

// a repo that writes its own timing, its own curves, its own spinner and its own colours
const DIRTY_CSS = [
    '/* a site that hand-writes what the kit owns */',
    '.card {',
    '    background: var(--bg-primary);',
    '    transition: transform .25s ease;',
    '}',
    '.panel { animation: fade 300ms cubic-bezier(.4, 0, .2, 1) both; }',
    '.slow { transition-duration: 1.4s; }',
    '.badge { color: #ff006e; background: rgb(0, 255, 65); }',
    '@keyframes spin { to { transform: rotate(360deg); } }',
    '.spinner { animation: spin 1s linear infinite; }',
    ''
].join('\n');

// an inline <style> in HTML
const DIRTY_HTML = [
    '<!doctype html>',
    '<html><head>',
    '<style>',
    '    .hero { color: #ff006e; background: var(--bg-primary); transition: opacity .2s ease-in-out; }',
    '    .hero2 { animation: pulse 800ms linear infinite; }',
    '    @keyframes pulse { to { transform: rotate(360deg); } }',
    '</style>',
    '</head><body><div class="hero">hi</div></body></html>',
    ''
].join('\n');

const CLEAN_HTML = [
    '<!doctype html>',
    '<html><head>',
    '<style>',
    '    .hero { color: var(--text-primary); transition: opacity var(--ov-dur-1) var(--ov-ease-out); }',
    '</style>',
    '</head><body><div class="hero">hi</div></body></html>',
    ''
].join('\n');

// ── the harness ──────────────────────────────────────────────────────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'design-lint-test-'));

function makeRepo(files) {
    const dir = fs.mkdtempSync(path.join(TMP, 'repo-'));
    for (const rel of Object.keys(files)) {
        const full = path.join(dir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, files[rel]);
    }
    return dir;
}

const results = [];
function test(name, fn) {
    try {
        fn();
        results.push({ name, ok: true });
    } catch (err) {
        results.push({ name, ok: false, err });
    }
}

const rulesOf = (res, rule) => res.findings.filter((f) => f.rule === rule);
const countOf = (res, rule) => res.counts[rule] || 0;

// ── the tests ─────────────────────────────────────────────────────────────────────────────────────────────────
const clean = scanRepo(makeRepo({ 'public/css/site.css': CLEAN_CSS, 'public/index.html': CLEAN_HTML }));

test('a clean file has no findings at all', () => {
    assert.deepStrictEqual(clean.counts, { literal_duration: 0, literal_curve: 0, spinner: 0, color_drift: 0, missing_reduced_motion: 0, total: 0 });
    assert.deepStrictEqual(clean.findings, []);
});

test('a clean file scores 100', () => {
    assert.strictEqual(clean.score, 100);
});

test('the kit tokens are never read as drift', () => {
    assert.strictEqual(countOf(clean, 'literal_duration'), 0);
    assert.strictEqual(countOf(clean, 'literal_curve'), 0);
});

const dirty = scanRepo(makeRepo({ 'public/css/site.css': DIRTY_CSS }));

test('a literal duration is found, with its file and line', () => {
    const found = rulesOf(dirty, 'literal_duration');
    assert.ok(found.length >= 3, 'expected at least three literal durations, got ' + found.length);
    assert.ok(found.some((f) => f.value === '.25s' && f.file === 'public/css/site.css'));
    assert.ok(found.some((f) => f.value === '300ms'));
    assert.ok(found.some((f) => f.value === '1.4s'));
    assert.ok(found.every((f) => f.line > 0));
    assert.ok(found.every((f) => f.file === 'public/css/site.css'));
});

test('a literal curve is found, whether a cubic-bezier or an ease keyword', () => {
    const found = rulesOf(dirty, 'literal_curve');
    assert.ok(found.some((f) => /cubic-bezier/i.test(f.value)), 'expected a cubic-bezier curve');
    assert.ok(found.some((f) => /^ease/i.test(f.value)), 'expected an ease keyword');
});

test('a spinner is found: the keyframes that turn, and the animation that runs them forever', () => {
    const found = rulesOf(dirty, 'spinner');
    assert.ok(found.some((f) => f.kind === 'spinner_keyframes' && f.value === 'spin'), 'expected the spin keyframes');
    assert.ok(found.some((f) => f.kind === 'spinner_usage' && f.value === 'spin'), 'expected the infinite animation');
});

test('a hard-coded colour is found in a file that already uses the theme', () => {
    const found = rulesOf(dirty, 'color_drift');
    assert.ok(found.some((f) => f.value === '#ff006e'), 'expected the hex colour');
    assert.ok(found.some((f) => /rgb/i.test(f.value)), 'expected the rgb colour');
});

test('a file that animates without prefers-reduced-motion is found', () => {
    const found = rulesOf(dirty, 'missing_reduced_motion');
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].file, 'public/css/site.css');
});

test('an inline <style> in HTML is linted like a CSS file', () => {
    const html = scanRepo(makeRepo({ 'public/index.html': DIRTY_HTML }));
    assert.ok(countOf(html, 'literal_duration') >= 1, 'expected a literal duration in the inline style');
    assert.ok(countOf(html, 'literal_curve') >= 1, 'expected a literal curve in the inline style');
    assert.ok(countOf(html, 'spinner') >= 1, 'expected a spinner in the inline style');
    assert.ok(countOf(html, 'color_drift') >= 1, 'expected colour drift in the inline style');
    assert.strictEqual(countOf(html, 'missing_reduced_motion'), 1);
});

test('an inline <style> that uses the kit is clean', () => {
    const html = scanRepo(makeRepo({ 'public/index.html': CLEAN_HTML }));
    assert.strictEqual(html.counts.total, 0, JSON.stringify(html.findings));
});

test('the spinner is not reported without infinite', () => {
    const repo = makeRepo({ 'public/css/site.css': '@keyframes spin { to { transform: rotate(360deg); } }\n.a { animation: spin 1s linear; }\n' });
    const res = scanRepo(repo);
    assert.strictEqual(countOf(res, 'spinner'), 1, 'only the keyframes, not the finite animation');
    assert.strictEqual(rulesOf(res, 'spinner')[0].kind, 'spinner_keyframes');
});

test('a keyframes that does not turn is not a spinner', () => {
    const repo = makeRepo({ 'public/css/site.css': '@keyframes fade { from { opacity: 0; } to { opacity: 1; } }\n.a { animation: fade 1s linear infinite; }\n' });
    const res = scanRepo(repo);
    assert.strictEqual(countOf(res, 'spinner'), 0);
});

test('a var() fallback is not read as a hard-coded colour', () => {
    const repo = makeRepo({ 'public/css/site.css': '.a { color: var(--accent, #ff006e); background: var(--bg-primary); }\n' });
    const res = scanRepo(repo);
    assert.strictEqual(countOf(res, 'color_drift'), 0, JSON.stringify(rulesOf(res, 'color_drift')));
});

test('a file with no theme variables is not judged for colour drift', () => {
    const repo = makeRepo({ 'public/css/site.css': '.a { color: #ff006e; background: #000; }\n' });
    const res = scanRepo(repo);
    assert.strictEqual(countOf(res, 'color_drift'), 0);
});

test('the score is 100 minus the weighted counts, clamped at 0', () => {
    assert.strictEqual(scoreOf({ spinner: 0, missing_reduced_motion: 0, literal_duration: 0, literal_curve: 0, color_drift: 0 }), 100);
    const one = scoreOf({ spinner: 1, missing_reduced_motion: 0, literal_duration: 0, literal_curve: 0, color_drift: 0 });
    assert.ok(one < 100 && one > 90, 'a spinner costs the most, got ' + one);
    const many = scoreOf({ spinner: 100, missing_reduced_motion: 0, literal_duration: 0, literal_curve: 0, color_drift: 0 });
    assert.strictEqual(many, 0, 'the score never goes below 0');
    const over = scoreOf({ spinner: 0, missing_reduced_motion: 0, literal_duration: 0, literal_curve: 0, color_drift: 100000 });
    assert.strictEqual(over, 0, 'a pile of colour drift cannot push the score below 0 either');
});

test('the weights are in order: spinner, then reduced motion, then duration and curve, then colour', () => {
    const cost = (rule) => 100 - scoreOf({ spinner: 0, missing_reduced_motion: 0, literal_duration: 0, literal_curve: 0, color_drift: 0, [rule]: 1 });
    assert.ok(cost('spinner') > cost('missing_reduced_motion'), 'a spinner weighs more than a missing reduced motion');
    assert.ok(cost('missing_reduced_motion') > cost('literal_duration'), 'a missing reduced motion weighs more than a literal duration');
    assert.strictEqual(cost('literal_duration'), cost('literal_curve'), 'a duration and a curve weigh the same');
    assert.ok(cost('literal_curve') > cost('color_drift'), 'a literal curve weighs more than a hard-coded colour');
});

test('the score falls as the findings pile up', () => {
    const full = scoreOf({ spinner: 0, missing_reduced_motion: 0, literal_duration: 0, literal_curve: 0, color_drift: 0 });
    const some = scoreOf({ spinner: 0, missing_reduced_motion: 1, literal_duration: 2, literal_curve: 2, color_drift: 0 });
    assert.ok(some < full);
});

test('node_modules, vendor and .min. files are skipped', () => {
    const repo = makeRepo({
        'public/css/site.css': CLEAN_CSS,
        'public/node_modules/pkg/x.css': DIRTY_CSS,
        'public/vendor/x.css': DIRTY_CSS,
        'public/css/site.min.css': DIRTY_CSS
    });
    const res = scanRepo(repo);
    assert.strictEqual(res.counts.total, 0, JSON.stringify(res.findings));
});

test('the findings are sorted by file and line', () => {
    const repo = makeRepo({ 'public/css/b.css': DIRTY_CSS, 'public/css/a.css': DIRTY_CSS });
    const res = scanRepo(repo);
    for (let i = 1; i < res.findings.length; i++) {
        const prev = res.findings[i - 1];
        const cur = res.findings[i];
        assert.ok(prev.file < cur.file || (prev.file === cur.file && prev.line <= cur.line), 'not sorted at ' + i);
    }
});

test('an empty repo is clean', () => {
    const res = scanRepo(makeRepo({ 'README.md': '# nothing here' }));
    assert.strictEqual(res.counts.total, 0);
    assert.strictEqual(res.score, 100);
});

// ── the report ───────────────────────────────────────────────────────────────────────────────────────────────
let failed = 0;
for (const r of results) {
    if (r.ok) {
        console.log('  ok   ' + r.name);
    } else {
        failed++;
        console.log('  FAIL ' + r.name);
        console.log('       ' + (r.err && r.err.message ? String(r.err.message).split('\n').join('\n       ') : r.err));
    }
}
console.log('');
console.log((results.length - failed) + '/' + results.length + ' passed');
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* the temp dir is the OS's problem now */ }
process.exit(failed ? 1 : 0);
