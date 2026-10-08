import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { createPlatformDb } from '../../packages/platform/src/db.js';
import { createAccountDeletionMutationGuard } from '../../packages/platform/src/account-deletion/integration-admission.js';
import { createWhatsAppRepository } from '../../packages/platform/src/whatsapp/repository.js';

const connectionString = process.env.MATRIX_TEST_POSTGRES_URL;
describe.skipIf(!connectionString)('guarded integration connection reuse on PostgreSQL', () => {
  it('finishes bursts with a two-connection pool, reuses downstream transactions and rolls back errors', async () => {
    const schema = `deletion_pool_${randomUUID().replaceAll('-', '')}`;
    const admin = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ connectionString, max: 1 }) }) });
    await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
    const db = createPlatformDb({ dialect: new PostgresDialect({ pool: new Pool({ connectionString, max: 2,
      connectionTimeoutMillis: 1500, options: `-c search_path=${schema},public -c statement_timeout=3000` }) }) });
    try {
      await db.ready;
      const repo = createWhatsAppRepository(db, Buffer.alloc(32, 7));
      await sql`CREATE TABLE guarded_writes(owner TEXT NOT NULL, pid INTEGER NOT NULL)`.execute(db.executor);
      const app = new Hono();
      app.use('*', createAccountDeletionMutationGuard({ db, env: { ACCOUNT_DELETION_SECRET: 'guard-pool-regression-secret-at-least-32' },
        resolveOwner: c => c.req.header('x-test-owner') }));
      app.post('/write', async c => {
        const owner = c.req.header('x-test-owner')!;
        // This repository was composed before request scope and opens its own transaction.
        await repo.disconnect(owner);
        const first = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(db.executor);
        await db.transaction(async trx => {
          const second = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx.executor);
          if (first.rows[0]!.pid !== second.rows[0]!.pid) throw new Error('Nested connection');
          await sql`INSERT INTO guarded_writes(owner,pid) VALUES(${owner},${second.rows[0]!.pid})`.execute(trx.executor);
        });
        if (owner === 'user_rollback') throw new Error('Private failure');
        return c.json({ written: true });
      });
      for (const owners of [Array.from({ length: 8 }, (_, i) => `user_pool_${i}`), Array(8).fill('user_shared_owner')]) {
        const responses = await Promise.all(owners.map(owner => app.request('/write', { method: 'POST', headers: { 'x-test-owner': owner } })));
        expect(responses.map(response => response.status)).toEqual(Array(8).fill(200));
      }
      const failed = await app.request('/write', { method: 'POST', headers: { 'x-test-owner': 'user_rollback' } });
      expect(failed.status).toBeGreaterThanOrEqual(500);
      expect((await sql`SELECT * FROM guarded_writes WHERE owner='user_rollback'`.execute(db.executor)).rows).toHaveLength(0);
      expect((await sql`SELECT * FROM guarded_writes`.execute(db.executor)).rows).toHaveLength(16);
    } finally {
      await db.destroy(); await sql`DROP SCHEMA ${sql.id(schema)} CASCADE`.execute(admin); await admin.destroy();
    }
  }, 30_000);
});
