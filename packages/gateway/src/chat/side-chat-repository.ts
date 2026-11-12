import { randomUUID } from "node:crypto";
import { Kysely } from "kysely";
import { z } from "zod/v4";
import { CanonicalChatIdSchema, CanonicalChatRequestIdSchema, CanonicalOwnerScopeSchema } from "@matrix-os/contracts";
import type { ChatDatabase } from "./database.js";
import type { ChatOwner } from "./records.js";
import { messageSearchText, toMessage } from "./records.js";
import { redactAssistantCredentials } from "./safe-activity-projection.js";

export const SideChatTextSchema = z.string().trim().min(1).max(8_000);
export type SideChatMessage = { seq: number; role: "user" | "assistant"; content: string; createdAt: string };
export type SideChatSnapshot = { threadId: string | null; messages: SideChatMessage[] };
export class SideChatNotFoundError extends Error { constructor() { super("Side chat not found"); this.name = "SideChatNotFoundError"; } }
export class SideChatBusyError extends Error { constructor() { super("Side chat is busy"); this.name = "SideChatBusyError"; } }

function asIso(value: string | Date): string { return new Date(value).toISOString(); }

/** Owner-scoped side transcript. It is separate from canonical Chat navigation and execution. */
export class SideChatRepository {
  constructor(private readonly db: Kysely<ChatDatabase>) {}

  private async ownedChat(ownerInput: ChatOwner, chatIdInput: string) {
    const owner = CanonicalOwnerScopeSchema.parse(ownerInput);
    const chatId = CanonicalChatIdSchema.parse(chatIdInput);
    const chat = await this.db.selectFrom("chats").select("id")
      .where("id", "=", chatId).where("owner_type", "=", owner.type).where("owner_id", "=", owner.ownerId)
      .executeTakeFirst();
    if (!chat) throw new SideChatNotFoundError();
    return { owner, chatId };
  }

  async create(ownerInput: ChatOwner, chatIdInput: string): Promise<SideChatSnapshot> {
    const { owner, chatId } = await this.ownedChat(ownerInput, chatIdInput);
    await this.db.insertInto("chat_side_threads").values({
      id: `side_${randomUUID().replaceAll("-", "")}`, chat_id: chatId,
      owner_type: owner.type, owner_id: owner.ownerId, active_request_id: null, busy_until: null,
      created_at: new Date(), updated_at: new Date(),
    }).onConflict(oc => oc.column("chat_id").doNothing()).execute();
    return this.read(owner, chatId);
  }

  async read(ownerInput: ChatOwner, chatIdInput: string): Promise<SideChatSnapshot> {
    const { owner, chatId } = await this.ownedChat(ownerInput, chatIdInput);
    const thread = await this.db.selectFrom("chat_side_threads").select("id")
      .where("chat_id", "=", chatId).where("owner_type", "=", owner.type).where("owner_id", "=", owner.ownerId)
      .executeTakeFirst();
    if (!thread) return { threadId: null, messages: [] };
    const rows = await this.db.selectFrom("chat_side_messages")
      .select(["seq", "role", "content", "created_at"])
      .where("thread_id", "=", thread.id).orderBy("seq", "desc").limit(200).execute();
    return { threadId: thread.id, messages: rows.reverse().map(row => ({
      seq: Number(row.seq), role: row.role, content: row.content, createdAt: asIso(row.created_at),
    })) };
  }

  async ask(ownerInput: ChatOwner, chatIdInput: string, requestInput: { clientRequestId: string; text: string },
    generate: (prompt: string, signal: AbortSignal) => Promise<{ text: string }>): Promise<SideChatSnapshot> {
    const { owner, chatId } = await this.ownedChat(ownerInput, chatIdInput);
    const request = { clientRequestId: CanonicalChatRequestIdSchema.parse(requestInput.clientRequestId), text: SideChatTextSchema.parse(requestInput.text) };
    const thread = await this.db.selectFrom("chat_side_threads").select("id")
      .where("chat_id", "=", chatId).where("owner_type", "=", owner.type).where("owner_id", "=", owner.ownerId)
      .executeTakeFirst();
    if (!thread) throw new SideChatNotFoundError();
    const prior = await this.db.selectFrom("chat_side_messages").select("seq")
      .where("thread_id", "=", thread.id).where("client_request_id", "=", request.clientRequestId)
      .where("role", "=", "assistant").executeTakeFirst();
    if (prior) return this.read(owner, chatId);
    const locked = await this.db.updateTable("chat_side_threads")
      .set({ active_request_id: request.clientRequestId, busy_until: new Date(Date.now() + 120_000), updated_at: new Date() })
      .where("id", "=", thread.id).where(eb => eb.or([eb("busy_until", "is", null), eb("busy_until", "<", new Date())]))
      .returning("id").executeTakeFirst();
    if (!locked) throw new SideChatBusyError();
    try {
      // Read the newest committed main messages immediately before generation.
      const mainRows = await this.db.selectFrom("chat_messages").selectAll().where("chat_id", "=", chatId)
        .where("state", "=", "committed").where("role", "in", ["user", "assistant"])
        .orderBy("seq", "desc").limit(50).execute();
      const sideRows = await this.db.selectFrom("chat_side_messages").select(["role", "content"])
        .where("thread_id", "=", thread.id).orderBy("seq", "desc").limit(40).execute();
      const main = mainRows.reverse().map(row => {
        const content = messageSearchText(toMessage(row)).slice(0, 2_000);
        return `${row.role}: ${row.role === "assistant" ? redactAssistantCredentials(content) : content}`;
      });
      const side = sideRows.reverse().map(row => `${row.role}: ${row.content.slice(0, 2_000)}`);
      const prompt = [
        "You are a read-only side chat. Answer the user's question using the supplied main chat and side chat context. Never claim to have edited files or sent messages to the main chat.",
        "Main chat (latest committed messages):", ...main,
        "Side chat:", ...side,
        `user: ${request.text}`,
      ].join("\n\n").slice(-64_000);
      const generated = await generate(prompt, AbortSignal.timeout(90_000));
      const answer = z.string().min(1).max(64_000).parse(generated.text);
      await this.db.transaction().execute(async trx => {
        const current = await trx.selectFrom("chat_side_threads").select("active_request_id")
          .where("id", "=", thread.id).forUpdate().executeTakeFirst();
        if (current?.active_request_id !== request.clientRequestId) throw new SideChatBusyError();
        const latest = await trx.selectFrom("chat_side_messages").select("seq")
          .where("thread_id", "=", thread.id).orderBy("seq", "desc").limit(1).executeTakeFirst();
        const seq = Number(latest?.seq ?? 0) + 1;
        await trx.insertInto("chat_side_messages").values([
          { thread_id: thread.id, seq, role: "user", content: request.text, client_request_id: request.clientRequestId, created_at: new Date() },
          { thread_id: thread.id, seq: seq + 1, role: "assistant", content: answer, client_request_id: request.clientRequestId, created_at: new Date() },
        ]).execute();
        await trx.updateTable("chat_side_threads").set({ active_request_id: null, busy_until: null, updated_at: new Date() })
          .where("id", "=", thread.id).execute();
      });
      return this.read(owner, chatId);
    } finally {
      // A failed provider call must not strand the side chat until lease expiry.
      await this.db.updateTable("chat_side_threads").set({ active_request_id: null, busy_until: null })
        .where("id", "=", thread.id).where("active_request_id", "=", request.clientRequestId).execute();
    }
  }
}
