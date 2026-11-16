import { sql, type Transaction } from "kysely";
import { BOT_MIGRATIONS } from "./database-migrations.js";
import type { OwnerBotDatabase } from "./database.js";

// These ID ranges were reserved by the direct-routine preview. The v15 runtime
// cannot prove the extra source-Chat authority its internal coordinators require.
const coordinatorBot = /^bot_routine[a-f0-9]{32}$/;
const coordinatorChat = /^chat_routine_[a-f0-9]{32}$/;
export function isRetainedRoutineCoordinator(botId: string, chatId: string): boolean {
  return (coordinatorBot.test(botId) || coordinatorChat.test(chatId))
    && !BOT_MIGRATIONS.some(migration => migration.version === 17 && migration.name === "routine_direct_chat");
}

/** #3209 wrote these immutable ledger records on Dev before the v15 test build. */
export const RETAINED_ROUTINE_PREVIEW_VERSIONS = [
  { version: 16, name: "routine_chat_origin" },
  { version: 17, name: "routine_direct_chat" },
  { version: 18, name: "bot_chat_binding_history_index" },
] as const;

const previewColumnTypes = {
  bot_routines: { origin_computer_id: "text:YES", origin_request_id: "uuid:YES" },
  routine_chat_deliveries: {
    owner_id: "text:NO", source_chat_id: "text:NO", routine_id: "text:NO", fire_id: "text:NO",
    attempt: "int4:NO", kind: "text:NO", message_id: "text:NO", receipt: "jsonb:NO", created_at: "timestamptz:NO",
  },
  routine_direct_chat_contexts: {
    owner_id: "text:NO", computer_id: "text:NO", source_chat_id: "text:NO",
    bot_id: "text:NO", chat_id: "text:NO", activated_at: "timestamptz:YES",
  },
} as const;

/** The caller holds the Bot migration lock. Check the deployed additive shape
 * before reading preview-only columns, then allow only dormant preview work. */
