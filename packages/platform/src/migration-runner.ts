import { setTimeout as delay } from "node:timers/promises";
import { sql, type Kysely, type Transaction } from "kysely";

export async function runPlatformMigration<Database>(
  db: Kysely<Database>,
  migrateSchema: (transaction: Transaction<Database>) => Promise<void>,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await db.transaction().execute(async (transaction) => {
        await sql`SELECT pg_advisory_xact_lock(hashtext('matrix_os_platform_schema_migration'))`.execute(transaction);
        await migrateSchema(transaction);
      });
      return;
    } catch (error) {
      const deadlock = typeof error === "object" && error !== null &&
        "code" in error && error.code === "40P01";
      if (!deadlock || attempt === 2) throw error;
      // The failed transaction has rolled back, releasing its DDL and advisory locks.
      // Other live transactions do not participate in the migration advisory lock.
      console.warn("[platform] Schema migration deadlocked; retrying the full transaction.");
      await delay(250 * 2 ** attempt + Math.floor(Math.random() * 250));
    }
  }
}
