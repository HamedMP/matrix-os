import { ChatRunContextSchema, type ChatRunContext, type CanonicalChatQueuedTurn } from "@matrix-os/contracts";
import type { Kysely, Transaction } from "kysely";
import type { ChatDatabase } from "./database.js";
import { parseJson, toMessage } from "./records.js";
import { chatContextRequestHash, transcript } from "./agent-context.js";

/** Called under the Chat row lock, before its queued input is committed. */
export async function queuedRunContext(
  db: Kysely<ChatDatabase> | Transaction<ChatDatabase>, queued: CanonicalChatQueuedTurn,
  title: string, messageCount: number,
): Promise<ChatRunContext | undefined> {
  const previous = await db.selectFrom("chat_runs").select("context_snapshot")
    .where("chat_id", "=", queued.chatId).orderBy("history_boundary_seq", "desc")
    .orderBy("attempt", "desc").limit(1).executeTakeFirst();
  const previousContext = previous?.context_snapshot == null ? undefined
    : ChatRunContextSchema.parse(parseJson(previous.context_snapshot));
  if (!queued.context?.history && !previousContext?.agent) return queued.context;
  const rows = await db.selectFrom("chat_messages").selectAll()
    .where("chat_id", "=", queued.chatId).orderBy("seq", "desc").limit(41).execute();
  const history = transcript(rows.slice(0, 40).reverse().map(toMessage), 12_000);
  return ChatRunContextSchema.parse({
    version: 1,
    requestHash: queued.context?.requestHash ?? chatContextRequestHash({
      ...queued, baseRevision: 0,
    }),
    ...queued.context,
    chats: queued.context?.chats ?? [],
    history: {
      chatId: queued.chatId, title, throughSeq: messageCount,
      ...history, truncated: history.truncated || rows.length > 40,
    },
  });
}
