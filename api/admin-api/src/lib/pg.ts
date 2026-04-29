/**
 * @format
 * Lazy Pool singleton — connects via PgBouncer (transaction mode).
 * Max 5 client connections: PgBouncer multiplexes these into ≤20 server connections.
 *
 * No TLS on the client→pgbouncer hop: traffic is intra-cluster only and
 * pgbouncer is configured for plain TCP. PgBouncer terminates client
 * connections and opens its own TLS-enabled pool to RDS on the egress hop.
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
