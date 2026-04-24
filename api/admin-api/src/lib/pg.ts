/**
 * @format
 * Lazy Pool singleton — connects via PgBouncer (transaction mode).
 * Max 5 client connections: PgBouncer multiplexes these into ≤20 server connections.
 */
import { Pool } from 'pg';

import type { AdminApiConfig } from './config.js';

let _pool: Pool | undefined;

export function getPool(config: AdminApiConfig): Pool {
    if (!_pool) {
        _pool = new Pool({
            host:     config.pgHost,
            port:     config.pgPort,
            database: config.pgDatabase,
            user:     config.pgUser,
            password: config.pgPassword,
            ssl:      { rejectUnauthorized: false },
            max:      5,
            idleTimeoutMillis:       30_000,
            connectionTimeoutMillis:  5_000,
        });
    }
    return _pool;
}

/** For tests only — reset singleton between test suites. */
export function _resetPool(): void {
    _pool = undefined;
}
