import { sql, type Kysely } from "kysely";
import { directRoutineOriginLiveSql, routineReceiptBindingTimestamp } from "./routine-direct-chat-lifecycle.js";
import type { OwnerBotDatabase } from "./database.js";
/** q and b are the immutable request and candidate live binding. Format the database timestamp with the
 * same millisecond floor and optional trailing microseconds as routineCliBindingTimestamp, without
 * casting potentially malformed stored JSON to a timestamp. */
const pinnedTarget = sql`
  q.target_snapshot->>'ownerId'=r.owner_id AND q.target_snapshot->>'computerId'=r.origin_computer_id
  AND q.target_snapshot->>'botId'=r.bot_id AND q.target_snapshot->>'chatId'=r.chat_id
  AND q.target_snapshot->>'bindingCreatedAt'=(${routineReceiptBindingTimestamp(sql.ref("b.created_at"))})
  AND ${directRoutineOriginLiveSql({ ownerId: sql.ref("r.owner_id"), botId: sql.ref("r.bot_id"), chatId: sql.ref("r.chat_id"),
    computerId: sql.ref("r.origin_computer_id"), requestId: sql.ref("r.origin_request_id") })}
  AND NOT EXISTS(SELECT 1 FROM bot_chat_bindings other WHERE other.chat_id=b.chat_id AND other.removed_at IS NULL
    AND (other.owner_id,other.bot_id)<>(b.owner_id,b.bot_id))`;
// Advisory recovery filter only. Receipt writes recheck hasNonPrivateChatScope under the Chat locks.
const nonPrivateScope = sql`scope.owner_type='personal' AND scope.owner_id=r.owner_id AND scope.kind='chat'
  AND scope.lifecycle NOT IN ('private','preparing')`;
/** No execution state is mutated here. Readiness and durable uniqueness are filtered before LIMIT. */
export async function pendingRoutineChatDeliveries(db: Kysely<OwnerBotDatabase>, computerId: string, ownerId?: string, sourceChatId?: string, after?: { updatedAt: string; fireId: string; kind: string }) {
  const result = await sql<{ owner_id: string; source_chat_id: string; updated_at: string; fire_id: string; kind: "status" | "output" }>`
    SELECT r.owner_id, q.source_context->'identity'->>'chatId' AS source_chat_id, f.fire_id, f.updated_at::text AS updated_at, k.kind
    FROM bot_routines r JOIN routine_cli_requests q ON q.owner_id=r.owner_id AND q.computer_id=r.origin_computer_id AND q.client_request_id=r.origin_request_id
    JOIN bot_routine_fires f ON f.owner_id=r.owner_id AND f.routine_id=r.routine_id
    JOIN chats s ON s.id=q.source_context->'identity'->>'chatId' AND s.owner_type='personal' AND s.owner_id=r.owner_id AND s.lifecycle='active' AND s.collaboration IS NULL
    JOIN chats c ON c.id=r.chat_id AND c.owner_type='personal' AND c.owner_id=r.owner_id AND c.lifecycle='active' AND c.collaboration IS NULL
    JOIN bot_chat_bindings b ON b.owner_id=r.owner_id AND b.bot_id=r.bot_id AND b.chat_id=r.chat_id AND b.kind='direct' AND b.removed_at IS NULL
    CROSS JOIN (VALUES ('status'),('output')) AS k(kind)
    WHERE ${pinnedTarget} AND r.origin_computer_id=${computerId} AND q.source_context->'identity'->>'kind'='chat_run'
      AND NOT EXISTS (SELECT 1 FROM collaboration_scopes scope WHERE ${nonPrivateScope} AND scope.resource_id IN (s.id,c.id))
      ${after ? sql`AND (f.updated_at,f.fire_id,k.kind)>(${after.updatedAt}::timestamptz,${after.fireId},${after.kind})` : sql``}
      ${ownerId ? sql`AND r.owner_id=${ownerId}` : sql``}
      ${sourceChatId ? sql`AND s.id=${sourceChatId}` : sql``}
      AND f.status IN ('completed','failed','cancelled','uncertain')
      AND (k.kind='status' AND f.status<>'completed' OR k.kind='output' AND EXISTS (
        SELECT 1 FROM bot_tasks t JOIN chat_runs run ON run.id=t.run_id AND run.chat_id=r.chat_id
        JOIN chat_messages m ON m.run_id=run.id AND m.chat_id=run.chat_id
        WHERE t.owner_id=r.owner_id AND t.task_id=f.task_id AND t.bot_id=r.bot_id AND t.chat_id=r.chat_id
          AND run.status IN ('completed','failed','aborted') AND m.role='assistant' AND m.state='committed'
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(m.parts) p WHERE p->>'type'='text' AND btrim(p->>'text')<>'')))
      AND NOT EXISTS (SELECT 1 FROM routine_chat_deliveries d WHERE d.owner_id=r.owner_id AND d.source_chat_id=s.id
        AND d.routine_id=r.routine_id AND d.fire_id=f.fire_id AND d.attempt=f.attempts AND d.kind=k.kind)
    ORDER BY f.updated_at,f.fire_id,k.kind LIMIT 32`.execute(db);
  return result.rows.map(row => ({ ownerId: row.owner_id, sourceChatId: row.source_chat_id, fireId: row.fire_id, kind: row.kind, updatedAt: row.updated_at }));
}
/** Coarse pending state only; never synthesize success from fire settlement. */
export async function hasPendingRoutineChatOutput(db: import("./repositories/shared.js").BotExecutor, ownerId: string, computerId: string, sourceChatId: string) {
  const result = await sql<{ pending: boolean }>`SELECT EXISTS (
    SELECT 1 FROM bot_routines r JOIN routine_cli_requests q ON q.owner_id=r.owner_id AND q.computer_id=r.origin_computer_id AND q.client_request_id=r.origin_request_id
    JOIN bot_routine_fires f ON f.owner_id=r.owner_id AND f.routine_id=r.routine_id
    JOIN chats c ON c.id=r.chat_id AND c.owner_type='personal' AND c.owner_id=r.owner_id AND c.lifecycle='active' AND c.collaboration IS NULL
    JOIN bot_chat_bindings b ON b.owner_id=r.owner_id AND b.bot_id=r.bot_id AND b.chat_id=r.chat_id AND b.kind='direct' AND b.removed_at IS NULL
    WHERE ${pinnedTarget} AND r.owner_id=${ownerId} AND r.origin_computer_id=${computerId} AND q.source_context->'identity'->>'kind'='chat_run'
      AND NOT EXISTS (SELECT 1 FROM collaboration_scopes scope WHERE ${nonPrivateScope} AND scope.resource_id=c.id)
      AND q.source_context->'identity'->>'chatId'=${sourceChatId} AND f.status='completed'
      AND NOT EXISTS(SELECT 1 FROM routine_chat_deliveries d WHERE d.owner_id=r.owner_id AND d.source_chat_id=${sourceChatId}
        AND d.routine_id=r.routine_id AND d.fire_id=f.fire_id AND d.attempt=f.attempts AND d.kind='output')
  ) AS pending`.execute(db);
  return result.rows[0]?.pending ?? false;
}
