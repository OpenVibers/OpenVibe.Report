'use strict';

/**
 * A migrated Report database for one test run (ADR-035), from openvibe-sdk/testing: PGlite by default; with
 * REPORT_TEST_STORE=pg the PostgreSQL + PgBouncer containers, with roles and a schema of this run's own.
 */
const { createTestDb, pgAvailable } = require('openvibe-sdk/testing');
const { MIGRATIONS } = require('../../server/db');

const testDb = ({ store = process.env.REPORT_TEST_STORE || 'pglite', max = 4 } = {}) => createTestDb({ migrations: MIGRATIONS, store, service: 'report', max });

module.exports = { testDb, pgAvailable };
