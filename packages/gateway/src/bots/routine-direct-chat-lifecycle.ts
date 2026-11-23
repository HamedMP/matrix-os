import { sql, type Expression } from "kysely";
import {
  isRoutineDirectBotId, isRoutineDirectChatId,
  ROUTINE_DIRECT_BOT_ID_PATTERN, ROUTINE_DIRECT_CHAT_ID_PATTERN,
} from "./routine-direct-chat-identity.js";
import { routineDirectChatSourceEligible, routineDirectChatSourceIsEligible } from "./routine-direct-chat-contexts.js";
import type { RoutineChatOrigin } from "./routine-chat-origin-map.js";
import { hasAcceptedBinding, type RoutineOriginTargetLock } from "./routine-chat-origin-target.js";
import type { BotExecutor } from "./repositories/shared.js";

type Coordinates = { ownerId: string; botId: string; chatId: string };
export function isDirectRoutineTarget({ botId, chatId }: Coordinates): boolean {
  // A partial or corrupt reserved identity also requires the scheduler origin.
  return isRoutineDirectBotId(botId) || isRoutineDirectChatId(chatId);
}

/** Exact binding incarnation used by origin reconciliation and occurrence admission. */
export function routineReceiptBindingTimestamp(bindingCreatedAt: Expression<Date | string>) {
  return sql<string>`to_char(${bindingCreatedAt} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS')
    ||rtrim(right(to_char(${bindingCreatedAt} AT TIME ZONE 'UTC','US'),3),'0')||'Z'`;
}

type SqlCoordinates = { ownerId: Expression<string>; botId: Expression<string>; chatId: Expression<string> };
export function isDirectRoutineTargetSql({ botId, chatId }: Omit<SqlCoordinates, "ownerId">) {
  return sql<boolean>`(${botId} ~ ${ROUTINE_DIRECT_BOT_ID_PATTERN.source} OR ${chatId} ~ ${ROUTINE_DIRECT_CHAT_ID_PATTERN.source})`;
}

/** Same gate in the bounded scheduler scan and the fresh occurrence authorization snapshot. */
export function directRoutineOriginLiveSql(input: SqlCoordinates & {
  computerId: Expression<string | null>; requestId: Expression<string | null>;
}) {
  return sql<boolean>`(
    NOT ${isDirectRoutineTargetSql(input)} OR EXISTS (
      SELECT 1 FROM routine_direct_chat_contexts context
      JOIN routine_cli_requests receipt ON receipt.owner_id=context.owner_id AND receipt.computer_id=context.computer_id
      JOIN bot_chat_bindings pinned ON pinned.owner_id=context.owner_id AND pinned.bot_id=context.bot_id AND pinned.chat_id=context.chat_id
      WHERE context.owner_id=${input.ownerId} AND context.bot_id=${input.botId} AND context.chat_id=${input.chatId}
        AND context.computer_id=${input.computerId} AND receipt.client_request_id=${input.requestId}
        AND context.activated_at IS NOT NULL AND pinned.removed_at IS NULL AND pinned.kind='direct'
        AND receipt.operation->>'operation'='propose' AND lower(receipt.operation->>'requestId')=receipt.client_request_id::text
        AND receipt.admission->>'disposition'='queued'
        AND receipt.source_context->>'ownerId'=context.owner_id AND receipt.source_context->>'computerId'=context.computer_id
        AND receipt.source_context->'identity'->>'kind'='chat_run'
        AND receipt.source_context->'identity'->>'chatId'=context.source_chat_id
        AND receipt.target_snapshot->>'purpose'='direct_chat' AND receipt.target_snapshot->>'sourceChatId'=context.source_chat_id
        AND receipt.target_snapshot->>'ownerId'=context.owner_id AND receipt.target_snapshot->>'computerId'=context.computer_id
        AND receipt.target_snapshot->>'botId'=context.bot_id AND receipt.target_snapshot->>'chatId'=context.chat_id
        AND receipt.target_snapshot->>'bindingCreatedAt'=(${routineReceiptBindingTimestamp(sql.ref("pinned.created_at"))})
        AND NOT EXISTS (
          SELECT 1 FROM bot_chat_bindings other WHERE other.chat_id=pinned.chat_id AND other.removed_at IS NULL
            AND (other.owner_id,other.bot_id)<>(pinned.owner_id,pinned.bot_id))
        AND ${routineDirectChatSourceEligible(sql.ref("context.owner_id"), sql.ref("context.source_chat_id"))}
    )
  )`;
}

export function hasLiveDirectRoutineOrigin(
  db: BotExecutor, input: Coordinates & { origin: { computerId: string; requestId: string } | null },
) {
  if (!isDirectRoutineTarget(input)) return Promise.resolve(true);
  if (!input.origin) return Promise.resolve(false);
  const row = db.selectFrom("bot_routines").select("routine_id")
    .where("owner_id", "=", input.ownerId).where("bot_id", "=", input.botId).where("chat_id", "=", input.chatId)
    .where("origin_computer_id", "=", input.origin.computerId).where("origin_request_id", "=", input.origin.requestId)
    .where(directRoutineOriginLiveSql({ ownerId: sql.ref("bot_routines.owner_id"), botId: sql.ref("bot_routines.bot_id"), chatId: sql.ref("bot_routines.chat_id"),
      computerId: sql.ref("bot_routines.origin_computer_id"), requestId: sql.ref("bot_routines.origin_request_id") }));
  return row.executeTakeFirst().then(Boolean);
}

function activeContext(db: BotExecutor, input: Coordinates) {
  return db.selectFrom("routine_direct_chat_contexts").select(["source_chat_id", "computer_id"])
    .where("owner_id", "=", input.ownerId).where("bot_id", "=", input.botId).where("chat_id", "=", input.chatId)
    .where("activated_at", "is not", null);
}

/** Take the source lock before the routine or canonical Chat lock. The origin decision takes it first too. */
export async function lockDirectRoutineSource(db: BotExecutor, input: Coordinates): Promise<boolean> {
  if (!isDirectRoutineTarget(input)) return true;
  const context = await activeContext(db, input).executeTakeFirst();
  return Boolean(context && await routineDirectChatSourceIsEligible(db, { ownerId: input.ownerId, sourceChatId: context.source_chat_id }, { lock: true }));
}

export async function isMappedDirectRoutineSourceAvailable(db: BotExecutor, target: Coordinates & { computerId: string; sourceChatId: string }): Promise<boolean> {
  const context = await activeContext(db, target).where("computer_id", "=", target.computerId)
    .where("source_chat_id", "=", target.sourceChatId).executeTakeFirst();
  return Boolean(context && await routineDirectChatSourceIsEligible(db, target));
}

export async function isCurrentDirectRoutineOrigin(db: BotExecutor, origin: RoutineChatOrigin, lockTarget: RoutineOriginTargetLock = false): Promise<boolean> {
  if (!origin.directChat) return false;
  return await isMappedDirectRoutineSourceAvailable(db, { ...origin, chatId: origin.canonicalChatId })
    && await hasAcceptedBinding(db, origin.ownerId, origin.canonicalChatId, origin.botId, origin.bindingCreatedAt, lockTarget);
}
