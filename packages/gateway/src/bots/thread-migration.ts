import { sql, type Transaction } from "kysely";
import type { OwnerBotDatabase } from "./database.js";

/** Exact deployed v9 from 736d251d7; retain dormant threads without enabling execution. */
export async function migrateBotChatThreadsV9(trx: Transaction<OwnerBotDatabase>): Promise<void> {
  await sql`ALTER TABLE bot_chat_bindings DROP CONSTRAINT bot_chat_bindings_kind_check`.execute(trx);
  await sql`
    ALTER TABLE bot_chat_bindings ADD CONSTRAINT bot_chat_bindings_kind_check CHECK (kind IN ('direct', 'group', 'thread'))
  `.execute(trx);
  await sql`ALTER TABLE bot_chat_bindings ADD COLUMN project_id TEXT`.execute(trx);
  await sql`
    ALTER TABLE bot_chat_bindings ADD CONSTRAINT bot_chat_bindings_thread_project CHECK (
      (kind = 'thread') = (project_id IS NOT NULL)
      AND (project_id IS NULL OR project_id ~ '^proj_[A-Za-z0-9_-]{1,128}$')
    )
  `.execute(trx);
  await sql`
    CREATE INDEX idx_bot_chat_bindings_threads ON bot_chat_bindings(owner_id, bot_id, project_id)
    WHERE kind = 'thread' AND removed_at IS NULL
  `.execute(trx);
}
