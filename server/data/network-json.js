'use strict';
/**
 * Network's internal JSON client, with Report's service token on each call (openvibe-sdk/auth's service token client,
 * the `report` OAuth client and its secret).
 *
 * The sharing system (openvibe-sdk/share) needs Network twice: to turn an @name into a person and to resolve the people
 * it shows in the sheet. One client for both, so a test that answers Network's lookups locally changes one place
 * (sharing._reset / the share store built with a test network).
 */
let override = null;

/** Tests: answer Network's calls locally. */
function _setNetwork(client) { override = client || null; }

function client() {
    if (override) return override;
    const { createServiceTokenClient } = require('openvibe-sdk/auth');
    const config = require('./config').load();
    const base = String(config.networkInternalUrl || config.networkUrl || 'http://127.0.0.1:4000').replace(/\/+$/, '');
    const secret = config.oauth && config.oauth.clientSecret;
    if (!secret) throw new Error('OV_OAUTH_CLIENT_SECRET is not set: Report cannot call Network');
    const tokens = createServiceTokenClient({
        tokenUrl: config.oauth.tokenUrl,
        clientId: config.oauth.clientId || 'report',
        clientSecret: secret,
        scope: { 'openvibe.network': 'identity.read' },
    });
    return {
        async json({ path, method = 'GET', query, json }) {
            const token = await tokens.getToken({ audience: 'openvibe.network' });
            const q = query ? `?${new URLSearchParams(query)}` : '';
            const res = await fetch(`${base}${path}${q}`, {
                method,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                ...(json === undefined ? {} : { body: JSON.stringify(json) }),
                signal: AbortSignal.timeout(15_000),
            });
            if (!res.ok) {
                const err = new Error(`Network ${path} answered ${res.status}`);
                err.status = res.status;
                throw err;
            }
            return await res.json();
        },
    };
}

module.exports = { client, _setNetwork };
