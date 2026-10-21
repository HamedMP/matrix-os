import { PostgresSocket } from '../helpers/postgres-socket.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { sql } from 'kysely';
import { createPlatformDb } from '../../packages/platform/src/db.js';
import { createAtsDb } from '../../packages/platform/src/ats-db.js';

vi.mock('../../packages/platform/src/database/run-migrations.js', () => ({
  runPlatformStartupMigrations: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../packages/platform/src/ats-schema.js', () => ({
  migrateAts: vi.fn().mockResolvedValue(undefined),
}));

const OriginalPool = pg.Pool;
const OriginalClient = pg.Client;
let pool: pg.Pool;
let sockets: PostgresSocket[];
let log: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  sockets = [];
  log = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(pg, 'Pool').mockImplementation(function (config: pg.PoolConfig) {
    pool = new OriginalPool({ ...config, stream: () => {
      const socket = new PostgresSocket();
      sockets.push(socket);
      return socket;
    } });
    return pool;
  } as typeof pg.Pool);
});

afterEach(() => {
  for (const socket of sockets) socket.destroy();
  vi.restoreAllMocks();
});

const timeout = () => Object.assign(new Error('read ETIMEDOUT'), { code: 'ETIMEDOUT' });

describe.each([
  ['platform', createPlatformDb],
  ['ATS', createAtsDb],
] as const)('%s Postgres connections', (_name, createDb) => {
  it('handles checked-out timeouts and replaces the failed connection', async () => {
    const db = createDb('postgres://fixture:fixture@localhost/fixture');
    await db.ready;
    const client = await pool.connect();
    const error = timeout();
    try {
      try {
        expect(() => sockets[0].emit('error', error)).not.toThrow();
        expect(log).toHaveBeenCalledWith(expect.any(String), error);
        await expect(client.query('SELECT 1')).rejects.toThrow('not queryable');
      } finally { client.release(); }
      const replacement = await pool.connect();
      try {
        expect(replacement).not.toBe(client);
        await expect(replacement.query('SELECT 1')).resolves.toMatchObject({ command: 'SELECT' });
      } finally { replacement.release(); }
    } finally { await db.destroy(); }
  });

  it('handles a checked-out socket closing without an error event and reconnects', async () => {
    const db = createDb('postgres://fixture:fixture@localhost/fixture');
    await db.ready;
    const client = await pool.connect();
    sockets[0].holdQueries = true;
    try {
      try {
        const rejected = expect(client.query('SELECT 1')).rejects.toThrow('Connection terminated unexpectedly');
        // A remote EOF takes pg's connection-end path, without a stream error.
        sockets[0].destroy();
        await rejected;
        expect(log).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
          message: 'Connection terminated unexpectedly',
        }));
        await expect(client.query('SELECT 1')).rejects.toThrow('not queryable');
      } finally { client.release(); }
      const replacement = await pool.connect();
      try {
        expect(replacement).not.toBe(client);
        await expect(replacement.query('SELECT 1')).resolves.toMatchObject({ command: 'SELECT' });
      } finally { replacement.release(); }
    } finally { await db.destroy(); }
  });

  it('still rejects an in-flight query on a socket error', async () => {
    const db = createDb('postgres://fixture:fixture@localhost/fixture');
    await db.ready;
    const client = await pool.connect();
    sockets[0].holdQueries = true;
    const error = timeout();
    const rejected = expect(client.query('SELECT 1')).rejects.toBe(error);
    try {
      expect(() => sockets[0].emit('error', error)).not.toThrow();
      await rejected;
    } finally { client.release(); await db.destroy(); }
  });

  it('fails an interrupted Kysely transaction and lets the next operation reconnect', async () => {
    const db = createDb('postgres://fixture:fixture@localhost/fixture');
    await db.ready;
    try {
      await expect(db.kysely.transaction().execute(async (trx) => {
        await sql`SELECT 1`.execute(trx);
        sockets[0].emit('error', timeout());
        await sql`SELECT 1`.execute(trx);
      })).rejects.toThrow('not queryable');
      await expect(sql`SELECT 1`.execute(db.kysely)).resolves.toMatchObject({ rows: [] });
      expect(sockets).toHaveLength(2);
    } finally { await db.destroy(); }
  });

  it('evicts an idle broken client and serves subsequent queries', async () => {
    const db = createDb('postgres://fixture:fixture@localhost/fixture');
    await db.ready;
    const client = await pool.connect();
    client.release();
    try {
      expect(() => sockets[0].emit('error', timeout())).not.toThrow();
      expect(pool.totalCount).toBe(0);
      await expect(pool.query('SELECT 1')).resolves.toMatchObject({ command: 'SELECT' });
    } finally { await db.destroy(); }
  });

  it('keeps one permanent error listener across repeated checkouts', async () => {
    const db = createDb('postgres://fixture:fixture@localhost/fixture');
    await db.ready;
    try {
      for (let i = 0; i < 15; i++) {
        const client = await pool.connect();
        try { expect(client.listenerCount('error')).toBe(1); }
        finally { client.release(); }
      }
    } finally { await db.destroy(); }
  });
});

it('handles standalone client errors between queries without making the client reusable', async () => {
  const { createPostgresClient } = await import('../../packages/platform/src/database/postgres-connections.js');
  const socket = new PostgresSocket();
  sockets.push(socket);
  vi.spyOn(pg, 'Client').mockImplementation(function (config: pg.ClientConfig) {
    return new OriginalClient({ ...config, stream: socket });
  } as typeof pg.Client);
  const client = createPostgresClient({ connectionString: 'postgres://fixture:fixture@localhost/fixture' }, 'tenant-db');
  expect(client.listenerCount('error')).toBe(1);
  await client.connect();
  const error = timeout();
  try {
    expect(() => socket.emit('error', error)).not.toThrow();
    expect(log).toHaveBeenCalledWith(expect.any(String), error);
    await expect(client.query('SELECT 1')).rejects.toThrow('not queryable');
  } finally { await client.end(); }
});
