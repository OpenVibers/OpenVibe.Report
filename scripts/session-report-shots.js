'use strict';
/**
 * The report page, shot locally (no deployment, no network): 390 and 1280, dark and light.
 *
 *   node scripts/session-report-shots.js [outDir]
 */
const path = require('path');
const fs = require('fs');
const { boot } = require('../test/helpers/boot');
const { chromium } = require('/home/workstation/openvibe/work/OpenVibe.Games/node_modules/playwright');
const { BUILTIN_THEMES } = require('openvibe-shared/builtin-themes');

// The site wears the theme it is given: the frame reads it from localStorage (ov_theme), and the network's theme
// service is not reachable offline, so the light shots are taken with the site's own light theme (Paper).
const lightTheme = (Array.isArray(BUILTIN_THEMES) ? BUILTIN_THEMES : Object.values(BUILTIN_THEMES || {}))
    .find((t) => t && t.id === 'paper');

const outDir = process.argv[2] || '/tmp/report-shots';

(async () => {
    const t = await boot({ db: true, now: () => Date.parse('2026-11-06T20:00:00Z') });
    try {
        const out = await t.ctx.sessionReports.write({
            owner: 'usr_01JAN2C3D4E5F6G7H8J9K0MNPS',
            source: 'codes',
            task: { title: 'Ship the checkout page', ref: 'tsk_01JAN2C3D4E5F6G7H8J9K0MNPS', url: 'https://openvibe.codes/t/tsk_01JAN2C3D4E5F6G7H8J9K0MNPS' },
            started_at: '2026-11-06T18:00:00.000Z',
            ended_at: '2026-11-06T18:42:00.000Z',
            worked_seconds: 2520,
            outcome: 'done',
            summary: 'Asked for a checkout page; the agent read the shop, built the page, ran the tests and opened a pull request.',
            timeline: [
                { at: '2026-11-06T18:03:00.000Z', title: 'Read the shop code', status: 'passed', detail: 'The coupon logic lives in cart.js' },
                { at: '2026-11-06T18:21:00.000Z', title: 'Build the checkout page', status: 'passed' },
                { at: '2026-11-06T18:33:00.000Z', title: 'Run the checkout tests', status: 'passed', tests: { passed: 12, failed: 0 } },
            ],
            outputs: [
                { kind: 'pr', url: 'https://forgejo.example/openvibe/site/pulls/7', title: 'Checkout page', state: 'open' },
                { kind: 'vod', url: 'https://openvibe.video/v/vod_01JAN2C3D4E5F6G7H8J9K0MNPS', title: 'The recording' },
            ],
            proof: {
                tests: { passed: 12, failed: 0 },
                screenshots: ['med_01JAN2C3D4E5F6G7H8J9K0MNPS'],
                review: { verdict: 'Looks good', notes: 'The mobile layout needs a wider gutter on the totals row.' },
            },
            cost_usd: 0.31,
            models: ['claude-sonnet-4'],
            highlights: ['Found the coupon bug on the first read', 'Twelve tests, no failures'],
            visibility: 'public',
        });
        const url = t.base + '/s/' + out.id;
        fs.mkdirSync(outDir, { recursive: true });
        const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
        const notes = [];
        for (const [w, scheme] of [[390, 'dark'], [390, 'light'], [1280, 'dark'], [1280, 'light']]) {
            const pg = await b.newPage({
                viewport: { width: w, height: 900 }, colorScheme: scheme, deviceScaleFactor: 2,
                isMobile: w < 700, hasTouch: w < 700,
            });
            const errs = [];
            pg.on('pageerror', (e) => errs.push(e.message));
            pg.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
            await pg.goto(url, { waitUntil: 'load' });
            // The site wears its own theme; the light shots put the light theme on (the offline frame cannot ask
            // openvibe.network which one the person chose).
            if (scheme === 'light') {
                await pg.addInitScript((theme) => {
                    try { localStorage.setItem('ov_theme', JSON.stringify(theme)); } catch (e) { /* */ }
                }, lightTheme);
            }
            await pg.waitForTimeout(1200);
            if (scheme === 'light') {
                // The site's own theme variables, put on the page the way the frame does it (openvibe-shared/app-icon.js):
                // the network's theme service is not reachable offline, so the light theme is applied here.
                await pg.evaluate((theme) => {
                    const el = document.documentElement;
                    const vars = (theme && theme.variables) || {};
                    for (const [k, v] of Object.entries(vars)) if (k.charAt(0) === '-') el.style.setProperty(k, v);
                    if (vars['--bg-primary']) el.style.background = vars['--bg-primary'];
                    if (vars['--text-primary']) el.style.color = vars['--text-primary'];
                    if (vars['--color-scheme']) el.style.colorScheme = vars['--color-scheme'];
                    if (theme && theme.id) el.setAttribute('data-theme', theme.id);
                }, lightTheme);
                await pg.waitForTimeout(400);
            }

            const docW = await pg.evaluate(() => document.documentElement.scrollWidth);
            const file = path.join(outDir, 'session-report-' + w + '-' + scheme + '.png');
            await pg.screenshot({ path: file, fullPage: true });
            notes.push({ width: w, scheme, scrollWidth: docW, overflow: docW > w, errors: errs, file });
            await pg.close();
        }
        await b.close();
        console.log(JSON.stringify({ url, notes }, null, 2));
    } finally {
        await t.close();
    }
})().catch((e) => { console.error(e); process.exit(1); });
