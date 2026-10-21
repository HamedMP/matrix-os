import { EventEmitter } from 'node:events';
import { observePostgresPoolErrors } from '@matrix-os/observability/postgres';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresSocket } from '../helpers/postgres-socket.js';
import { createAppDb } from '../../packages/gateway/src/app-db.js';
import { createPlatformDb } from '../../packages/gateway/src/platform-db.js';
import { MessagingKyselyRepository } from '../../packages/gateway/src/messages/repository.js';
import { CanvasRepository } from '../../packages/gateway/src/canvas/repository.js';
import { OsViewStateRepository } from '../../packages/gateway/src/os-view-state/repository.js';
import { createOwnedJevMaintenance } from '../../packages/gateway/src/jev/owned-maintenance.js';

const connectionString = 'postgres://fixture:fixture@localhost/fixture';
const OriginalPool = pg.Pool;
const timeout = () => Object.assign(new Error('read ETIMEDOUT'), { code: 'ETIMEDOUT' });
interface ConnectionOwner { run(): Promise<unknown>; close(): Promise<void> }
const owners: Array<{ name: string; open(): ConnectionOwner }> = [
  { name: 'app database', open() {
    const { db } = createAppDb(connectionString);
    return { run: () => db.raw('SELECT 1'), close: () => db.destroy() };
  } },
  { name: 'platform database', open() {
    const db = createPlatformDb(connectionString);
    return { run: () => db.raw('SELECT 1', []), close: () => db.destroy() };
  } },
  { name: 'messaging', open() {
    const repo = MessagingKyselyRepository.fromConnectionString(connectionString);
    return { run: () => sql`SELECT 1`.execute(repo.kysely), close: () => repo.destroy() };
  } },
  { name: 'canvas', open() {
    const repo = CanvasRepository.fromConnectionString(connectionString);
    return { run: () => sql`SELECT 1`.execute(repo.kysely), close: () => repo.destroy() };
  } },
  { name: 'OS view state', open() {
    const repo = OsViewStateRepository.fromConnectionString(connectionString);
    return { run: () => sql`SELECT 1`.execute(repo.kysely), close: () => repo.destroy() };
  } },
  { name: 'Jev maintenance', open() {
    const maintenance = createOwnedJevMaintenance({ databaseUrl: connectionString });
    return { run: () => sql`SELECT 1`.execute(maintenance.repository.kysely), close: () => maintenance.close() };
  } },
];
let pool: pg.Pool;
let sockets: PostgresSocket[];
let owner: ConnectionOwner | undefined;

beforeEach(() => {
  sockets = [];
  owner = undefined;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(pg, 'Pool').mockImplementation(function (config: pg.PoolConfig) {
    pool = new OriginalPool({ ...config, stream: () => {
      const socket = new PostgresSocket();
      sockets.push(socket);
      return socket;
    } });
    return pool;
  } as typeof pg.Pool);
});
afterEach(async () => {
  try { await owner?.close(); }
  finally { for (const socket of sockets) socket.destroy(); vi.restoreAllMocks(); }
});

