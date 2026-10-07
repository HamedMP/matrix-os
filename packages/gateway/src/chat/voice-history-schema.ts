import { generatedVoiceChatTitle } from "@matrix-os/contracts";
import { sql, type Kysely } from "kysely";
import type { ChatDatabase } from "./database.js";

/** Owner-local migration. Use durable bootstrap provenance, never a title or ID
 * heuristic, to recognize previous assistant conversations. Owner renames survive.
 */
export async function bootstrapVoiceHistory<Database extends ChatDatabase>(db: Kysely<Database>): Promise<void> {
  // Version 2 belongs to the existing owner-attribution repair.
  const applied = await sql`SELECT version FROM chat_schema_migrations WHERE version = 3`.execute(db);
  if (applied.rows.length) return;
  await db.transaction().execute(async trx => {
    await sql`LOCK TABLE chats IN ACCESS EXCLUSIVE MODE`.execute(trx);
    const existing = await sql`SELECT version FROM chat_schema_migrations WHERE version = 3`.execute(trx);
    if (existing.rows.length) return;
    await sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS conversation_kind TEXT NOT NULL DEFAULT 'chat'
      CHECK (conversation_kind IN ('chat', 'voice'))`.execute(trx);
    await sql`UPDATE chats SET conversation_kind = 'voice',
      title = CASE WHEN title = 'Aoede' AND title_version = 0 THEN 'Voice conversation' ELSE title END,
      title_manual = CASE WHEN title = 'Aoede' AND title_version = 0 THEN false ELSE title_manual END
      WHERE EXISTS (SELECT 1 FROM aoede_bootstrap_requests requests
        WHERE requests.created_chat_id = chats.id AND requests.owner_type = chats.owner_type
          AND requests.owner_id = chats.owner_id)`.execute(trx);
    // Existing completed conversations should already have useful titles on
    // their first visit. Bound each batch and transcript window; bootstrap runs
    // before subscribers, under the same exclusive migration transaction.
    let afterId = "";
    for (;;) {
      const candidates = await sql<{ id: string; opening: string[] }>`
        SELECT chats.id, ARRAY(SELECT LEFT(messages.search_text, 8000)
          FROM chat_messages messages WHERE messages.chat_id = chats.id
            AND messages.role = 'user' AND messages.state = 'committed'
          ORDER BY messages.seq LIMIT 3) AS opening
        FROM chats WHERE conversation_kind = 'voice' AND title_manual = false
          AND title_version = 0 AND id > ${afterId} ORDER BY id LIMIT 100`.execute(trx);
      if (!candidates.rows.length) break;
      for (const candidate of candidates.rows) {
        const title = generatedVoiceChatTitle(candidate.opening);
        if (title) await sql`UPDATE chats SET title = ${title}, title_version = 1, revision = revision + 1
          WHERE id = ${candidate.id} AND title_manual = false AND title_version = 0`.execute(trx);
      }
      afterId = candidates.rows.at(-1)!.id;
    }
    await sql`CREATE INDEX IF NOT EXISTS idx_chats_owner_kind_activity
      ON chats(owner_type, owner_id, conversation_kind, lifecycle, activity_at DESC, id)`.execute(trx);
    await sql`INSERT INTO chat_schema_migrations(version) VALUES (3)`.execute(trx);
  });
}
