import { CanonicalChatIdSchema, CanonicalOwnerScopeSchema } from "@matrix-os/contracts";
import type { Kysely } from "kysely";
import type { ChatDatabase } from "./database.js";
import type { ChatOwner } from "./records.js";

/** Owner-scoped keyset page; never depends on optional Bot tables. */
export async function listQueuedChatCandidates(
  db: Kysely<ChatDatabase>, ownerInput: ChatOwner, limit: number, afterChatId?: string,
): Promise<string[]> {
  const owner = CanonicalOwnerScopeSchema.parse(ownerInput);
  const cursor = afterChatId === undefined ? undefined : CanonicalChatIdSchema.parse(afterChatId);
  const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(Math.trunc(limit), 20)) : 20;
  let query = db.selectFrom("chat_queued_turns as queued")
    .innerJoin("chats as chat", "chat.id", "queued.chat_id")
    .select("queued.chat_id")
    .where("queued.status", "=", "queued")
    .where("chat.owner_type", "=", owner.type)
    .where("chat.owner_id", "=", owner.ownerId);
  if (cursor !== undefined) query = query.where("queued.chat_id", ">", cursor);
  const rows = await query.groupBy("queued.chat_id").orderBy("queued.chat_id").limit(boundedLimit).execute();
  return rows.map(row => row.chat_id);
}
