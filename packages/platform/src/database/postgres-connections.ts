import pg from 'pg';
import { observePostgresClientErrors, observePostgresPoolErrors } from '@matrix-os/observability/postgres';

export function createPostgresPool(config: pg.PoolConfig, source: string, reportError?: (error: Error) => void): pg.Pool {
  const pool = new pg.Pool(config);
  observePostgresPoolErrors(pool, reportError ?? ((error) => console.error(`[${source}] Postgres connection error:`, error)));
  return pool;
}

export function createPostgresClient(config: pg.ClientConfig, source: string): pg.Client {
  const client = new pg.Client(config);
  observePostgresClientErrors(client, (error) => {
    console.error(`[${source}] Postgres connection error:`, error);
  });
  return client;
}
