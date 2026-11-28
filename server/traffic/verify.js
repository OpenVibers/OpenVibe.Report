'use strict';
/**
 * Is a crawler who it says it is? (plan AD.40.) Search engines publish how to check: the address's reverse name ends in
 * their domain, and that name resolves back to the same address (forward-confirmed reverse DNS). Anyone can write
 * "Googlebot" in a user agent; only Google's machines pass this.
 *
 *   createVerifier({ dns }) → verify(address, suffixes) → 'yes' | 'no' | ''   ('' = could not tell: a lookup failed)
 *
 * The answer is cached in memory for a day, by address and claim; the address is never written anywhere.
 */
const dnsPromises = require('dns').promises;

const DAY = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 2500;

function withTimeout(promise) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), TIMEOUT_MS); })])
        .finally(() => clearTimeout(timer));
}

function createVerifier({ dns = dnsPromises, now = () => Date.now(), max = 20000 } = {}) {
    const cache = new Map();   // `${suffixes}|${address}` → { answer, at }

    async function check(address, suffixes) {
        let names;
        try { names = await withTimeout(dns.reverse(address)); } catch (err) {
            return err && (err.code === 'ENOTFOUND' || err.code === 'ENODATA') ? 'no' : '';
        }
        const host = (names || []).map((n) => String(n).toLowerCase().replace(/\.$/, '')).find((n) => suffixes.some((s) => n.endsWith(s)));
        if (!host) return 'no';
        try {
            const family = address.includes(':') ? 6 : 4;
            const back = await withTimeout(family === 6 ? dns.resolve6(host) : dns.resolve4(host));
            return (back || []).includes(address) ? 'yes' : 'no';
        } catch (err) {
            return err && (err.code === 'ENOTFOUND' || err.code === 'ENODATA') ? 'no' : '';
        }
    }

    return async function verify(address, suffixes) {
        if (!address || !Array.isArray(suffixes) || !suffixes.length) return '';
        const key = `${suffixes.join(',')}|${address}`;
        const hit = cache.get(key);
        if (hit && now() - hit.at < DAY) return hit.answer;
        const answer = await check(String(address), suffixes);
        if (answer) {
            if (cache.size >= max) cache.delete(cache.keys().next().value);
            cache.set(key, { answer, at: now() });
        }
        return answer;
    };
}

module.exports = { createVerifier };
