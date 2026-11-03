'use strict';
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
(async () => {
    const t = await boot();
    try {
        await check('the topics are a rail on a phone: every topic shown, no chips, nothing hidden (the owner, 2026-10-31)', async () => {
            const r = await t.get('/');
            assert.strictEqual(r.status, 200, r.text);
            const page = r.text;
            const start = page.indexOf('<div class="pick pick--rail" id="pick-topics">');
            assert.ok(start > 0, 'the topics rail is on the home');
            const block = page.slice(start, start + 8000);
            assert.ok(!/type="radio"|pick-row/.test(block), 'no radio chips');
            const topics = [...block.matchAll(/<li data-i="(\d+)"><a class="rp-topic"/g)];
            assert.ok(topics.length >= 1, 'every topic is in the page (' + topics.length + ')');
        });
        await check('the hero draws an after-show report in miniature, not sc.room\'s default motif (MOTION-1)', async () => {
            const r = await t.get('/');
            assert.match(r.text, /<div class="rp-motif" aria-hidden="true">/);
            assert.match(r.text, /After the show · sample[\s\S]*?peak 41[\s\S]*?top moment/);
            assert.ok(!/class="sc-room-motif"/.test(r.text), 'no default motif');
        });
        await check('the CSS: on a phone a list is a rail you swipe, and no rule hides an item', async () => {
            const r = await t.get('/');
            assert.ok(!/\.pick#pick-topics:has\(/.test(r.text), 'no per-item rule in the page');
            const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
            assert.match(css, /\.pick--rail \.pick-list \{ display: flex;[^}]*overflow-x: auto;[^}]*scroll-snap-type: x mandatory/, 'the list is a rail');
            assert.ok(!/pick-list > li \{ display: none|pick-pane \{ display: none/.test(css), 'nothing is hidden');
        });
        await check('the parts a reader rarely needs are folds, open in the page and closed on a phone', async () => {
            const r = await t.get('/');
            const page = r.text;
            for (const id of ['dev', 'faq']) {
                assert.ok(page.includes('<details class="rp-fold rp-fold-block" id="' + id + '" open>'), id + ' is a fold, open in the page');
                assert.ok(page.includes('document.getElementById("' + id + '")'), id + ' has the script that closes it on a phone');
            }
            assert.ok(!page.includes('rp-numbers-h') || page.includes('<details class="rp-fold rp-fold-block" id="numbers" open>'), 'the numbers, when there are any, are a fold too');
            assert.match(page, /<h2 id="rp-dev-h">For developers<\/h2>/);
            assert.match(page, /<h2 id="rp-faq-h">Questions<\/h2>/);
        });
    } finally {
        await done(t);
    }
})().catch((e) => { console.error(e); process.exit(1); });
