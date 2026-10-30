'use strict';
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
(async () => {
    const t = await boot();
    try {
        await check('the topics are one pick block: a chip per topic, the first picked, every topic in the page', async () => {
            const r = await t.get('/');
            assert.strictEqual(r.status, 200, r.text);
            const page = r.text;
            const start = page.indexOf('<div class="pick" id="pick-topics">');
            assert.ok(start > 0, 'the pick block is on the home');
            const block = page.slice(start, start + 8000);
            assert.match(block, /<div class="pick-row" role="radiogroup" aria-label="What streamers talked about">/);
            const chips = [...block.matchAll(/<input type="radio" name="pick-topics" id="pk-topics-(\d+)" value="\1"( checked)?><label for="pk-topics-\d+">([^<]+)<\/label>/g)];
            assert.ok(chips.length >= 1, 'a chip per topic (' + chips.length + ')');
            assert.deepStrictEqual(chips.filter((m) => m[2]).map((m) => m[1]), [chips[0][1]], 'the first topic is picked');
            const topics = [...block.matchAll(/<li data-i="(\d+)"><a class="rp-topic"/g)];
            assert.strictEqual(topics.length, chips.length, 'every topic is in the page');
            assert.deepStrictEqual(topics.map((m) => m[1]), chips.map((m) => m[1]), 'each topic knows its chip');
        });
        await check('the CSS guard: the chips are hidden and the topics all show until 640 px and where :has() is understood', async () => {
            const r = await t.get('/');
            const page = r.text;
            assert.match(page, /<style>@supports selector\(:has\(\*\)\)\{@media \(max-width:640px\)\{\.pick#pick-topics:has\(#pk-topics-0:checked\) \.pick-list>li\[data-i="0"\]\{display:block\}/, 'the rule that shows the picked topic');
            const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
            assert.match(css, /\.pick-row \{ display: none; \}/, 'the chips are hidden by default');
            assert.match(css, /@supports selector\(:has\(\*\)\) \{ @media \(max-width: 640px\) \{/, 'the phone rules are under :has() and 640 px');
            assert.match(css, /\.pick-row label \{[^}]*min-height: 44px/, 'a chip is a 44 px target');
            assert.match(css, /\.pick \.pick-list > li \{ display: none; \}/, 'the topics are hidden on a phone');
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
