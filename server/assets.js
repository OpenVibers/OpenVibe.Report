'use strict';

/**
 * Content-addressed URLs for this site's own assets: /css/app.css?v=<first 10 hex of SHA-256>. The static
 * middleware treats a matching ?v= as immutable (openvibe-shared/cache-policy); any other URL gets the short
 * public window, because those bytes may change under the same URL.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const hashes = new Map();

function assetVersion(rel) {
    const key = String(rel || '').replace(/^\/+/, '');
    if (hashes.has(key)) return hashes.get(key);
    let version = 'dev';
    try {
        version = crypto.createHash('sha256').update(fs.readFileSync(path.join(PUBLIC_DIR, key))).digest('hex').slice(0, 10);
    } catch {
        /* a missing asset stays at a stable placeholder */
    }
    hashes.set(key, version);
    return version;
}

const asset = (rel) => `/${String(rel || '').replace(/^\/+/, '')}?v=${assetVersion(rel)}`;

module.exports = { PUBLIC_DIR, assetVersion, asset };
