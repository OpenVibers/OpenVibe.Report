'use strict';
/**
 * Who asked (plan AD.40, the owner 2026-11-28: "so we know whats up with which bots … separate bot traffic"): a request's
 * user agent → { who, agent, verify }.
 *
 *   who      person | search | ai_crawler | ai_assistant | preview | seo | monitor | script | bot | own
 *   agent    the bot's name as people know it ('' for a person)
 *   verify   the reverse-DNS suffixes that prove the claim (search engines that publish them), or null
 *
 * The list is ordered: the first match wins, so a specific name comes before the words it contains (ChatGPT-User before
 * GPTBot's family, Applebot before the generic "bot"). Anything with bot, crawler or spider in it that no row names is
 * counted as a bot under the token that says so; a browser is a person.
 */

const WHO = {
    person: 'People', search: 'Search engines', ai_crawler: 'AI crawlers', ai_assistant: 'AI assistants', preview: 'Link previews',
    seo: 'SEO tools', monitor: 'Monitors', script: 'Scripts', bot: 'Other bots', own: 'OpenVibe',
};
const WHO_LINE = {
    person: 'a browser with a person at it',
    search: 'indexes pages for a search engine',
    ai_crawler: 'collects pages for an AI model or an AI search index',
    ai_assistant: 'fetches a page because a person asked an AI about it',
    preview: 'draws a link\'s card in a chat or a post',
    seo: 'measures links and rankings for an SEO tool',
    monitor: 'checks that a site answers',
    script: 'a program or a library, not a browser',
    bot: 'says it is a bot; not one we know by name',
    own: 'OpenVibe\'s own services and checks',
};

