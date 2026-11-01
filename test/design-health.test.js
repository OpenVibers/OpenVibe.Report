'use strict';
/**
 * openvibe.report/design (plan L45 step 6): every site's design health from the snapshot, most to fix first, with a
 * counted fold past fifteen; a site's page with its counts and each finding linked to its line at the measured commit;
 * the same as JSON; an unknown site is a 404; a repo with nothing to read is left out; every value from the snapshot
 * is escaped. The real snapshot (server/design-health/snapshot.json) must parse and hold sites.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FIXTURE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dh-')), 'design-health.json');
const counts = (o) => ({ literal_duration: 0, literal_curve: 0, spinner: 0, color_drift: 0, missing_reduced_motion: 0, total: 0, ...o });
const sites = [
    { repo: 'OpenVibe.Live', commit: 'abcdef1234567890', files_scanned: 119, score: 12.5, findings_total: 40, counts: counts({ spinner: 1, literal_duration: 30, total: 31 }),
        findings: [{ rule: 'spinner', file: 'public/css/style.css', line: 489, value: 'spin', text: '@keyframes spin{to{transform:rotate(360deg)}} <script>alert(1)</script>' }] },
    { repo: 'OpenVibe.Zone', commit: '1111111222222', files_scanned: 1, score: 100, findings_total: 0, counts: counts({}), findings: [] },
    { repo: 'OpenVibe.SDK', commit: '333', files_scanned: 0, score: 100, findings_total: 0, counts: counts({}), findings: [] },
];
for (let i = 0; i < 16; i++) sites.push({ repo: `OpenVibe.Site${i}`, commit: 'c0ffee', files_scanned: 3, score: 90 + i / 2, findings_total: 2, counts: counts({ literal_curve: 2, total: 2 }), findings: [] });
fs.writeFileSync(FIXTURE, JSON.stringify({ generated_at: '2026-11-01T11:00:00.000Z', rules: ['literal_duration', 'literal_curve', 'spinner', 'color_drift', 'missing_reduced_motion'], weights: { spinner: 4, missing_reduced_motion: 2, literal_duration: 0.25, literal_curve: 0.25, color_drift: 0.05 }, kept: 25, sites }));
process.env.DESIGN_HEALTH_FILE = FIXTURE;

const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    try {
        await check('/design: every site with something to read, most to fix first, fifteen in view and the rest in a counted fold', async () => {
            const r = await t.get('/design');
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=120');
            assert.ok(r.text.includes('<h1>Design health of every site</h1>'));
            assert.ok(r.text.includes('<link rel="canonical" href="https://openvibe.report/design">'));
            assert.ok(!r.text.includes('OpenVibe.SDK'), 'a repo with no stylesheet is not scored');
            const first = r.text.indexOf('href="/design/live"'), zone = r.text.indexOf('href="/design/zone"');
            assert.ok(first > 0 && zone > first, 'the lowest score comes first');
            assert.match(r.text, /<summary>All 18 sites <span>3 more<\/span><\/summary>/);
            assert.ok(r.text.includes('<b class="rp-tile-v">1</b><span class="rp-tile-s">still to replace</span>'), 'the spinners are counted');
            assert.ok(r.text.includes('class="dh-score is-low" style="--dh:12.5%"'), 'the score is a bar in its band');
            assert.ok(r.text.includes('server/design-health/scan.js'), 'the rules are linked');
        });

        await check('/design/:site: the counts, and each finding opens its line at the measured commit, escaped', async () => {
            const r = await t.get('/design/live');
            assert.strictEqual(r.status, 200);
            assert.ok(r.text.includes('<h1>OpenVibe.Live</h1>'));
            assert.ok(r.text.includes('href="https://github.com/OpenVibers/OpenVibe.Live/blob/abcdef1234567890/public/css/style.css#L489"'));
            assert.ok(r.text.includes('1 of 40: the ones that cost most'));
            assert.ok(!r.text.includes('<script>alert(1)</script>'), 'a finding\'s text is escaped');
            assert.ok(r.text.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
            const clean = await t.get('/design/zone');
            assert.ok(clean.text.includes('Nothing to fix'));
        });

        await check('an unknown or malformed site is a 404 page and a 404 problem', async () => {
            assert.strictEqual((await t.get('/design/nope')).status, 404);
            assert.strictEqual((await t.get('/design/sdk')).status, 404, 'left out of the snapshot\'s sites');
            assert.strictEqual((await t.get('/design/%3Cx%3E')).status, 404);
            const api = await t.get('/api/v1/design-health/nope');
            assert.strictEqual(api.status, 404);
            assert.match(api.headers.get('content-type') || '', /problem\+json/);
        });

        await check('the same as JSON, CORS-open', async () => {
            const r = await t.get('/api/v1/design-health');
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.headers.get('access-control-allow-origin'), '*');
            const j = r.json();
            assert.strictEqual(j.sites.length, 18);
            assert.strictEqual(j.weights.spinner, 4);
            const one = (await t.get('/api/v1/design-health/live')).json();
            assert.strictEqual(one.site.repo, 'OpenVibe.Live');
            assert.strictEqual(one.site.findings[0].line, 489);
        });

        await check('the snapshot parses and holds sites with counts', async () => {
            const real = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'design-health', 'snapshot.json'), 'utf8'));
            assert.ok(Array.isArray(real.sites) && real.sites.length >= 20, `${(real.sites || []).length} sites`);
            for (const s of real.sites) {
                assert.ok(s.repo && s.counts && Number.isFinite(Number(s.score)), s.repo);
                assert.ok(Number(s.files_scanned) > 0, `${s.repo}: nothing to read, so not in the snapshot`);
            }
        });
    } finally {
        await t.close();
        fs.rmSync(path.dirname(FIXTURE), { recursive: true, force: true });
    }
    done();
})().catch((err) => { console.error(err); process.exit(1); });
