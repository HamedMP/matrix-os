import type { CanonicalChatReadState, CanonicalUpdateChatReadStateRequest } from "@matrix-os/contracts";
import { sql, type Kysely, type Selectable } from "kysely";
import type { ChatDatabase, ChatsTable } from "./database.js";
import type { ChatOwner } from "./records.js";
import { ChatConflictError } from "./errors.js";

export async function projectChatReadState(
  db: Kysely<ChatDatabase>, owner: ChatOwner, chatId: string,
): Promise<CanonicalChatReadState> {
  const [state, incoming] = await Promise.all([
    db.selectFrom("chat_user_state").selectAll().where("chat_id", "=", chatId)
      .where("principal_id", "=", owner.ownerId).executeTakeFirst(),
    db.selectFrom("chat_messages").select(({ fn }) => fn.max<number>("seq").as("seq"))
      .where("chat_id", "=", chatId).where("role", "=", "assistant")
      .where("state", "=", "committed").executeTakeFirst(),
  ]);
  const latestIncomingSeq = Number(incoming?.seq ?? 0);
  const readThroughSeq = Number(state?.read_through_seq ?? 0);
  const markedUnread = state?.marked_unread ?? false;
  return {
    unread: markedUnread || latestIncomingSeq > readThroughSeq,
    markedUnread, version: Number(state?.read_state_version ?? 0), readThroughSeq, latestIncomingSeq,
  };
}

// Caller holds the owned Chat row lock in the same transaction as the outbox write.
export async function writeChatReadState(
  db: Kysely<ChatDatabase>, owner: ChatOwner, chat: Selectable<ChatsTable>,
  input: CanonicalUpdateChatReadStateRequest,
): Promise<boolean> {
  await db.insertInto("chat_user_state").values({
    chat_id: chat.id, principal_id: owner.ownerId, read_through_seq: 0,
    pinned: false, muted: false, attention_acknowledged_at: null, last_opened_at: null,
  }).onConflict((conflict) => conflict.columns(["chat_id", "principal_id"]).doNothing()).execute();
  const state = await db.selectFrom("chat_user_state").selectAll().where("chat_id", "=", chat.id)
    .where("principal_id", "=", owner.ownerId).forUpdate().executeTakeFirstOrThrow();
  if (input.type === "mark_read" && input.throughSeq > Number(chat.message_count)) {
    throw new ChatConflictError(chat.id, Number(chat.revision));
  }
  if (input.type === "mark_read" && input.baseVersion !== Number(state.read_state_version)) return false;
  const markedUnread = input.type === "mark_unread";
  const throughSeq = input.type === "mark_read"
    ? Math.max(Number(state.read_through_seq), input.throughSeq)
    : Number(state.read_through_seq);
  if (!markedUnread && !state.marked_unread && throughSeq === Number(state.read_through_seq)) return false;
  await db.updateTable("chat_user_state").set({
    marked_unread: markedUnread, read_through_seq: throughSeq,
    read_state_version: sql`read_state_version + 1`, updated_at: sql`now()`,
    ...(input.type === "mark_read" ? { last_opened_at: sql<Date>`now()` } : {}),
  }).where("chat_id", "=", chat.id).where("principal_id", "=", owner.ownerId).execute();
  return true;
}

export function unreadChatPredicate(principalId: string) {
  return sql<boolean>`(
    EXISTS (SELECT 1 FROM chat_user_state s WHERE s.chat_id = chats.id
      AND s.principal_id = ${principalId} AND s.marked_unread)
    OR EXISTS (SELECT 1 FROM chat_messages m WHERE m.chat_id = chats.id
      AND m.role = 'assistant' AND m.state = 'committed' AND m.seq > COALESCE(
        (SELECT s.read_through_seq FROM chat_user_state s
          WHERE s.chat_id = chats.id AND s.principal_id = ${principalId}), 0))
  )`;
}
