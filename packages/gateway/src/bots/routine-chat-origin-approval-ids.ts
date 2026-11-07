import { sql } from "kysely";
import type { BotExecutor } from "./repositories/shared.js";
/** Select source-scoped candidates before the limit. A Schedules edit has no
 * new source turn, so only the pending view can show its standing approval. */
export async function routineChatOriginApprovalIds(
  db: BotExecutor, ownerId: string, computerId: string, sourceChatId: string, now: string, history: boolean,
) {
  const status = history
    ? sql`(i.status IN ('resolved', 'expired', 'cancelled') OR (i.status='pending' AND i.expires_at<=${now}::timestamptz))`
    : sql`i.status='pending' AND i.expires_at>${now}::timestamptz`;
  const editCandidates = history ? sql`` : sql`OR EXISTS (
    SELECT 1 FROM bot_routines r JOIN bot_approvals a ON a.owner_id=r.owner_id AND a.approval_id=r.approval_id
    JOIN routine_cli_requests q ON q.owner_id=r.owner_id AND q.computer_id=r.origin_computer_id AND q.client_request_id=r.origin_request_id
    WHERE r.owner_id=i.owner_id AND a.task_id=i.task_id AND r.bot_id=i.bot_id AND r.chat_id=i.chat_id
      AND r.origin_computer_id=${computerId} AND q.source_context->'identity'->>'kind'='chat_run'
      AND q.source_context->'identity'->>'chatId'=${sourceChatId}
  )`;
  const result = await sql<{ interaction_id: string }>`
    SELECT i.interaction_id FROM bot_interactions i
    WHERE i.owner_id=${ownerId} AND i.responder_actor_id=${ownerId} AND i.kind='approval'
      AND ${status} AND i.payload->>'tool'='routine.activate'
      AND (EXISTS (
        SELECT 1 FROM routine_cli_proposals p JOIN routine_cli_requests q
          ON q.owner_id=p.owner_id AND q.computer_id=p.computer_id AND q.client_request_id=p.client_request_id
        WHERE p.owner_id=i.owner_id AND p.interaction_id=i.interaction_id AND p.task_id=i.task_id
          AND p.run_id=i.source_run_id AND p.stage='pending_approval' AND p.computer_id=${computerId}
          AND q.source_context->'identity'->>'kind'='chat_run' AND q.source_context->'identity'->>'chatId'=${sourceChatId}
      ) ${editCandidates}) ORDER BY i.created_at DESC,i.interaction_id DESC LIMIT 32`.execute(db);
  return result.rows;
}
