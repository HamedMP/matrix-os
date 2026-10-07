import { generatedVoiceChatTitle } from "@matrix-os/contracts";
import { sql, type Kysely } from "kysely";
import type { ChatDatabase } from "./database.js";

/** Owner-local migration. Use durable bootstrap provenance, never a title or ID
 * heuristic, to recognize previous assistant conversations. Owner renames survive.
 */
export async function bootstrapVoiceHistory<Database extends ChatDatabase>(db: Kysely<Database>): Promise<void> {
  // Version 2 belongs to the existing owner-attribution repair.
  const applied = await sql`SELECT version FROM chat_schema_migrations WHERE version = 3`.execute(db);
  if (!applied.rows.length) await db.transaction().execute(async trx => {
    // Only schema installation owns this short exclusive lock. Historical
    // message scans and row updates run after commit, never under this lock.
    await sql`LOCK TABLE chats IN ACCESS EXCLUSIVE MODE`.execute(trx);
    const existing = await sql`SELECT version FROM chat_schema_migrations WHERE version = 3`.execute(trx);
    if (existing.rows.length) return;
    await sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS conversation_kind TEXT NOT NULL DEFAULT 'chat'
      CHECK (conversation_kind IN ('chat', 'voice'))`.execute(trx);
    await sql`INSERT INTO chat_schema_migrations(version) VALUES (3)`.execute(trx);
  });
  await sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chats_owner_kind_activity
    ON chats(owner_type, owner_id, conversation_kind, lifecycle, activity_at DESC, id)`.execute(db);
  await backfillVoiceHistory(db);
}

/** Restartable bounded batches leave unrelated Chat reads/writes available.
 * Guards in each update preserve concurrent owner renames and live titles. */
async function backfillVoiceHistory<Database extends ChatDatabase>(db: Kysely<Database>): Promise<void> {
  for (;;) {
    const legacy = await sql<{ id: string }>`SELECT chats.id FROM chats
      WHERE conversation_kind = 'chat' AND EXISTS (
        SELECT 1 FROM aoede_bootstrap_requests requests WHERE requests.created_chat_id = chats.id
          AND requests.owner_type = chats.owner_type AND requests.owner_id = chats.owner_id)
      ORDER BY chats.id LIMIT 100`.execute(db);
    if (!legacy.rows.length) break;
    await sql`UPDATE chats SET conversation_kind = 'voice',
      title = CASE WHEN title = 'Aoede' AND title_version = 0 THEN 'Voice conversation' ELSE title END,
      title_manual = CASE WHEN title = 'Aoede' AND title_version = 0 THEN false ELSE title_manual END
      WHERE id IN (${sql.join(legacy.rows.map(row => row.id))}) AND conversation_kind = 'chat'`.execute(db);
  }
  let afterId = "";
  for (;;) {
    const candidates = await sql<{ id: string; opening: string[] }>`
      SELECT chats.id, ARRAY(SELECT LEFT(messages.search_text, 8000)
        FROM chat_messages messages WHERE messages.chat_id = chats.id
          AND messages.role = 'user' AND messages.state = 'committed'
        ORDER BY messages.seq LIMIT 3) AS opening
      FROM chats WHERE conversation_kind = 'voice' AND title_manual = false
        AND title_version = 0 AND id > ${afterId} ORDER BY id LIMIT 100`.execute(db);
    if (!candidates.rows.length) break;
    await db.transaction().execute(async trx => {
      for (const candidate of candidates.rows) {
        const title = generatedVoiceChatTitle(candidate.opening);
        if (title) await sql`UPDATE chats SET title = ${title}, title_version = 1, revision = revision + 1
          WHERE id = ${candidate.id} AND conversation_kind = 'voice'
            AND title_manual = false AND title_version = 0`.execute(trx);
      }
    });
    afterId = candidates.rows.at(-1)!.id;
  }
}
