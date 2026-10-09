import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { bootstrapSiteSubmissionDatabase } from '../../packages/gateway/src/sites/bootstrap.js';
const postgresUrl = process.env.MATRIX_TEST_POSTGRES_URL;
const postgres = postgresUrl ? describe : describe.skip;
postgres('bounded site setup with independent PostgreSQL sessions', () => {
 it('destroys the owned setup socket when an established connection stops returning reads', async () => {
  if (!new URL(postgresUrl!).pathname.includes('test')) throw new Error('Test database required');
  const connect = pg.Pool.prototype.connect;
  let client: pg.PoolClient | undefined;
  const paused = vi.spyOn(pg.Pool.prototype, 'connect').mockImplementation(async function(this: pg.Pool) {
   client = await connect.call(this);
   // Authentication has completed. Stop delivering server responses to this client.
   (client as any).connection.stream.pause();
   return client;
  });
  try {
   const start = Date.now();
   await expect(bootstrapSiteSubmissionDatabase(postgresUrl!)).rejects.toThrow('Query read timeout');
   expect(Date.now() - start).toBeLessThan(10000);
   expect((client as any).connection.stream.destroyed).toBe(true);
  } finally { paused.mockRestore(); }
 }, 15000);
 it('cancels blocked DDL and releases its owned connection while the lock holder remains live', async () => {
  if (!new URL(postgresUrl!).pathname.includes('test')) throw new Error('Test database required');
  const owner = new pg.Pool({ connectionString: postgresUrl, max: 1, connectionTimeoutMillis: 5000, query_timeout: 10000 });
  let locker: pg.PoolClient | undefined;
  try {
   await bootstrapSiteSubmissionDatabase(postgresUrl!);
   locker = await owner.connect();
   await locker.query('BEGIN');
   await locker.query('LOCK TABLE public._site_submissions IN ACCESS EXCLUSIVE MODE');
   const start = Date.now();
   await expect(bootstrapSiteSubmissionDatabase(postgresUrl!)).rejects.toMatchObject({ code: '55P03' });
   expect(Date.now() - start).toBeLessThan(5000);
   // Its failure neither closes this owner's separate connection nor releases the lock.
   expect((await locker.query('SELECT 1 AS live')).rows).toEqual([{ live: 1 }]);
  } finally {
   if (locker) { await locker.query('ROLLBACK'); locker.release(); }
   await owner.end();
  }
  await bootstrapSiteSubmissionDatabase(postgresUrl!);
 }, 15000);
});
