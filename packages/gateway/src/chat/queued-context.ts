import { withChatSessionHistory, SESSION_HISTORY_MESSAGE_LIMIT } from "./session-history.js";
import { isChatAgentDriver, type ChatRunContext, type CanonicalChatQueuedTurn } from "@matrix-os/contracts";
import { ChatConflictError } from "./errors.js";
import type { Kysely, Transaction } from "kysely";
import type { ChatDatabase } from "./database.js";
import { toMessage } from "./records.js";
import { chatContextRequestHash } from "./agent-context.js";

export function validateQueuedAgentDriver(context: ChatRunContext | undefined, driver: string, chatId: string, revision: number) {
  if (context?.agent && !isChatAgentDriver(driver)) throw new ChatConflictError(chatId, revision);
  if (context?.drives?.length && driver !== "claude_code") throw new ChatConflictError(chatId, revision);
}

/** Called under the Chat row lock, before its queued input is committed. */
export async function queuedRunContext(
  db: Kysely<ChatDatabase> | Transaction<ChatDatabase>, queued: CanonicalChatQueuedTurn,
  title: string, messageCount: number, privateChat = true,
): Promise<ChatRunContext | undefined> {
  if (!privateChat || queued.selection.instanceId === "matrix_bot_default" || !messageCount) return queued.context;
  const rows = await db.selectFrom("chat_messages").selectAll()
    .where("chat_id", "=", queued.chatId).orderBy("seq", "desc").limit(SESSION_HISTORY_MESSAGE_LIMIT + 1).execute();
  return withChatSessionHistory({
    chatId: queued.chatId, title, throughSeq: messageCount,
    requestHash: queued.context?.requestHash ?? chatContextRequestHash({ ...queued, baseRevision: 0 }),
    messages: rows.slice(0, SESSION_HISTORY_MESSAGE_LIMIT).reverse().map(toMessage),
    truncated: rows.length > SESSION_HISTORY_MESSAGE_LIMIT, context: queued.context,
  });
}
