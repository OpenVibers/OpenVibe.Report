'use strict';
/**
 * A service token for Report's operator routes (plan L41).
 *
 * Callers present OpenVibe.Network service tokens (RS256 client-credentials JWTs, audience openvibe.report),
 * verified with openvibe-contracts serviceAuth.verifyServiceToken (the claim schema, the issuer and the audience).
 * The key comes from a pinned OV_NETWORK_PUBLIC_KEY PEM, or from the SDK's JWKS client (one per URL), which gives
 * fresh keys and honours a rotation.
 *
 * The capability is report.ai_usage.read. It is checked against the token's own claim rather than against the
 * pinned contracts release, because the release that carries the capability is the owner's to make.
 */
const { serviceAuth } = require('openvibe-contracts');

const CAPS = Object.freeze({ aiUsageRead: 'report.ai_usage.read' });

/** The bearer token of a request, or null. */
const bearer = (req) => {
    const h = String((req && req.headers && req.headers.authorization) || '');
    return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
};

/** The kid of a token header (the key the token was signed with). */
const headerKid = (token) => {
    try { return JSON.parse(Buffer.from(String(token).split('.')[0], 'base64url').toString('utf8')).kid || null; } catch { return null; }
};

/** Does the token hold the capability (exactly, or through a report.* grant)? */
const hasCap = (claims, id) => {
    const granted = claims && Array.isArray(claims.cap) ? claims.cap : [];
    return granted.some((c) => c === id || (String(c).endsWith('.*') && id.startsWith(String(c).slice(0, -1))));
};

/**
 * The caller's service token, verified. Answers { ok: true, claims } or { ok: false, status, code, detail }.
 * The verifier can be handed in (a test signs its own tokens), so the route never needs the network to be up.
 */
function createServiceAuth({ config = {}, now = () => Date.now(), verify = null } = {}) {
    async function check(publicKey, token) {
        return await serviceAuth.verifyServiceToken(token, { publicKey, issuer: config.issuer, audience: 'openvibe.report', now: now() });
    }

    async function verifyToken(token) {
        if (verify) return await verify(token, { config, now });
        if (config.networkPublicKey) return await check(config.networkPublicKey, token);
        let keys;
        try {
            const { jwksClient } = require('openvibe-sdk/auth');
            keys = await jwksClient(config.networkJwksUrl, { log: config.log }).keysForKid(headerKid(token));
        } catch (err) {
            return { ok: false, code: 'token.unavailable', reason: 'signing key not loaded yet' };
        }
        const kid = headerKid(token);
        const byKid = kid ? keys.filter((k) => k.kid === kid) : [];
        let last = { ok: false, code: 'token.unavailable', reason: 'no signing key' };
        for (const k of byKid.length ? byKid : keys) {
            last = await check(k.key, token);
            if (last.ok || last.code !== 'token.bad_signature') return last;
        }
        return last;
    }

    /** The caller of a request, or the refusal to answer it. */
    async function authenticate(req) {
        const token = bearer(req);
        if (!token) return { ok: false, status: 401, code: 'token.missing', detail: 'A service token is required.' };
        const r = await verifyToken(token);
        if (!r || !r.ok) return { ok: false, status: r && r.code === 'token.unavailable' ? 503 : 401, code: (r && r.code) || 'token.invalid', detail: (r && r.reason) || 'The token was refused.' };
        return { ok: true, claims: r.claims };
    }

    return { authenticate, verifyToken, hasCap, bearer, CAPS };
}

module.exports = { createServiceAuth, hasCap, bearer, CAPS };
