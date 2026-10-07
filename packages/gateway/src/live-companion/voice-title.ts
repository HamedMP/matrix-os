import { generatedVoiceChatTitle } from "@matrix-os/contracts";
import type { Selectable } from "kysely";
import type { ChatsTable } from "../chat/database.js";
import type { ChatRepository } from "../chat/repository.js";
import { ChatConflictError, ChatNotFoundError } from "../chat/errors.js";
import type { ChatOwner } from "../chat/records.js";

/** Caller holds the Chat row lock; only committed owner messages supply topics. */
export async function openingVoiceTitle(db: ChatRepository["kysely"], chat: Selectable<ChatsTable>): Promise<string | null> {
  if (chat.conversation_kind !== "voice" || chat.title_manual || Number(chat.title_version) !== 0) return null;
  const opening = await db.selectFrom("chat_messages").select("search_text").where("chat_id", "=", chat.id)
    .where("role", "=", "user").where("state", "=", "committed").orderBy("seq").limit(3).execute();
  return generatedVoiceChatTitle(opening.map(message => message.search_text));
}

/** Closing can finish a single committed utterance. No inference request or
 * personal subscription is required, and an owner rename always wins. */
export async function finishVoiceTitle(repository: ChatRepository, owner: ChatOwner, chatId: string): Promise<void> {
  await repository.withTransaction(async repo => {
    const db = repo.kysely;
    const chat = await db.selectFrom("chats").selectAll().where("id", "=", chatId)
      .where("owner_type", "=", owner.type).where("owner_id", "=", owner.ownerId)
      .where("collaboration", "is", null).forUpdate().executeTakeFirst();
    if (!chat) throw new ChatNotFoundError(chatId);
    const title = await openingVoiceTitle(db, chat);
    if (!title) return;
    const updated = await db.updateTable("chats").set({ title, title_version: Number(chat.title_version) + 1,
      revision: Number(chat.revision) + 1, updated_at: new Date().toISOString() })
      .where("id", "=", chatId).where("revision", "=", chat.revision)
      .where("title_version", "=", chat.title_version).where("title_manual", "=", false)
      .returning("revision").executeTakeFirst();
    if (!updated) throw new ChatConflictError(chatId, Number(chat.revision));
    await repo.appendOutboxEvent(owner, chatId, Number(updated.revision), "chat.updated");
  });
}
