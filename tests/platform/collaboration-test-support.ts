import { randomUUID } from "node:crypto";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import type { CollaborationPlatformDatabase } from "../../packages/platform/src/collaboration/database.js";
import { createTestPlatformDb, destroyTestPlatformDb, type TestPlatformDb } from "./platform-db-test-helper.js";

export const platformCollaborationActors = {
  owner: "user_platform_owner",
  recipientWithoutComputer: "user_platform_recipient",
  outsider: "user_platform_outsider",
} as const;

export interface PlatformCollaborationTestDatabase extends TestPlatformDb {
  collaborationDb: Kysely<CollaborationPlatformDatabase>;
}

export interface RealPlatformCollaborationTestDatabase {
  collaborationDb: Kysely<CollaborationPlatformDatabase>;
  destroy(): Promise<void>;
}

export async function createPlatformCollaborationTestDatabase(): Promise<PlatformCollaborationTestDatabase> {
  const fixture = await createTestPlatformDb();
  return {
    ...fixture,
    collaborationDb: fixture.db.kysely as unknown as Kysely<CollaborationPlatformDatabase>,
  };
}

export async function createRealPlatformCollaborationTestDatabase(
  connectionString = process.env.MATRIX_TEST_POSTGRES_URL,
): Promise<RealPlatformCollaborationTestDatabase> {
  if (!connectionString) throw new Error("MATRIX_TEST_POSTGRES_URL is required");
  const parsed = new URL(connectionString);
  if (!parsed.pathname.toLowerCase().includes("test")) {
    throw new Error("MATRIX_TEST_POSTGRES_URL must name a dedicated test database");
  }
  const schema = `platform_collaboration_${randomUUID().replaceAll("-", "")}`;
  const adminPool = new Pool({ connectionString, max: 1 });
  const adminDb = new Kysely<Record<string, never>>({ dialect: new PostgresDialect({ pool: adminPool }) });
  await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(adminDb);
  const pool = new Pool({
    connectionString,
    max: 8,
    options: `-c search_path=${schema} -c statement_timeout=5000 -c lock_timeout=2000`,
  });
  const collaborationDb = new Kysely<CollaborationPlatformDatabase>({ dialect: new PostgresDialect({ pool }) });
  return {
    collaborationDb,
    destroy: async () => {
      await collaborationDb.destroy();
      await sql`DROP SCHEMA ${sql.id(schema)} CASCADE`.execute(adminDb);
      await adminDb.destroy();
    },
  };
}

export async function destroyPlatformCollaborationTestDatabase(
  fixture: PlatformCollaborationTestDatabase | undefined,
): Promise<void> {
  await destroyTestPlatformDb(fixture?.db);
}
