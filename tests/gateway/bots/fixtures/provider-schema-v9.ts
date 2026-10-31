// Frozen historical deployed v9. Do not import a production v9 migration here.
// Source: HamedMP/matrix-os 736d251d7bd097db1e7fb2822309767ffb1a9332,
// packages/gateway/src/bots/database-migrations.ts:352-367.
import { sql, type Transaction } from "kysely";
import type { OwnerBotDatabase } from "../../../../packages/gateway/src/bots/database.js";

export const DEPLOYED_THREADS_V9_SOURCE = "736d251d7bd097db1e7fb2822309767ffb1a9332";
export const DEPLOYED_THREADS_V9_SQL = [
  "ALTER TABLE bot_chat_bindings DROP CONSTRAINT bot_chat_bindings_kind_check",
  "\n    ALTER TABLE bot_chat_bindings ADD CONSTRAINT bot_chat_bindings_kind_check CHECK (kind IN ('direct', 'group', 'thread'))\n  ",
  "ALTER TABLE bot_chat_bindings ADD COLUMN project_id TEXT",
  "\n    ALTER TABLE bot_chat_bindings ADD CONSTRAINT bot_chat_bindings_thread_project CHECK (\n      (kind = 'thread') = (project_id IS NOT NULL)\n      AND (project_id IS NULL OR project_id ~ '^proj_[A-Za-z0-9_-]{1,128}$')\n    )\n  ",
  "\n    CREATE INDEX idx_bot_chat_bindings_threads ON bot_chat_bindings(owner_id, bot_id, project_id)\n    WHERE kind = 'thread' AND removed_at IS NULL\n  ",
] as const;

export async function migrateDeployedBotChatThreadsV9(trx: Transaction<OwnerBotDatabase>): Promise<void> {
  for (const statement of DEPLOYED_THREADS_V9_SQL) await sql.raw(statement).execute(trx);
}