export async function canReadRetainedRoutinePreview(db: Transaction<OwnerBotDatabase>): Promise<boolean> {
  const columns = await sql<{ table_name: string; column_name: string; kind: string; column_default: string | null }>`
    SELECT table_name, column_name, udt_name || ':' || is_nullable AS kind, column_default FROM information_schema.columns
    WHERE table_schema = current_schema() AND (
      table_name IN ('routine_chat_deliveries', 'routine_direct_chat_contexts') OR
      (table_name = 'bot_routines' AND column_name IN ('origin_computer_id', 'origin_request_id'))
    )`.execute(db);
  const expected = Object.entries(previewColumnTypes).flatMap(([table_name, fields]) =>
    Object.entries(fields).map(([column_name, kind]) => ({ table_name, column_name, kind })));
  if (columns.rows.length !== expected.length || !expected.every(wanted => columns.rows.some(row =>
    row.table_name === wanted.table_name && row.column_name === wanted.column_name && row.kind === wanted.kind
    && row.column_default === null))) return false;

  const markers = await sql<{ ready: boolean }>`SELECT
    (SELECT count(*) FROM pg_constraint WHERE conrelid = 'bot_routines'::regclass AND convalidated AND (
      (conname = 'bot_routines_origin_pair' AND contype = 'c'
        AND pg_get_constraintdef(oid) = 'CHECK (((origin_computer_id IS NULL) = (origin_request_id IS NULL)))') OR
      (conname = 'bot_routines_origin_receipt' AND contype = 'f' AND confrelid = 'routine_cli_requests'::regclass
        AND pg_get_constraintdef(oid) = 'FOREIGN KEY (owner_id, origin_computer_id, origin_request_id) REFERENCES routine_cli_requests(owner_id, computer_id, client_request_id)')
    )) = 2 AND
    (SELECT count(*) FROM pg_index JOIN pg_class AS idx ON idx.oid = indexrelid
      WHERE indisvalid AND indisready AND (
        (idx.relname = 'routine_cli_proposals_one_interaction' AND indrelid = 'routine_cli_proposals'::regclass
          AND indisunique AND indnatts = 2 AND pg_get_indexdef(indexrelid, 1, true) = 'owner_id'
          AND pg_get_indexdef(indexrelid, 2, true) = 'interaction_id'
          AND pg_get_expr(indpred, indrelid) = '(interaction_id IS NOT NULL)') OR
        (idx.relname = 'routine_chat_deliveries_source' AND indrelid = 'routine_chat_deliveries'::regclass
          AND NOT indisunique AND indnatts = 3 AND indpred IS NULL
          AND pg_get_indexdef(indexrelid, 1, true) = 'owner_id' AND pg_get_indexdef(indexrelid, 2, true) = 'source_chat_id'
          AND pg_get_indexdef(indexrelid, 3, true) = 'created_at' AND (indoption[2] & 1) = 1) OR
        (idx.relname = 'bot_routines_origin' AND indrelid = 'bot_routines'::regclass
          AND NOT indisunique AND indnatts = 3 AND pg_get_expr(indpred, indrelid) = '(origin_request_id IS NOT NULL)'
          AND pg_get_indexdef(indexrelid, 1, true) = 'owner_id' AND pg_get_indexdef(indexrelid, 2, true) = 'origin_computer_id'
          AND pg_get_indexdef(indexrelid, 3, true) = 'origin_request_id') OR
        (idx.relname = 'idx_bot_chat_bindings_chat_history' AND indrelid = 'bot_chat_bindings'::regclass
          AND NOT indisunique AND indnatts = 3 AND indpred IS NULL
          AND pg_get_indexdef(indexrelid, 1, true) = 'chat_id' AND pg_get_indexdef(indexrelid, 2, true) = 'owner_id'
          AND pg_get_indexdef(indexrelid, 3, true) = 'bot_id')
      )) = 4 AS ready`.execute(db);
  if (markers.rows[0]?.ready !== true) return false;

  const pending = await sql<{ live: boolean }>`SELECT
    EXISTS (SELECT 1 FROM routine_direct_chat_contexts
      WHERE bot_id !~ ${coordinatorBot.source} OR chat_id !~ ${coordinatorChat.source}) OR
    EXISTS (SELECT 1 FROM bot_routines AS routine
      WHERE (routine.origin_request_id IS NOT NULL OR routine.bot_id ~ ${coordinatorBot.source} OR routine.chat_id ~ ${coordinatorChat.source})
        AND (routine.status <> 'archived' OR EXISTS (
          SELECT 1 FROM bot_routine_fires AS fire
          WHERE fire.owner_id = routine.owner_id AND fire.routine_id = routine.routine_id AND fire.status IN ('claimed', 'dispatched')))) OR
    EXISTS (SELECT 1 FROM bot_tasks WHERE (bot_id ~ ${coordinatorBot.source} OR chat_id ~ ${coordinatorChat.source})
      AND status NOT IN ('completed', 'failed', 'cancelled')) OR
    EXISTS (SELECT 1 FROM bot_interactions AS interaction
      WHERE (interaction.bot_id ~ ${coordinatorBot.source} OR interaction.chat_id ~ ${coordinatorChat.source})
        AND (interaction.status = 'pending' OR EXISTS (
          SELECT 1 FROM bot_approvals AS approval
          WHERE approval.approval_id = interaction.interaction_id AND approval.tool = 'routine.activate' AND approval.status = 'pending'))) OR
    EXISTS (SELECT 1 FROM chat_queued_turns WHERE chat_id ~ ${coordinatorChat.source} AND status = 'queued') OR
    EXISTS (SELECT 1 FROM chat_runs WHERE chat_id ~ ${coordinatorChat.source}
      AND status IN ('accepted', 'running', 'waiting_for_input', 'waiting_for_approval')) AS live`.execute(db);
  return pending.rows[0]?.live === false;
}