// [name, who, pattern, verify suffixes]
const ROWS = [
    // OpenVibe's own probes, services and Link.
    ['OpenVibe', 'own', /openvibe/i],
    // AI assistants: a person asked, the assistant fetches (cited answers).
    ['ChatGPT-User', 'ai_assistant', /ChatGPT-User/i],
    ['Claude-User', 'ai_assistant', /Claude-User/i],
    ['Perplexity-User', 'ai_assistant', /Perplexity-User/i],
    ['MistralAI-User', 'ai_assistant', /MistralAI-User/i],
    ['Meta fetcher', 'ai_assistant', /meta-externalfetcher/i],
    ['DuckAssistBot', 'ai_assistant', /DuckAssistBot/i],
    ['Google Gemini fetcher', 'ai_assistant', /Google-(?:NotebookLM|Gemini)/i],
    // AI crawlers: training sets and AI search indexes.
    ['OAI-SearchBot', 'ai_crawler', /OAI-SearchBot/i],
    ['GPTBot', 'ai_crawler', /GPTBot/i],
    ['Claude-SearchBot', 'ai_crawler', /Claude-SearchBot/i],
    ['ClaudeBot', 'ai_crawler', /ClaudeBot|anthropic-ai|Claude-Web/i],
    ['PerplexityBot', 'ai_crawler', /PerplexityBot/i],
    ['CCBot', 'ai_crawler', /CCBot/i],
    ['Bytespider', 'ai_crawler', /Bytespider/i],
    ['TikTokSpider', 'ai_crawler', /TikTokSpider/i],
    ['Amazonbot', 'ai_crawler', /Amazonbot/i],
    ['Meta AI crawler', 'ai_crawler', /meta-externalagent|FacebookBot/i],
    ['Google-CloudVertexBot', 'ai_crawler', /Google-CloudVertexBot/i],
    ['GoogleOther', 'ai_crawler', /GoogleOther/i],
    ['Applebot', 'search', /Applebot/i, ['.applebot.apple.com']],
    ['cohere-ai', 'ai_crawler', /cohere-(?:ai|training-data-crawler)/i],
    ['DeepSeekBot', 'ai_crawler', /DeepSeek/i],
    ['ElevenLabs crawler', 'ai_crawler', /ElevenlabsCrawler/i],
    ['AI2Bot', 'ai_crawler', /AI2Bot|Ai2Bot/i],
    ['Diffbot', 'ai_crawler', /Diffbot/i],
    ['YouBot', 'ai_crawler', /YouBot/i],
    ['PanguBot', 'ai_crawler', /PanguBot/i],
    ['Timpibot', 'ai_crawler', /Timpibot/i],
    ['ImagesiftBot', 'ai_crawler', /ImagesiftBot/i],
    ['Omgilibot', 'ai_crawler', /Omgili/i],
    ['Kangaroo Bot', 'ai_crawler', /Kangaroo Bot/i],
    ['iAsk', 'ai_crawler', /iaskspider/i],
    ['Brightbot', 'ai_crawler', /Brightbot/i],
    // Search engines.
    ['Googlebot', 'search', /Googlebot|Google-InspectionTool|Storebot-Google|AdsBot-Google|Mediapartners-Google|APIs-Google|FeedFetcher-Google/i, ['.googlebot.com', '.google.com']],
    ['Bingbot', 'search', /bingbot|BingPreview|msnbot|adidxbot/i, ['.search.msn.com']],
    ['DuckDuckBot', 'search', /DuckDuckBot|DuckDuckGo-Favicons/i],
    ['YandexBot', 'search', /Yandex/i, ['.yandex.ru', '.yandex.net', '.yandex.com']],
    ['Baiduspider', 'search', /Baiduspider/i, ['.baidu.com', '.baidu.jp']],
    ['PetalBot', 'search', /PetalBot/i],
    ['SeznamBot', 'search', /SeznamBot/i],
    ['Qwant', 'search', /Qwant/i],
    ['MojeekBot', 'search', /MojeekBot/i],
    ['Yahoo Slurp', 'search', /Slurp/i],
    ['Naver Yeti', 'search', /Yeti\//i],
    ['Sogou', 'search', /Sogou/i],
    ['Coc Coc', 'search', /coccocbot/i],
    ['ibou', 'search', /ibou/i],
    ['Brave Search', 'search', /Bravebot|BraveSearch/i],
    // Link previews.
    ['Facebook preview', 'preview', /facebookexternalhit|Facebot/i],
    ['X preview', 'preview', /Twitterbot/i],
    ['Slack preview', 'preview', /Slackbot|Slack-ImgProxy/i],
    ['Discord preview', 'preview', /Discordbot/i],
    ['Telegram preview', 'preview', /TelegramBot/i],
    ['WhatsApp preview', 'preview', /WhatsApp/i],
    ['LinkedIn preview', 'preview', /LinkedInBot/i],
    ['Pinterest', 'preview', /Pinterest/i],
    ['Reddit preview', 'preview', /redditbot/i],
    ['Bluesky preview', 'preview', /Cardyb|Bluesky/i],
    ['Mastodon preview', 'preview', /Mastodon\//i],
    ['Embedly', 'preview', /Embedly|Iframely/i],
    ['Skype preview', 'preview', /SkypeUriPreview/i],
    ['Google Chat preview', 'preview', /Google-PageRenderer|GoogleImageProxy/i],
    // SEO tools.
    ['AhrefsBot', 'seo', /AhrefsBot|AhrefsSiteAudit/i],
    ['SemrushBot', 'seo', /Semrush/i],
    ['MJ12bot', 'seo', /MJ12bot/i],
    ['DotBot', 'seo', /DotBot/i],
    ['DataForSeoBot', 'seo', /DataForSeoBot/i],
    ['BLEXBot', 'seo', /BLEXBot/i],
    ['Serpstat', 'seo', /serpstatbot/i],
    ['Screaming Frog', 'seo', /Screaming Frog/i],
    ['Barkrowler', 'seo', /Barkrowler/i],
    ['SeekportBot', 'seo', /Seekport/i],
    ['Moz', 'seo', /rogerbot|DotBot/i],
    ['MegaIndex', 'seo', /MegaIndex/i],
    // Monitors.
    ['UptimeRobot', 'monitor', /UptimeRobot/i],
    ['Pingdom', 'monitor', /Pingdom/i],
    ['StatusCake', 'monitor', /StatusCake/i],
    ['Better Stack', 'monitor', /Better ?Uptime|Better ?Stack/i],
    ['Site24x7', 'monitor', /Site24x7/i],
    ['Uptime Kuma', 'monitor', /Uptime-Kuma/i],
    ['Datadog', 'monitor', /Datadog/i],
    ['Checkly', 'monitor', /Checkly/i],
    ['Cloudflare', 'monitor', /Cloudflare-(?:Healthchecks|Traffic-Manager|Diagnose)/i],
    // Programs and libraries.
    ['Headless Chrome', 'script', /HeadlessChrome/i],
    ['FFmpeg', 'script', /Lavf\//i],
    ['GitHub webhooks', 'script', /GitHub-Hookshot/i],
    ['curl', 'script', /^curl\//i],
    ['Wget', 'script', /^Wget/i],
    ['Python', 'script', /python-requests|python-httpx|aiohttp|python-urllib|Python\//i],
    ['Go', 'script', /Go-http-client/i],
    ['Node.js', 'script', /node-fetch|undici|axios|^node$|Node\.js/i],
    ['Java', 'script', /^Java\/|Apache-HttpClient|okhttp/i],
    ['Scrapy', 'script', /Scrapy/i],
    ['Postman', 'script', /PostmanRuntime/i],
    ['HTTPie', 'script', /HTTPie/i],
    ['Ruby', 'script', /^Ruby|Faraday/i],
    ['PHP', 'script', /^PHP|GuzzleHttp/i],
    ['Perl', 'script', /libwww-perl/i],
    ['Rust', 'script', /reqwest/i],
];

const GENERIC = /([A-Za-z][A-Za-z0-9._-]{0,30}(?:bot|crawler|spider|scraper|fetcher)[A-Za-z0-9._-]{0,10})/i;
const BOTWORD = /bot\b|crawl|spider|scrap|fetch|slurp|archiver|preview/i;
const BROWSER = /Mozilla\/5\.0|Opera\//;

/** A user agent → { who, agent, verify }. */
function classify(ua) {
    const s = String(ua || '').trim();
    if (!s || s === '-') return { who: 'script', agent: 'No user agent', verify: null };
    for (const [agent, who, re, verify] of ROWS) if (re.test(s)) return { who, agent, verify: verify || null };
    if (BOTWORD.test(s)) {
        const m = GENERIC.exec(s);
        return { who: 'bot', agent: m ? m[1].replace(/[._-]+$/, '') : 'Unnamed bot', verify: null };
    }
    if (BROWSER.test(s)) return { who: 'person', agent: '', verify: null };
    return { who: 'script', agent: 'Other program', verify: null };
}

const isBot = (who) => who !== 'person';

module.exports = { classify, isBot, WHO, WHO_LINE, ROWS };