describe.each(owners)('$name connection errors', ({ open }) => {
  it('handles a checked-out timeout, rejects further queries, and replaces the failed client', async () => {
    owner = open();
    const client = await pool.connect();
    try {
      expect(() => sockets[0].emit('error', timeout())).not.toThrow();
      await expect(client.query('SELECT 1')).rejects.toThrow('not queryable');
    } finally { client.release(); }
    await expect(owner.run()).resolves.toBeDefined();
    expect(sockets).toHaveLength(2);
  });

  it('handles an unexpected socket close during a query without an uncaught exception', async () => {
    owner = open();
    const client = await pool.connect();
    sockets[0].holdQueries = true;
    try {
      const rejected = expect(client.query('SELECT 1')).rejects.toThrow('Connection terminated unexpectedly');
      sockets[0].destroy();
      await rejected;
      await expect(client.query('SELECT 1')).rejects.toThrow('not queryable');
    } finally { client.release(); }
    await expect(owner.run()).resolves.toBeDefined();
    expect(sockets).toHaveLength(2);
  });

  it('rejects interrupted queries with the original timeout', async () => {
    owner = open();
    const client = await pool.connect();
    sockets[0].holdQueries = true;
    const error = timeout();
    const rejected = expect(client.query('SELECT 1')).rejects.toBe(error);
    try {
      expect(() => sockets[0].emit('error', error)).not.toThrow();
      await rejected;
    } finally { client.release(); }
  });

  it('fails a transaction without replaying a potentially applied write', async () => {
    owner = open();
    // Exercise a Kysely transaction on the factory's pool without taking its ownership.
    const transactionDb = new Kysely({ dialect: new PostgresDialect({ pool }) });
    const update = 'UPDATE probe SET value = value + 1';
    const interrupted = transactionDb.transaction().execute(async (trx) => {
      sockets[0].holdQueries = true;
      await sql.raw(update).execute(trx);
    });
    const rejected = expect(interrupted).rejects.toThrow('not queryable');
    await vi.waitFor(() => expect(sockets[0]?.statements).toContain(update));
    expect(() => sockets[0].emit('error', timeout())).not.toThrow();
    await rejected;
    await expect(owner.run()).resolves.toBeDefined();
    expect(sockets).toHaveLength(2);
    expect(sockets.flatMap(socket => socket.statements).filter(statement => statement === update)).toHaveLength(1);
  });

  it('evicts an idle failed connection and reconnects', async () => {
    owner = open();
    const client = await pool.connect();
    client.release();
    vi.mocked(console.error).mockClear();
    expect(() => sockets[0].emit('error', timeout())).not.toThrow();
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(pool.totalCount).toBe(0);
    await expect(owner.run()).resolves.toBeDefined();
    expect(sockets).toHaveLength(2);
  });

  it('keeps one permanent error listener over repeated checkouts', async () => {
    owner = open();
    for (let index = 0; index < 20; index++) {
      const client = await pool.connect();
      try { expect(client.listenerCount('error')).toBe(1); }
      finally { client.release(); }
    }
    expect(sockets).toHaveLength(1);
  });

  it('preserves the owner shutdown path after connection recovery', async () => {
    owner = open();
    const client = await pool.connect();
    try { expect(() => sockets[0].emit('error', timeout())).not.toThrow(); }
    finally { client.release(); }
    await owner.run();
    await owner.close();
    owner = undefined;
    expect(pool.ended).toBe(true);
    expect(pool.totalCount).toBe(0);
  });
});

it.each(['unused', 'raw-only', 'Kysely-initialized'] as const)(
  'closes an owned app pool exactly once when %s', async (mode) => {
    const { db, kysely } = createAppDb(connectionString);
    owner = { run: () => db.raw('SELECT 1'), close: () => db.destroy() };
    if (mode === 'raw-only') await db.raw('SELECT 1');
    if (mode === 'Kysely-initialized') await sql`SELECT 1`.execute(kysely);
    const end = vi.spyOn(pool, 'end');
    await Promise.all([db.destroy(), db.destroy()]);
    owner = undefined;
    expect(pool.ended).toBe(true);
    expect(end).toHaveBeenCalledTimes(1);
  },
);


it('reports forwarded errors once, while preserving separate errors and later occurrences', async () => {
  const emitter = new EventEmitter();
  const client = new EventEmitter();
  const report = vi.fn();
  observePostgresPoolErrors(emitter, report);
  emitter.emit('connect', client);
  const error = timeout();
  client.emit('error', error);
  emitter.emit('error', error);
  expect(report).toHaveBeenCalledTimes(1);
  const separate = timeout();
  client.emit('error', separate);
  emitter.emit('error', separate);
  expect(report).toHaveBeenCalledTimes(2);
  await Promise.resolve();
  client.emit('error', error);
  emitter.emit('error', error);
  expect(report).toHaveBeenCalledTimes(3);
});

it('passes non-object error events to the owner reporter without throwing', () => {
  const emitter = new EventEmitter();
  const report = vi.fn();
  observePostgresPoolErrors(emitter, report);
  expect(() => emitter.emit('error', 'failure')).not.toThrow();
  expect(() => emitter.emit('error', null)).not.toThrow();
  expect(report.mock.calls).toEqual([['failure'], [null]]);
});
