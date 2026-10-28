'use strict';

/**
 * OpenVibe.Report's own PostgreSQL database (ADR-035): the schema is migrations/NNNN_*.sql, applied at boot.
 *
 * Report ingests the analytics events OpenVibe.Network records (live.stream.ended, the navbar frame beacon)
 * and the daily numbers Network publishes; it keeps Billing's money untouched and reads it through Billing's
 * API. Nothing written here is a secret: a stream's public facts, counts and the ids of events already handled.
 */
const fs = require('fs');
const path = require('path');
const { createDb } = require('openvibe-sdk/db');

const MIGRATIONS = path.join(__dirname, '..', 'migrations');
const DEV_PGLITE = path.join(__dirname, '..', 'data', 'pglite');

async function openDb(config, { log = console, registry } = {}) {
    const dbConfig = (config && config.db) || {};
    if (!dbConfig.url) {
        if (config && config.isProduction) throw new Error('DATABASE_URL is not set: production serves from PostgreSQL (OpenVibe.Host roles/data add-service.sh report)');
        const dir = dbConfig.pgliteDir || DEV_PGLITE;
        log.warn(`[OpenVibe.Report] DATABASE_URL unset: embedded PGlite database in ${dir} (development only, one process)`);
        fs.mkdirSync(dir, { recursive: true });
        const db = createDb({ pglite: dir, service: 'report', registry, log });
        await db.migrate({ dir: MIGRATIONS, log });
        return db;
    }
    if (!dbConfig.directUrl) throw new Error('DATABASE_DIRECT_URL is not set: migrations run with the owner role on a direct connection');
    const owner = createDb({ url: dbConfig.directUrl, service: 'report-migrate', max: 1, log });
    try { await owner.migrate({ dir: MIGRATIONS, log }); } finally { await owner.close(); }
    return createDb({ url: dbConfig.url, service: 'report', registry, log });
}

/** The store every module takes: the db handle, a clock (epoch ms; tests inject one) and transactions. */
function createStore(db, { now = () => Date.now() } = {}) {
    return {
        db,
        now,
        iso: () => new Date(now()).toISOString(),
        tx: async (fn) => await db.tx(fn),
        close: () => db.close(),
    };
}

async function openStore(config, { now, log, registry } = {}) {
    return createStore(await openDb(config, { log, registry }), { now });
}

module.exports = { openDb, openStore, createStore, MIGRATIONS };
