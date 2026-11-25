import { sql, type Kysely } from "kysely";
import type { ChatDatabase } from "../chat/database.js";
import type { CodingAgentThreadStore } from "../coding-agents/thread-store.js";
import { findChatForAgentThread } from "../chat/agent-thread-chat-routes.js";

/** The first thread event precedes state.updated; its server-created turn already names the accepted run. */
export async function isCanonicalNotificationThread(db: Kysely<ChatDatabase>, threads: CodingAgentThreadStore, ownerId: string, threadId: string): Promise<boolean> {
  if (await findChatForAgentThread(db, ownerId, threadId)) return true;
  const requestId = await threads.latestTurnRequestId({ userId: ownerId, source: "configured-container" }, threadId);
  if (!requestId) return false;
  return !!await db.selectFrom("chat_runs as run").innerJoin("chats as chat", "chat.id", "run.chat_id").select("run.id")
    .where("chat.owner_type", "=", "personal").where("chat.owner_id", "=", ownerId)
    .where(sql<string>`'req_' || substring(run.id from 5)`, "=", requestId).limit(1).executeTakeFirst();
}
