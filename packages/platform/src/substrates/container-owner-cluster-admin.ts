import pg from 'pg';
import type { OwnerClusterAdmin } from './container-owner-database.js';

const CONNECT_TIMEOUT_MS = 10_000;
const QUERY_TIMEOUT_MS = 30_000;

export interface PgOwnerClusterAdmin extends OwnerClusterAdmin {
  close(): Promise<void>;
}

/** Admin access to the shared owner cluster: a small pool plus short-lived per-database clients. */
export function createPgOwnerClusterAdmin(options: { connectionString: string }): PgOwnerClusterAdmin {
  const base = { connectionTimeoutMillis: CONNECT_TIMEOUT_MS, query_timeout: QUERY_TIMEOUT_MS };
  const pool = new pg.Pool({ ...base, connectionString: options.connectionString, max: 2, idleTimeoutMillis: 10_000 });
  pool.on('error', (error) => {
    console.error('[container-owner-cluster] idle client error', error instanceof Error ? error.name : 'Unknown');
  });

  function databaseUrl(database: string): string {
    const url = new URL(options.connectionString);
    url.pathname = `/${encodeURIComponent(database)}`;
    return url.toString();
  }

  return {
    async query(statement, params, signal) {
      signal.throwIfAborted();
      const result = await pool.query(statement, [...params]);
      signal.throwIfAborted();
      return result.rows as Record<string, unknown>[];
    },
    async executeInDatabase(database, statements, signal) {
      signal.throwIfAborted();
      const client = new pg.Client({ ...base, connectionString: databaseUrl(database) });
      client.on('error', (error) => {
        console.error('[container-owner-cluster] client error', error instanceof Error ? error.name : 'Unknown');
      });
      const abort = () => { void client.end(); };
      signal.addEventListener('abort', abort, { once: true });
      try {
        await client.connect();
        for (const statement of statements) {
          signal.throwIfAborted();
          await client.query(statement);
        }
      } finally {
        signal.removeEventListener('abort', abort);
        await client.end().catch((error: unknown) => {
          console.error('[container-owner-cluster] client close failed', error instanceof Error ? error.name : 'Unknown');
        });
      }
    },
    async close() {
      await pool.end();
    },
  };
}
