import { sql, type Kysely, type Selectable } from "kysely";
import { z } from "zod/v4";
import type { ChatDatabase, ChatsTable } from "./database.js";
import type { ChatOwner } from "./records.js";

export async function searchChats(db: Kysely<ChatDatabase>, owner: ChatOwner, queryInput: string,
  limitInput = 20, projectId?: string | null, conversationKind?: "chat" | "voice"): Promise<Selectable<ChatsTable>[]> {
    const searchText = queryInput.trim().slice(0, 200);
    if (!searchText) return [];
    let query = db.selectFrom("chats")
      .innerJoin("chat_messages", "chat_messages.chat_id", "chats.id")
      .selectAll("chats")
      .distinct()
      .where("chats.owner_type", "=", owner.type).where("chats.owner_id", "=", owner.ownerId)
      .where("chat_messages.state", "=", "committed")
      .where(sql<boolean>`to_tsvector('simple', chat_messages.search_text) @@ plainto_tsquery('simple', ${searchText})`);
    if (projectId !== undefined) {
      query = projectId === null
        ? query.where("chats.project_id", "is", null)
        : query.where("chats.project_id", "=", projectId);
    }
    if (conversationKind) query = query.where("chats.conversation_kind", "=", z.enum(["chat", "voice"]).parse(conversationKind));
    const rows = await query.orderBy("chats.updated_at", "desc")
      .limit(Math.max(1, Math.min(100, Math.trunc(limitInput)))).execute();
    return rows;
}
