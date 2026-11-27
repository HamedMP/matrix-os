import { randomUUID } from "node:crypto";
import { CanonicalChatMessageSchema, type CanonicalChatContent, type CanonicalChatMessage, type CanonicalChatTurn } from "@matrix-os/contracts";
import { sql, type Kysely, type Transaction } from "kysely";
import type { ChatDatabase } from "./database.js";
import { jsonb, messageSearchText, toTurn, type ChatOwner } from "./records.js";
import { ProjectSetupError } from "./project-setup-state.js";

export interface SetupTranscriptMessage { role: "user" | "assistant"; text: string; id?: string; anchorMessageId?: string }
type Executor = Kysely<ChatDatabase> | Transaction<ChatDatabase>;

/** Internal server-generated transition messages use the existing canonical transcript. */
export async function appendProjectSetupTranscript(db: Executor, owner: ChatOwner, chatId: string, entries: SetupTranscriptMessage[],
  emit: (revision: number, content?: Pick<CanonicalChatContent, "messages" | "turns">) => Promise<void>): Promise<string | undefined> {
  if (entries.length > 3) throw new ProjectSetupError("invalid");
  const chat = await db.selectFrom("chats").selectAll().where("id", "=", chatId).where("owner_type", "=", owner.type).where("owner_id", "=", owner.ownerId).forUpdate().executeTakeFirst();
  if (!chat || chat.lifecycle !== "active" || chat.collaboration !== null) throw new ProjectSetupError("not_found");
  if (entries.length === 0) { await emit(Number(chat.revision)); return; }
  const active = await db.selectFrom("chat_runs").select("id").where("chat_id", "=", chatId).where("status", "in", ["accepted", "running", "waiting_for_approval", "waiting_for_input"]).executeTakeFirst();
  if (active) throw new ProjectSetupError("busy");
  const last = await db.selectFrom("chat_messages").select("seq").where("chat_id", "=", chatId).orderBy("seq", "desc").limit(1).executeTakeFirst();
  let sequence = Number(last?.seq ?? 0);
  const messages: CanonicalChatMessage[] = [];
  const turns: CanonicalChatTurn[] = [];
  const now = new Date().toISOString();
  const user = entries.find(entry => entry.role === "user");
  const anchorId = entries[0]?.anchorMessageId;
  const anchor = user || !anchorId ? undefined : await db.selectFrom("chat_messages as messages")
    .innerJoin("chat_turns as turns", "turns.id", "messages.turn_id")
    .leftJoin("chat_runs as runs", "runs.turn_id", "turns.id")
    .select("turns.id").where("messages.chat_id", "=", chatId).where("turns.chat_id", "=", chatId)
    .where("messages.id", "=", anchorId).where("runs.id", "is", null).executeTakeFirst();
  if (user ? entries[0] !== user : !anchor || entries.length !== 1) throw new ProjectSetupError("invalid");
  const turnId = anchor?.id ?? `cturn_${randomUUID().replaceAll("-", "")}`;
  const userId = user?.id ?? `msg_${randomUUID().replaceAll("-", "")}`;
  const baseSequence = sequence;
  for (const entry of entries) {
    const message = CanonicalChatMessageSchema.parse({ id: entry === user ? userId : entry.id ?? `msg_${randomUUID().replaceAll("-", "")}`, chatId,
      seq: ++sequence, role: entry.role, purpose: entry.role === "user" ? "discussion" : "assistant", state: "committed",
      turnId, ...(entry.role === "user" ? { actorId: owner.ownerId } : {}), parts: [{ type: "text", text: entry.text }], createdAt: now });
    await db.insertInto("chat_messages").values({ id: message.id, chat_id: chatId, seq: message.seq, role: message.role, purpose: message.purpose!, state: "committed",
      turn_id: entry === user ? null : turnId, run_id: null, actor_id: entry.role === "user" ? owner.ownerId : null, parts: jsonb(message.parts), byte_count: Buffer.byteLength(JSON.stringify(message)),
      search_text: messageSearchText(message), created_at: now }).execute();
    if (entry === user) {
      const row = await db.insertInto("chat_turns").values({ id: turnId, chat_id: chatId, client_request_id: `req_${turnId}`,
        base_message_seq: baseSequence, input_message_id: userId, status: "completed", created_at: now, updated_at: now }).returningAll().executeTakeFirstOrThrow();
      turns.push(toTurn(row));
      await db.updateTable("chat_messages").set({ turn_id: turnId }).where("id", "=", userId).where("chat_id", "=", chatId).execute();
    }
    messages.push(message);
  }
  const revision = Number(chat.revision) + 1;
  const updated = await db.updateTable("chats").set({ revision, message_count: sql<number>`message_count + ${entries.length}`, updated_at: now,
    activity_at: now, last_message_preview: entries.at(-1)!.text.slice(0, 280) }).where("id", "=", chatId).where("revision", "=", Number(chat.revision)).returning("id").executeTakeFirst();
  if (!updated) throw new ProjectSetupError("conflict");
  await emit(revision, { messages, turns });
  return messages.at(-1)?.id;
}
