import { sql } from "kysely";
import { routineCliBindingTimestamp } from "./repositories/routine-cli-preferences.js";
import { RoutineCliResolvedTargetSchema } from "./routine-cli-targets.js";
import { parseJson } from "../chat/records.js";
import { isRoutineDirectChatId, isRoutineDirectBotId } from "./routine-direct-chat-identity.js";
import { hasNonPrivateChatScope } from "../chat/private-routine-authority.js";
import { BotStateError, type BotExecutor } from "./repositories/shared.js";

/** Match the accepted target variant to the actual receipt origin. Legacy receipts never authorize
 * a reserved scheduler identity, even if their owner, destination and binding timestamp match. */
export function acceptedRoutineOriginTarget(raw: unknown, ownerId: string, computerId: string, botId: string, chatId: string, sourceChatId: string) {
  const parsed = RoutineCliResolvedTargetSchema.safeParse(parseJson(raw));
  if (!parsed.success) return;
  const target = parsed.data;
  if (target.ownerId !== ownerId || target.computerId !== computerId || target.botId !== botId || target.chatId !== chatId
    || sourceChatId === chatId) return;
  if ("purpose" in target) {
    if (target.sourceChatId !== sourceChatId || !isRoutineDirectChatId(chatId) || !isRoutineDirectBotId(botId)) return;
  } else if (isRoutineDirectChatId(chatId) || isRoutineDirectBotId(botId)) return;
  return target;
}

export async function boundOriginQueries(db: BotExecutor) {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await sql`SET LOCAL statement_timeout = '10s'`.execute(db);
}

/** All origin transactions take this bounded owner lock before either Chat, including multi-target reads.
 * This prevents crossed source/target pairs from taking Chat row locks in opposite orders. */
export async function beginOriginTransaction(db: BotExecutor, ownerId: string) {
  await boundOriginQueries(db);
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${"routine-chat-origin:" + ownerId},0))`.execute(db);
}

export type RoutineOriginTargetLock = false | "ordered" | "recheck";

/** Follow canonical approval's binding → Chat rowmark order. The parent lock fences FK inserts,
 * and locking removed memberships also fences in-place restorations. */
export async function hasAcceptedBinding(db: BotExecutor, ownerId: string, chatId: string, botId: string, bindingCreatedAt: string,
  lock: RoutineOriginTargetLock = "ordered") {
  const locked = lock && await sql<{ count: string }>`WITH locked AS MATERIALIZED (
    SELECT 1 FROM bot_chat_bindings WHERE chat_id=${chatId} ORDER BY owner_id,bot_id
    FOR SHARE ${lock === "recheck" ? sql`NOWAIT` : sql``}
  ) SELECT count(*)::text AS count FROM locked`.execute(db);
  const target = db.selectFrom("chats").select("id").where("id","=",chatId).where("owner_type","=","personal")
    .where("owner_id","=",ownerId).where("lifecycle","=","active").where("collaboration","is",null);
  // Chat deletion can hold the parent while cascading to its bindings. Defer rather than wait in reverse.
  const chat = await (lock ? target.forUpdate().noWait() : target).executeTakeFirst();
  if (!chat || await hasNonPrivateChatScope(db as never, { type: "personal", ownerId }, chatId)) return false;
  if (locked) {
    // A membership inserted before we obtained the parent lock might not be covered by the first scan.
    // All first-scan rows are still locked, so any count change means the set needs a later recheck.
    const current = await sql<{ count: string }>`SELECT count(*)::text AS count FROM bot_chat_bindings WHERE chat_id=${chatId}`.execute(db);
    if (locked.rows[0]!.count !== current.rows[0]!.count) throw new BotStateError("conflict");
  }
  const active = await db.selectFrom("bot_chat_bindings").select(["owner_id", "bot_id", "kind"])
    .select(sql<string>`created_at::text`.as("created")).where("chat_id","=",chatId).where("removed_at","is",null).limit(2).execute();
  return active.length === 1 && active[0].owner_id === ownerId && active[0].bot_id === botId && active[0].kind === "direct"
    && routineCliBindingTimestamp(active[0].created) === bindingCreatedAt;
}
