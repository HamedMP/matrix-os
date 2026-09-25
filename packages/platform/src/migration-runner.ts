import { setTimeout as delay } from "node:timers/promises";
import { sql, type Kysely, type Transaction } from "kysely";

export async function runPlatformMigration<Database>(
  db: Kysely<Database>,
  migrateSchema: (transaction: Transaction<Database>) => Promise<void>,
  options: { revision?: { generation: number; fingerprint: string }; deadlockAttempts?: number } = {},
): Promise<void> {
  const maxAttempts = options.deadlockAttempts ?? 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await db.transaction().execute(async (transaction) => {
        await sql`SELECT pg_advisory_xact_lock(hashtext('matrix_os_platform_schema_migration'))`.execute(transaction);
        if (options.revision) {
          // Only the migration runner touches this table. Once a revision has
          // completed, new Cloud Run instances avoid all no-op ALTER TABLE
          // statements and their AccessExclusiveLocks on live application data.
          await sql`
            CREATE TABLE IF NOT EXISTS platform_schema_revisions (
              scope TEXT PRIMARY KEY,
              generation INTEGER NOT NULL CHECK (generation > 0),
              fingerprint TEXT NOT NULL,
              applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
          `.execute(transaction);
          const applied = await sql<{ generation: number; fingerprint: string }>`
            SELECT generation, fingerprint FROM platform_schema_revisions WHERE scope = 'core'
          `.execute(transaction);
          const current = applied.rows[0];
          if (current && current.generation > options.revision.generation) return;
          if (current?.generation === options.revision.generation) {
            if (current.fingerprint !== options.revision.fingerprint) {
              throw new Error('Conflicting platform schema fingerprints for one generation');
            }
            return;
          }
        }
        await migrateSchema(transaction);
        if (options.revision) {
          await sql`
            INSERT INTO platform_schema_revisions (scope, generation, fingerprint)
            VALUES ('core', ${options.revision.generation}, ${options.revision.fingerprint})
            ON CONFLICT (scope) DO UPDATE SET
              generation = EXCLUDED.generation,
              fingerprint = EXCLUDED.fingerprint,
              applied_at = NOW()
            WHERE platform_schema_revisions.generation < EXCLUDED.generation
          `.execute(transaction);
        }
      });
      return;
    } catch (error) {
      const deadlock = typeof error === "object" && error !== null &&
        "code" in error && error.code === "40P01";
      if (!deadlock || attempt === maxAttempts - 1) throw error;
      // The failed transaction has rolled back, releasing its DDL and advisory locks.
      // Other live transactions do not participate in the migration advisory lock.
      console.warn("[platform] Schema migration deadlocked; retrying the full transaction.");
      await delay(Math.min(3_000, 250 * 2 ** attempt) + Math.floor(Math.random() * 250));
    }
  }
}
