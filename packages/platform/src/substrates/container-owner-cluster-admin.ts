import pg from 'pg';
import type { OwnerClusterAdmin } from './container-owner-database.js';

const CONNECT_TIMEOUT_MS = 10_000;
const QUERY_TIMEOUT_MS = 30_000;
/** Client-side backstop for maintenance sessions, which set their own shorter statement_timeout. */
const SESSION_QUERY_TIMEOUT_MS = 150_000;

export type DatabaseSessionQuery = (statement: string, params?: readonly unknown[]) => Promise<Record<string, unknown>[]>;

/** One admin session in an owner database, for work that must run outside a transaction block. */
export interface OwnerDatabaseSessions {
  withDatabaseSession<T>(database: string, signal: AbortSignal, work: (query: DatabaseSessionQuery) => Promise<T>): Promise<T>;
}

export interface PgOwnerClusterAdmin extends OwnerClusterAdmin, OwnerDatabaseSessions {
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

  /** Aborting ends the client, so a statement in flight fails and later ones never run. */
  async function session<T>(
    database: string, signal: AbortSignal, queryTimeoutMs: number, work: (query: DatabaseSessionQuery) => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    const client = new pg.Client({ ...base, query_timeout: queryTimeoutMs, connectionString: databaseUrl(database) });
    client.on('error', (error) => {
      console.error('[container-owner-cluster] client error', error instanceof Error ? error.name : 'Unknown');
    });
    const abort = () => { void client.end(); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      await client.connect();
      return await work(async (statement, params = []) => {
        signal.throwIfAborted();
        return (await client.query(statement, [...params])).rows as Record<string, unknown>[];
      });
    } finally {
      signal.removeEventListener('abort', abort);
      await client.end().catch((error: unknown) => {
        console.error('[container-owner-cluster] client close failed', error instanceof Error ? error.name : 'Unknown');
      });
    }
  }

  return {
    async query(statement, params, signal) {
      signal.throwIfAborted();
      const result = await pool.query(statement, [...params]);
      signal.throwIfAborted();
      return result.rows as Record<string, unknown>[];
    },
    async executeInDatabase(database, statements, signal) {
      await session(database, signal, QUERY_TIMEOUT_MS, async (query) => {
        for (const statement of statements) await query(statement);
      });
    },
    withDatabaseSession(database, signal, work) {
      return session(database, signal, SESSION_QUERY_TIMEOUT_MS, work);
    },
    async close() {
      await pool.end();
    },
  };
}
