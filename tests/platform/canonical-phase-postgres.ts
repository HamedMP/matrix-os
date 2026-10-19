import { randomUUID } from "node:crypto";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { createPlatformDb } from "../../packages/platform/src/db.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";

/** Opt-in, loopback, dedicated PostgreSQL test schema. Never owner/runtime data. */
export async function createCanonicalPlatformTestDb() {
  const connectionString = process.env.MATRIX_TEST_POSTGRES_URL;
  if (!connectionString) {
    const { db } = await createTestPlatformDb();
    return { db, close: () => destroyTestPlatformDb(db) };
  }
  const url = new URL(connectionString);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !url.pathname.toLowerCase().includes("test")) throw new Error("Dedicated loopback test Postgres is required");
  const schema = `canonical_readiness_${randomUUID().replaceAll("-", "")}`;
  const admin = new Kysely<Record<string, never>>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 1 }) }) });
  let db: ReturnType<typeof createPlatformDb> | undefined;
  let schemaCreated = false;
  const close = async () => {
    try { await db?.destroy(); }
    finally {
      try {
        if (schemaCreated) {
          await sql`drop schema ${sql.id(schema)} cascade`.execute(admin);
          schemaCreated = false;
        }
      } finally { await admin.destroy(); }
    }
  };
  try {
    await sql`create schema ${sql.id(schema)}`.execute(admin);
    schemaCreated = true;
    db = createPlatformDb({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 4,
      options: `-c search_path=${schema} -c statement_timeout=10000 -c lock_timeout=5000` }) }) });
    await db.ready;
    return { db, close };
  } catch (error: unknown) {
    try { await close(); }
    catch (cleanupError: unknown) {
      throw new AggregateError([error, cleanupError], "Canonical test database setup and cleanup failed");
    }
    throw error;
  }
}
