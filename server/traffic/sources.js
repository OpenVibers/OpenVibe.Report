'use strict';
/**
 * Where a person came from (plan AD.40 v2): a referrer → the source as people say it, or null when it is not an arrival
 * (a page of the same site). Only the referring site is ever kept, never its path or query.
 *
 *   sourceOf(referrer, host) → 'Direct' | 'Google' | 'ChatGPT' | 'X' | 'openvibe.live' | 'example.com' | null
 */
const NAMED = [
    [/(^|\.)google\.[a-z.]+$/, 'Google'], [/(^|\.)bing\.com$/, 'Bing'], [/(^|\.)duckduckgo\.com$/, 'DuckDuckGo'],
    [/(^|\.)search\.yahoo\.com$|(^|\.)yahoo\.co(m|\.jp)$/, 'Yahoo'], [/(^|\.)yandex\.[a-z]+$/, 'Yandex'], [/(^|\.)baidu\.com$/, 'Baidu'],
    [/(^|\.)ecosia\.org$/, 'Ecosia'], [/(^|\.)search\.brave\.com$/, 'Brave Search'], [/(^|\.)qwant\.com$/, 'Qwant'], [/(^|\.)kagi\.com$/, 'Kagi'],
    [/(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/, 'ChatGPT'], [/(^|\.)perplexity\.ai$/, 'Perplexity'], [/(^|\.)claude\.ai$/, 'Claude'],
    [/(^|\.)gemini\.google\.com$/, 'Gemini'], [/(^|\.)copilot\.microsoft\.com$/, 'Copilot'], [/(^|\.)chat\.deepseek\.com$/, 'DeepSeek'],
    [/(^|\.)t\.co$|(^|\.)x\.com$|(^|\.)twitter\.com$/, 'X'], [/(^|\.)facebook\.com$|(^|\.)fb\.com$|(^|\.)l\.facebook\.com$/, 'Facebook'],
    [/(^|\.)instagram\.com$/, 'Instagram'], [/(^|\.)reddit\.com$/, 'Reddit'], [/(^|\.)youtube\.com$|(^|\.)youtu\.be$/, 'YouTube'],
    [/(^|\.)tiktok\.com$/, 'TikTok'], [/(^|\.)discord(app)?\.com$/, 'Discord'], [/(^|\.)linkedin\.com$|(^|\.)lnkd\.in$/, 'LinkedIn'],
    [/(^|\.)news\.ycombinator\.com$/, 'Hacker News'], [/(^|\.)github\.com$/, 'GitHub'], [/(^|\.)twitch\.tv$/, 'Twitch'], [/(^|\.)kick\.com$/, 'Kick'],
    [/(^|\.)bsky\.app$/, 'Bluesky'], [/(^|\.)t\.me$|(^|\.)telegram\.org$/, 'Telegram'], [/(^|\.)whatsapp\.com$/, 'WhatsApp'],
];

function sourceOf(referrer, host) {
    const r = String(referrer || '').trim();
    if (!r || r === '-') return 'Direct';
    let ref;
    try { ref = new URL(r).hostname.toLowerCase(); } catch { return 'Direct'; }
    if (!ref) return 'Direct';
    const h = String(host || '').toLowerCase();
    if (ref === h || ref === `www.${h}` || `www.${ref}` === h) return null;   // a page of the same site: not an arrival
    for (const [re, name] of NAMED) if (re.test(ref)) return name;
    return ref.replace(/^www\./, '').slice(0, 80);
}

/** Cloudflare's country header → a two-letter code, or '' (XX unknown, T1 Tor kept as itself). */
function countryOf(cc) {
    const c = String(cc || '').toUpperCase();
    return /^[A-Z][A-Z0-9]$/.test(c) && c !== 'XX' ? c : '';
}

module.exports = { sourceOf, countryOf };
