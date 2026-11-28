'use strict';
/**
 * Traffic (plan AD.40; the owner 2026-11-28: "all files like loops or llms.txt or llms-full should have their own
 * analytics … so we know whats up with which bots … separate bot traffic"): who asked (people, each bot by name and
 * kind, a crawler's claim checked by forward-confirmed reverse DNS), what was asked for (the files sites publish for
 * machines by name; pages by section; never a token), the collector reading the host's log from its saved place across
 * a half-written line and a rotation, never keeping an address, and the pages and API that show it.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { boot, check, done } = require('./helpers/boot');
const { classify } = require('../server/traffic/agents');
const { kindOf } = require('../server/traffic/paths');
const { createTrafficCollector } = require('../server/traffic/collect');
const { createVerifier } = require('../server/traffic/verify');
const { sourceOf, countryOf } = require('../server/traffic/sources');

const today = new Date().toISOString().slice(0, 10);
const at = (sec) => `${today}T00:00:${String(sec % 60).padStart(2, '0')}+00:00`;
const line = (o) => JSON.stringify({ t: at(o.sec || 1), h: o.h || 'openvibe.codes', m: o.m || 'GET', u: o.u || '/', s: o.s || 200, b: o.b || 100, rt: 0.012, ua: o.ua || '', ref: o.ref || '', cc: o.cc || 'US', a: o.a || '198.51.100.7' }) + '\n';
const UA = {
    person: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36',
    google: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    gpt: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.4; +https://openai.com/gptbot)',
    eleven: 'Mozilla/5.0 (compatible; ElevenlabsCrawler/1.0; +https://elevenlabs.io/docs/bots)',
    chatgpt: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot',
    slack: 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
};

(async () => {
    await check('who asked: people, each bot by name and kind, programs, our own', async () => {
        assert.deepStrictEqual([classify(UA.person).who, classify(UA.person).agent], ['person', '']);
        assert.deepStrictEqual([classify(UA.gpt).who, classify(UA.gpt).agent], ['ai_crawler', 'GPTBot']);
        assert.deepStrictEqual([classify(UA.chatgpt).who, classify(UA.chatgpt).agent], ['ai_assistant', 'ChatGPT-User'], 'a person\'s assistant is not a crawler');
        assert.deepStrictEqual([classify(UA.eleven).who, classify(UA.eleven).agent], ['ai_crawler', 'ElevenLabs crawler']);
        assert.deepStrictEqual([classify(UA.slack).who, classify(UA.slack).agent], ['preview', 'Slack preview']);
        assert.strictEqual(classify(UA.google).who, 'search');
        assert.ok(classify(UA.google).verify.includes('.googlebot.com'), 'Googlebot\'s claim is checkable');
        assert.ok(!classify(UA.google).verify.some((s) => s.includes('googleusercontent')), 'any Google Cloud machine has that name: never proof');
        assert.deepStrictEqual([classify('Mozilla/5.0 (compatible; Reflectionbot/1.0; +https://x)').who, classify('Mozilla/5.0 (compatible; Reflectionbot/1.0)').agent], ['bot', 'Reflectionbot']);
        assert.deepStrictEqual([classify('curl/8.18.0').who, classify('node').agent, classify('').agent], ['script', 'Node.js', 'No user agent']);
        assert.strictEqual(classify('OpenVibe.AI/0.1 (+https://ai.openvibe.services)').who, 'own');
    });

    await check('what was asked for: machine files by name, pages by section, never a token or an id', async () => {
        for (const p of ['/llms.txt', '/llms-full.txt', '/robots.txt', '/sitemap.xml', '/.well-known/agent.json', '/openapi.json']) assert.deepStrictEqual(kindOf('GET', p), { kind: 'file', path: p });
        assert.deepStrictEqual(kindOf('GET', '/loops.md'), { kind: 'file', path: '/loops.md' });
        assert.deepStrictEqual(kindOf('GET', '/loops'), { kind: 'page', path: '/loops' });
        assert.deepStrictEqual(kindOf('GET', '/s/Ab3x9QkLm2pZ8rT'), { kind: 'page', path: '/s/*' });
        assert.deepStrictEqual(kindOf('GET', '/x8K2mQ9pL4vT7rW1zY'), { kind: 'page', path: '/*' }, 'a token at the top is not a section');
        assert.deepStrictEqual(kindOf('GET', '/api/v1/me/spare'), { kind: 'api', path: '' });
        assert.deepStrictEqual(kindOf('GET', '/css/c4.css'), { kind: 'asset', path: '' });
        assert.deepStrictEqual(kindOf('POST', '/inbox'), { kind: 'other', path: '' });
    });

    await check('where a person came from: the referring site as people say it, never a path; a click inside the site is not an arrival', async () => {
        assert.strictEqual(sourceOf('https://www.google.com/search?q=openvibe', 'openvibe.live'), 'Google');
        assert.strictEqual(sourceOf('https://chatgpt.com/c/abc', 'openvibe.live'), 'ChatGPT');
        assert.strictEqual(sourceOf('https://t.co/xyz', 'openvibe.live'), 'X');
        assert.strictEqual(sourceOf('https://openvibe.network/feed', 'openvibe.live'), 'openvibe.network');
        assert.strictEqual(sourceOf('https://www.example.org/some/private/path?token=1', 'openvibe.live'), 'example.org');
        assert.strictEqual(sourceOf('', 'openvibe.live'), 'Direct');
        assert.strictEqual(sourceOf('https://openvibe.live/c/alice', 'openvibe.live'), null);
        assert.deepStrictEqual([countryOf('us'), countryOf('XX'), countryOf('T1'), countryOf('')], ['US', '', 'T1', '']);
    });

    await check('the reverse-DNS check: the name must be the engine\'s and resolve back to the same address', async () => {
        const dns = {
            reverse: async (a) => ({ '66.249.66.1': ['crawl-66-249-66-1.googlebot.com'], '203.0.113.9': ['host.evil.example'], '192.0.2.5': ['crawl-x.googlebot.com'] }[a] || []),
            resolve4: async (h) => ({ 'crawl-66-249-66-1.googlebot.com': ['66.249.66.1'], 'crawl-x.googlebot.com': ['192.0.2.200'] }[h] || []),
            resolve6: async () => [],
        };
        const verify = createVerifier({ dns });
        assert.strictEqual(await verify('66.249.66.1', ['.googlebot.com', '.google.com']), 'yes');
        assert.strictEqual(await verify('203.0.113.9', ['.googlebot.com']), 'no', 'someone else\'s machine');
        assert.strictEqual(await verify('192.0.2.5', ['.googlebot.com']), 'no', 'a reverse name that does not resolve back');
        assert.strictEqual(await verify('', ['.googlebot.com']), '');
    });

    const t = await boot({ db: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-traffic-'));
    const file = path.join(dir, 'ov-traffic.log');
    const dns = {
        reverse: async (a) => (a === '66.249.66.1' ? ['crawl-66-249-66-1.googlebot.com'] : ['somewhere.example']),
        resolve4: async (h) => (h === 'crawl-66-249-66-1.googlebot.com' ? ['66.249.66.1'] : []),
        resolve6: async () => [],
    };
    const collector = createTrafficCollector({ store: t.ctx.store, file, verify: createVerifier({ dns }), log: { warn: () => {} } });
    const rows = async () => t.ctx.store.db.prepare('SELECT * FROM report_traffic_days ORDER BY host, who, agent, kind, path').all();
    try {
        await check('the collector counts what is new since its place, waits for a half-written line, and follows a rotation', async () => {
            fs.writeFileSync(file, line({ u: '/llms.txt', ua: UA.gpt, sec: 1 }) + line({ u: '/llms.txt', ua: UA.gpt, sec: 2 }) + line({ u: '/loops', ua: UA.person, sec: 3 })
                + line({ u: '/robots.txt', ua: UA.google, a: '66.249.66.1', sec: 4 }) + line({ u: '/robots.txt', ua: UA.google, a: '203.0.113.9', sec: 5 })
                + line({ h: 'openvibe.live', u: '/c/alice', ua: UA.eleven, s: 404, sec: 6 }) + '{"t":"half');
            assert.deepStrictEqual(await collector.runOnce(), { lines: 6, rows: 5 });
            const r = await rows();
            const llms = r.find((x) => x.path === '/llms.txt');
            assert.deepStrictEqual([llms.who, llms.agent, Number(llms.requests), llms.kind], ['ai_crawler', 'GPTBot', 2, 'file']);
            const robots = r.filter((x) => x.path === '/robots.txt').map((x) => [x.verified, Number(x.requests)]).sort();
            assert.deepStrictEqual(robots, [['no', 1], ['yes', 1]], 'the real Googlebot and the one that only says so are apart');
            assert.strictEqual(Number(r.find((x) => x.host === 'openvibe.live').missing), 1);
            // Finish the half line, add more, then rotate the file and start a new one.
            fs.appendFileSync(file, 'x","h":"openvibe.codes","m":"GET","u":"/","s":200,"b":1,"rt":0,"ua":"","a":""}\n' + line({ u: '/llms-full.txt', ua: UA.chatgpt, sec: 7 }));
            fs.renameSync(file, `${file}.1`);
            fs.writeFileSync(file, line({ u: '/llms.txt', ua: UA.gpt, sec: 8 }) + line({ u: '/sitemap.xml', ua: UA.slack, sec: 9 }));
            const second = await collector.runOnce();
            assert.strictEqual(second.lines, 4, 'the rest of the old file (the finished half line and one more) and the two new lines');
            const r2 = await rows();
            assert.strictEqual(Number(r2.find((x) => x.path === '/llms.txt' && x.agent === 'GPTBot').requests), 3);
            assert.ok(r2.find((x) => x.path === '/llms-full.txt' && x.who === 'ai_assistant'));
            assert.deepStrictEqual(await collector.runOnce(), { lines: 0, rows: 0 }, 'nothing new is nothing counted');
        });

        await check('no address is ever kept, and page sections stop at 150 a site a day', async () => {
            const dump = JSON.stringify(await rows());
            for (const a of ['198.51.100.7', '66.249.66.1', '203.0.113.9']) assert.ok(!dump.includes(a), `${a} is not stored`);
            let many = '';
            for (let i = 0; i < 160; i++) many += line({ h: 'openvibe.wiki', u: `/section-${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`, ua: UA.person, sec: i });
            fs.appendFileSync(file, many);
            await collector.runOnce();
            const wiki = (await rows()).filter((x) => x.host === 'openvibe.wiki');
            assert.strictEqual(wiki.filter((x) => x.path !== '/…').length, 150);
            assert.strictEqual(Number(wiki.find((x) => x.path === '/…').requests), 10);
        });

        await check('the job: off under a drill, nothing without a log', async () => {
            const { createTrafficJobs } = require('../server/jobs/traffic');
            assert.strictEqual(createTrafficJobs({ config: { drill: true, jobs: { trafficLog: file } }, store: t.ctx.store }).start(), null, 'a drill never counts');
            assert.deepStrictEqual(await createTrafficJobs({ config: { drill: true, jobs: { trafficLog: file } }, store: t.ctx.store }).runOnce(), { skipped: 'drill' });
            assert.deepStrictEqual(await createTrafficJobs({ config: { jobs: { trafficLog: path.join(dir, 'none.log') } }, store: t.ctx.store, log: { warn: () => {} } }).runOnce(), { skipped: 'no_log' });
            assert.strictEqual(createTrafficJobs({ config: { jobs: { trafficLog: null } }, store: t.ctx.store }).start(), null, 'no log configured, no timer');
        });

        await check('v2: where people came from, countries and today by the hour', async () => {
            fs.appendFileSync(file, line({ h: 'openvibe.tv', u: '/', ua: UA.person, ref: 'https://www.google.com/search?q=x', cc: 'DE', sec: 11 })
                + line({ h: 'openvibe.tv', u: '/watch', ua: UA.person, ref: 'https://www.google.de/', cc: 'DE', sec: 12 })
                + line({ h: 'openvibe.tv', u: '/about', ua: UA.person, ref: 'https://openvibe.tv/', cc: 'FR', sec: 13 })
                + line({ h: 'openvibe.tv', u: '/', ua: UA.person, cc: 'FR', sec: 14 })
                + line({ h: 'openvibe.tv', u: '/', ua: UA.gpt, ref: 'https://www.google.com/', cc: 'US', sec: 15 }));
            await collector.runOnce();
            const j = (await t.get('/api/v1/traffic/sites/openvibe.tv?days=1')).json();
            assert.deepStrictEqual(j.sources, [{ source: 'Google', requests: 2 }, { source: 'Direct', requests: 1 }], 'a bot\'s referrer and a click inside the site are not arrivals');
            assert.deepStrictEqual(j.countries.map((x) => [x.country, x.people, x.bots]), [['DE', 2, 0], ['FR', 2, 0], ['US', 0, 1]]);
            assert.ok(Array.isArray(j.hourly) && j.hourly.length >= 1, 'today comes by the hour');
            assert.strictEqual(j.hourly[0].person, 4);
            assert.strictEqual((await t.get('/api/v1/traffic/sites/openvibe.tv?days=7')).json().hourly, undefined, 'a week comes by the day');
            const page = await t.get('/traffic/sites/openvibe.tv?days=1');
            assert.match(page.text, /Where people come from/);
            assert.match(page.text, /by the hour \(UTC\)/);
            assert.match(page.text, />Germany</);
        });

        await check('the pages: the network, a site and a bot, people and bots apart; the API answers the same', async () => {
            const page = await t.get('/traffic');
            assert.strictEqual(page.status, 200, page.text.slice(0, 200));
            assert.match(page.text, /Who visits OpenVibe/);
            assert.match(page.text, />GPTBot<\/a>/);
            assert.match(page.text, /<code>\/llms\.txt<\/code>/);
            assert.match(page.text, /not really/, 'the fake Googlebot is called out');
            assert.match(page.text, /class="tf-w-person"/);
            const site = await t.get('/traffic/sites/openvibe.codes');
            assert.strictEqual(site.status, 200);
            assert.match(site.text, /<code>\/llms\.txt<\/code>/);
            assert.match(site.text, /GPTBot <b>3<\/b>/);
            const bot = await t.get(`/traffic/bots/${encodeURIComponent('GPTBot')}`);
            assert.strictEqual(bot.status, 200);
            assert.match(bot.text, /collects pages for an AI model/);
            assert.strictEqual((await t.get('/traffic/sites/nowhere.example')).status, 404);
            assert.strictEqual((await t.get('/traffic/bots/NoSuchBot')).status, 404);
            const api = await t.get('/api/v1/traffic?days=1');
            assert.strictEqual(api.status, 200);
            const j = api.json();
            assert.strictEqual(j.days, 1);
            assert.ok(j.totals.people > 0 && j.totals.bots > 0);
            assert.ok(j.bots.find((b) => b.agent === 'GPTBot' && b.who === 'ai_crawler'));
            assert.ok(j.files.find((f) => f.path === '/llms.txt' && f.readers.some((x) => x.agent === 'GPTBot')));
            assert.strictEqual((await t.get('/api/v1/traffic/bots/GPTBot')).json().totals.requests, 4, 'three on openvibe.codes, one on openvibe.tv');
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        await t.close();
    }
    done();
})();
