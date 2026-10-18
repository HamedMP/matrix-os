import pg from 'pg';

// A pool's error event only covers idle clients. Keep a client-level listener
// for its entire lifetime, including checkout/transaction gaps between queries.
// pg still rejects pending queries and marks a broken client unqueryable; the
// pool discards that client when its owner releases it. Do not retry writes here.
export function createPostgresPool(config: pg.PoolConfig, source: string): pg.Pool {
  const pool = new pg.Pool(config);
  pool.on('error', (error) => {
    console.error(`[${source}] Idle Postgres pool client error:`, error);
  });
  pool.on('connect', (client) => {
    observeClientErrors(client, source);
  });
  return pool;
}

export function createPostgresClient(config: pg.ClientConfig, source: string): pg.Client {
  const client = new pg.Client(config);
  observeClientErrors(client, source);
  return client;
}

function observeClientErrors(client: pg.ClientBase, source: string): void {
  client.on('error', (error: Error) => {
    console.error(`[${source}] Postgres client connection error:`, error);
  });
}
