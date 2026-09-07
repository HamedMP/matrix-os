import { randomUUID } from "node:crypto";
import { KyselyPGlite } from "kysely-pglite";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import type { ChatDatabase } from "../../packages/gateway/src/chat/database.js";
import type { CollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";

export const collaborationActors = {
  owner: "user_collaboration_owner",
  editor: "user_collaboration_editor",
  viewer: "user_collaboration_viewer",
  outsider: "user_collaboration_outsider",
} as const;

export const collaborationIds = {
  scope: "10000000-0000-4000-8000-000000000001",
  chat: "chat_collaboration_primary",
  runtime: "runtime_collaboration_owner",
} as const;

export interface CollaborationTestDatabase {
  db: Kysely<ChatDatabase & CollaborationDatabase>;
  destroy(): Promise<void>;
}

/** PostgreSQL-compatible unit fixture. Real-server race tests use MATRIX_TEST_POSTGRES_URL. */
export async function createCollaborationTestDatabase(): Promise<CollaborationTestDatabase> {
  const instance = await KyselyPGlite.create();
  const db = new Kysely<ChatDatabase & CollaborationDatabase>({ dialect: instance.dialect });
  return {
    db,
    destroy: async () => {
      await db.destroy();
    },
  };
}

/** Isolated schema on a dedicated PostgreSQL server for lock/race verification. */
export async function createRealCollaborationTestDatabase(
  connectionString = process.env.MATRIX_TEST_POSTGRES_URL,
): Promise<CollaborationTestDatabase> {
  if (!connectionString) throw new Error("MATRIX_TEST_POSTGRES_URL is required");
  const parsed = new URL(connectionString);
  if (!parsed.pathname.toLowerCase().includes("test")) {
    throw new Error("MATRIX_TEST_POSTGRES_URL must name a dedicated test database");
  }
  const schema = `collaboration_${randomUUID().replaceAll("-", "")}`;
  const adminPool = new Pool({ connectionString, max: 1 });
  const adminDb = new Kysely<Record<string, never>>({ dialect: new PostgresDialect({ pool: adminPool }) });
  await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(adminDb);
  const pool = new Pool({
    connectionString,
    max: 8,
    options: `-c search_path=${schema} -c statement_timeout=5000 -c lock_timeout=2000`,
  });
  const db = new Kysely<ChatDatabase & CollaborationDatabase>({ dialect: new PostgresDialect({ pool }) });
  return {
    db,
    destroy: async () => {
      await db.destroy();
      await sql`DROP SCHEMA ${sql.id(schema)} CASCADE`.execute(adminDb);
      await adminDb.destroy();
    },
  };
}
