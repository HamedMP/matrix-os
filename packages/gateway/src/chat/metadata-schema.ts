import { sql, type Kysely } from "kysely";
import type { ChatDatabase } from "./database.js";

/** Backfill once from user input, never from agent-driven updated_at. */
export async function bootstrapChatMetadata<Database extends ChatDatabase>(db: Kysely<Database>): Promise<void> {
  await db.transaction().execute(async (trx) => {
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
  });
}
