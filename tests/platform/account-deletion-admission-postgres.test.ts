import { randomUUID } from 'node:crypto';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import type { PlatformDB, PlatformDatabase } from '../../packages/platform/src/db.js';
import { migrateAccountDeletion } from '../../packages/platform/src/database/migrations/account-deletion.js';
import { AccountDeletionRepository } from '../../packages/platform/src/account-deletion/repository.js';
import { withAccountDeletionAdmission } from '../../packages/platform/src/account-deletion/admission.js';

const connectionString = process.env.MATRIX_TEST_POSTGRES_URL;
describe.skipIf(!connectionString)('account deletion admission on PostgreSQL', () => {
  it('keeps deletion acceptance behind admitted writes and rejects every later owner write', async () => {
    const secret = 'account-deletion-postgres-admission-secret';
    const owner = 'user_postgres_admission';
    const schema = `deletion_admission_${randomUUID().replaceAll('-', '')}`;
    const admin = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ connectionString, max: 1 }) }) });
    await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
    const db = new Kysely<PlatformDatabase>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString, max: 4, application_name: schema, options: `-c search_path=${schema},public` }) }) });
    const wrap = (executor: PlatformDB['executor']): PlatformDB => ({
      kysely: db, executor, ready: Promise.resolve(), destroy: async () => {},
      transaction: (work) => executor === db ? db.transaction().execute((trx) => work(wrap(trx))) : work(wrap(executor)),
    });
    try {
      await migrateAccountDeletion(db);
      await sql`CREATE TABLE admission_writes (owner TEXT PRIMARY KEY)`.execute(db);
      let release!: () => void;
      let signal!: () => void;
      const started = new Promise<void>((resolve) => { signal = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const admission = withAccountDeletionAdmission(wrap(db), owner, async (trx) => {
        signal(); await gate;
        await sql`INSERT INTO admission_writes(owner) VALUES(${owner})`.execute(trx.executor);
      }, { ACCOUNT_DELETION_SECRET: secret });
      await started;
      const repo = new AccountDeletionRepository(db, { secret });
      const scheduling = repo.accept({ clerkUserId: owner, appleTokens: [] }, false);
      try {
        const waitingForLock = async () => {
          for (let attempts = 0; attempts < 100; attempts += 1) {
            const result = await sql<{ waiting: boolean }>`SELECT EXISTS (
              SELECT 1 FROM pg_locks lock JOIN pg_stat_activity activity ON activity.pid = lock.pid
              WHERE lock.locktype = 'advisory' AND NOT lock.granted AND activity.application_name = ${schema}
            ) AS waiting`.execute(admin);
            if (result.rows[0].waiting) return true;
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          return false;
        };
        expect(await Promise.race([waitingForLock(), scheduling.then(() => false)])).toBe(true);
      } finally { release(); }
      await Promise.all([admission, scheduling]);
      expect((await sql`SELECT * FROM admission_writes`.execute(db)).rows).toHaveLength(1);
      await expect(withAccountDeletionAdmission(wrap(db), owner, async () => { throw new Error('must not run'); }, { ACCOUNT_DELETION_SECRET: secret })).rejects.toThrow('Account deletion is pending');
    } finally {
      await db.destroy(); await sql`DROP SCHEMA ${sql.id(schema)} CASCADE`.execute(admin); await admin.destroy();
    }
  });
});
