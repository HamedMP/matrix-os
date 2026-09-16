import { sql, type Kysely } from "kysely";
import { setTimeout as delay } from "node:timers/promises";
import type { ChatDatabase } from "./database.js";

async function migrated(db: Kysely<ChatDatabase>): Promise<boolean> {
  const table = await sql<{ exists: boolean }>`SELECT to_regclass('chat_schema_migrations') IS NOT NULL AS exists`.execute(db);
  if (!table.rows[0]?.exists) return false;
  const marker = await sql`SELECT version FROM chat_schema_migrations WHERE version = 1`.execute(db);
  return marker.rows.length > 0;
}

/** One marked, serialized transaction; retry the whole migration on lock conflicts. */
export async function bootstrapChatMetadata<Database extends ChatDatabase>(db: Kysely<Database>): Promise<void> {
  const executor = db as unknown as Kysely<ChatDatabase>;
  if (await migrated(executor)) return;
  for (let attempt = 0; ; attempt++) {
    try {
      await executor.transaction().execute(async (trx) => {
        // Every metadata migrator takes the same first lock, before any schema work.
        await sql`LOCK TABLE chats IN ACCESS EXCLUSIVE MODE`.execute(trx);
        await sql`CREATE TABLE IF NOT EXISTS chat_schema_migrations (version INTEGER PRIMARY KEY)`.execute(trx);
        if (await migrated(trx)) return;
        await sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS title_version INTEGER NOT NULL DEFAULT 0`.execute(trx);
        // Existing titles have no reliable provenance. Preserve them conservatively.
        await sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS title_manual BOOLEAN NOT NULL DEFAULT true`.execute(trx);
        await sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS activity_at TIMESTAMPTZ`.execute(trx);
        await sql`UPDATE chats SET activity_at = greatest(
          created_at,
          (SELECT max(created_at) FROM chat_messages WHERE chat_id = chats.id AND role = 'user' AND state = 'committed'),
          (SELECT max(created_at) FROM chat_queued_turns WHERE chat_id = chats.id)
        ) WHERE activity_at IS NULL`.execute(trx);
        await sql`ALTER TABLE chats ALTER COLUMN activity_at SET DEFAULT now()`.execute(trx);
        await sql`ALTER TABLE chats ALTER COLUMN activity_at SET NOT NULL`.execute(trx);
        await sql`CREATE INDEX IF NOT EXISTS idx_chats_owner_activity ON chats(owner_type, owner_id, lifecycle, activity_at DESC, id)`.execute(trx);
        await sql`INSERT INTO chat_schema_migrations (version) VALUES (1)`.execute(trx);
      });
      return;
    } catch (error: unknown) {
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (attempt >= 2 || (code !== "40P01" && code !== "40001")) throw error;
      console.warn("[chat/metadata] Retrying schema migration after lock conflict");
      await delay(25 * (attempt + 1));
    }
  }
}
