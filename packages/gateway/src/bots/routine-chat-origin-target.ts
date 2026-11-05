import { sql } from "kysely";
import { z } from "zod/v4";
import { RoutineCliRememberTargetSchema } from "@matrix-os/contracts";
import { RoutineCliScopeSchema, routineCliBindingTimestamp } from "./repositories/routine-cli-preferences.js";
import type { BotExecutor } from "./repositories/shared.js";

const snapshot = RoutineCliScopeSchema.extend({
  botId: RoutineCliRememberTargetSchema.shape.botId, chatId: RoutineCliRememberTargetSchema.shape.chatId,
  bindingCreatedAt: z.iso.datetime({ offset: true }), preferenceRevision: z.number().int().positive(),
}).strict();
export function acceptedBinding(raw: unknown, ownerId: string, computerId: string, botId: string, chatId: string) {
  const parsed = snapshot.safeParse(raw);
  const target = parsed.success ? parsed.data : undefined;
  return target?.ownerId === ownerId && target.computerId === computerId && target.botId === botId && target.chatId === chatId
    ? target.bindingCreatedAt : undefined;
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

/** Match the exact accepted incarnation and reject ambiguous membership. Parent row lock fences FK inserts;
 * locking removed memberships as well fences in-place restorations, which do not change the FK. */
export async function hasAcceptedBinding(db: BotExecutor, ownerId: string, chatId: string, botId: string, bindingCreatedAt: string, lock = true) {
  const target = db.selectFrom("chats").select("id").where("id","=",chatId).where("owner_type","=","personal")
    .where("owner_id","=",ownerId).where("lifecycle","=","active").where("collaboration","is",null);
  const chat = await (lock ? target.forUpdate() : target).executeTakeFirst();
  if (!chat) return false;
  if (lock) await sql`WITH locked AS MATERIALIZED (
    SELECT 1 FROM bot_chat_bindings WHERE chat_id=${chatId} ORDER BY owner_id,bot_id FOR SHARE
  ) SELECT count(*) FROM locked`.execute(db);
  const active = await db.selectFrom("bot_chat_bindings").select(["owner_id", "bot_id", "kind"])
    .select(sql<string>`created_at::text`.as("created")).where("chat_id","=",chatId).where("removed_at","is",null).limit(2).execute();
  return active.length === 1 && active[0].owner_id === ownerId && active[0].bot_id === botId && active[0].kind === "direct"
    && routineCliBindingTimestamp(active[0].created) === bindingCreatedAt;
}
