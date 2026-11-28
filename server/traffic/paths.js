'use strict';
/**
 * What was asked for (plan AD.40): a request's method and path → { kind, path }.
 *
 *   kind   page | file | feed | api | asset | media | other
 *   path   what Report keeps of it: a machine-readable file by its own name (/llms.txt, /robots.txt, /sitemap.xml,
 *          /.well-known/agent.json, /openapi.json …), a Markdown twin and a page by their section (the first part of the
 *          path, "/c/*" for anything deeper), and nothing for the rest. A share link, an id or a token is never kept:
 *          a section that looks like one (digits, a long mixed string) is "/*". The query string never reaches the log.
 */

// The files sites publish for machines, kept by name (the owner, 11-28: "all files like loops or llms.txt or
// llms-full should have their own analytics").
const FILES = new Set([
    '/robots.txt', '/llms.txt', '/llms-full.txt', '/sitemap.xml', '/sitemap-index.xml', '/sitemap_index.xml', '/openapi.json',
    '/.well-known/agent.json', '/.well-known/security.txt', '/.well-known/ai-plugin.json', '/.well-known/mcp.json',
    '/.well-known/openid-configuration', '/.well-known/jwks.json', '/.well-known/assetlinks.json', '/.well-known/apple-app-site-association',
    '/manifest.json', '/manifest.webmanifest', '/site.webmanifest', '/humans.txt', '/ads.txt', '/release.json', '/bot.json',
    '/favicon.ico', '/index.md',
]);
const FEED = /^\/(?:feed|rss|atom)(?:\.xml|\.json)?$|\/(?:feed|rss|atom)\.(?:xml|json)$|^\/feeds?\//;
const SITEMAP = /^\/sitemap[\w-]*\.xml$|^\/sitemaps?\/[\w.-]+\.xml$/;
const ASSET_DIR = /^\/(?:css|js|shared|assets|static|fonts|img|images|icons|vendor|dist|build|_next|public|favicon[\w.-]*|apple-touch-icon[\w.-]*)(?:\/|$)/;
const ASSET_EXT = /\.(?:css|js|mjs|map|woff2?|ttf|otf|eot|png|jpe?g|gif|webp|avif|svg|ico|bmp|wasm)$/i;
const MEDIA = /^\/(?:hls|media|vod|vods|clips|thumbnails|thumbs|recordings|live|o|uploads|files)\/|\.(?:m3u8|ts|m4s|mp4|webm|mp3|m4a|ogg|wav|flac|mov|mkv|vtt|srt)$/i;
const API = /^\/(?:api|auth|internal|mcp|ws|graphql|oauth|oidc|webhooks?|v1|v2|rpc|socket\.io|events|cdn-cgi)(?:\/|$)/i;
const WORD = /^[a-z][a-z0-9._~-]{0,39}$/i;

/** A section as kept: "/section" or "/section/*"; anything that looks like an id or a token is "/*". */
function section(first, deeper) {
    if (!WORD.test(first) || (first.match(/\d/g) || []).length >= 4 || (first.length >= 20 && /\d/.test(first))) return '/*';
    return `/${first.toLowerCase()}${deeper ? '/*' : ''}`;
}

function kindOf(method, rawPath) {
    let p = String(rawPath || '/');
    if (!p.startsWith('/')) p = `/${p}`;
    if (p.length > 1 && p.endsWith('/') && !p.endsWith('//')) p = p.slice(0, -1);
    const m = String(method || 'GET').toUpperCase();
    const lower = p.toLowerCase();
    if (FILES.has(lower)) return { kind: 'file', path: lower };
    if (SITEMAP.test(lower)) return { kind: 'file', path: lower.length <= 60 ? lower : '/sitemap*.xml' };
    if (lower.startsWith('/.well-known/')) return { kind: 'file', path: '/.well-known/*' };
    if (lower.endsWith('.md')) {
        const parts = lower.slice(1, -3).split('/').filter(Boolean);
        return { kind: 'file', path: parts.length ? `${section(parts[0], parts.length > 1)}.md` : '/index.md' };
    }
    if (FEED.test(lower)) return { kind: 'feed', path: lower.length <= 60 && !/\d{4,}/.test(lower) ? lower : '/feed' };
    if (API.test(lower)) return { kind: 'api', path: '' };
    if (MEDIA.test(lower)) return { kind: 'media', path: '' };
    if (ASSET_DIR.test(lower) || ASSET_EXT.test(lower)) return { kind: 'asset', path: '' };
    if (m !== 'GET' && m !== 'HEAD') return { kind: 'other', path: '' };
    if (p === '/') return { kind: 'page', path: '/' };
    const parts = p.slice(1).split('/').filter(Boolean);
    return { kind: 'page', path: parts.length ? section(parts[0], parts.length > 1) : '/' };
}

const KIND = { page: 'Pages', file: 'Files for machines', feed: 'Feeds', api: 'API', asset: 'Styles, scripts and pictures', media: 'Video and sound', other: 'Other' };

module.exports = { kindOf, section, KIND, FILES };
