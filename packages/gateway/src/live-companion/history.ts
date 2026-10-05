import { createHash } from "node:crypto";
import { sql } from "kysely";
import { z } from "zod/v4";
import { CanonicalChatIdSchema, CanonicalOwnerScopeSchema } from "@matrix-os/contracts";
import { ChatConflictError, ChatNotFoundError } from "../chat/errors.js";
import type { ChatRepository } from "../chat/repository.js";
import { jsonb, type ChatOwner } from "../chat/records.js";
import type { LiveCompanionPort } from "./coordinator.js";

const JournalSchema = z.object({ id: z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/), role: z.enum(["user", "assistant"]), text: z.string().trim().min(1).max(8000).refine(t => Buffer.byteLength(t) <= 32_000), heard: z.boolean().optional() }).strict();
/** Conversation turns use canonical Chat messages; no competing vocal memory.
 * Unverified assistant audio stays failed/readable in history and is excluded
 * from committed context. A later session never guesses what was heard.
 */
export function createLiveHistory(repository: ChatRepository, ownerInput: ChatOwner, chatIdInput: string) {
  const owner = CanonicalOwnerScopeSchema.parse(ownerInput);
  const chatId = CanonicalChatIdSchema.parse(chatIdInput);
  const access = async () => {
    const record = await repository.get(owner, chatId);
    if (!record || record.chat.collaboration) throw new ChatNotFoundError(chatId);
    return record;
  };
  return {
    async journal(raw: Parameters<LiveCompanionPort["journal"]>[0]) {
      const input = JournalSchema.parse(raw);
      const messageId = `msg_live_${createHash("sha256").update(`${owner.type}:${owner.ownerId}:${chatId}:${input.id}`).digest("hex")}`;
      await repository.withTransaction(async repo => {
        const db = repo.kysely;
        const chat = await db.selectFrom("chats").selectAll().where("id", "=", chatId)
          .where("owner_type", "=", owner.type).where("owner_id", "=", owner.ownerId)
          .where("collaboration", "is", null).forUpdate().executeTakeFirst();
        if (!chat) throw new ChatNotFoundError(chatId);
        const existing = await db.selectFrom("chat_messages").selectAll().where("id", "=", messageId).executeTakeFirst();
        const state = input.role === "assistant" && input.heard !== true ? "failed" : "committed";
        if (existing) {
          if (existing.chat_id !== chatId || existing.role !== input.role || existing.state !== state || existing.search_text !== input.text) throw new ChatConflictError(chatId, 0);
          return;
        }
        const max = await db.selectFrom("chat_messages").select(sql<number>`COALESCE(MAX(seq), 0)`.as("seq")).where("chat_id", "=", chatId).executeTakeFirstOrThrow();
        const now = new Date().toISOString();
        const parts = [{ type: "text", text: input.text }];
        const inserted = await db.insertInto("chat_messages").values({ id: messageId, chat_id: chatId, seq: Number(max.seq) + 1, role: input.role,
          purpose: input.role === "user" ? "discussion" : "assistant", state, turn_id: null, run_id: null,
          actor_id: input.role === "user" ? owner.ownerId : null, parts: jsonb(parts), byte_count: Buffer.byteLength(input.text), search_text: input.text, created_at: now,
        }).onConflict(oc => oc.column("id").doNothing()).returning("id").executeTakeFirst();
        if (!inserted) {
          const elected = await db.selectFrom("chat_messages").selectAll().where("id", "=", messageId).executeTakeFirstOrThrow();
          if (elected.chat_id !== chatId || elected.role !== input.role || elected.state !== state || elected.search_text !== input.text) throw new ChatConflictError(chatId, Number(chat.revision));
          return;
        }
        const updated = await db.updateTable("chats").set({ revision: Number(chat.revision) + 1, message_count: Number(chat.message_count) + 1, last_message_preview: input.text.slice(0, 280), activity_at: now, updated_at: now })
          .where("id", "=", chatId).where("revision", "=", chat.revision).returning("revision").executeTakeFirst();
        if (!updated) throw new ChatConflictError(chatId, 0);
        await repo.appendOutboxEvent(owner, chatId, Number(updated.revision), "chat.updated");
      });
      return { messageId };
    },
    async restore() {
      await access();
      const page = await repository.getDetailPage(owner, chatId, { limit: 20 });
      if (!page) throw new ChatNotFoundError(chatId);
      const messages = page.messages;
      let bytes = 0;
      return messages.filter(m => m.state === "committed" && (m.role === "user" || m.role === "assistant")).reverse().flatMap(m => {
        const text = m.parts.flatMap(p => p.type === "text" ? [p.text] : []).join("\n");
        const size = Buffer.byteLength(text);
        if (!text || bytes + size > 16_000) return [];
        bytes += size;
        return [{ role: m.role as "user" | "assistant", text }];
      }).reverse();
    },
    async search(query: string) {
      const binding = await access();
      const matches = await repository.search(owner, z.string().trim().min(1).max(160).parse(query), 5, binding.projectId);
      const sources = [];
      for (const match of matches) {
        const authorized = await repository.get(owner, match.chat.id);
        if (!authorized || authorized.chat.collaboration || authorized.projectId !== binding.projectId) continue;
        const page = await repository.getDetailPage(owner, match.chat.id, { limit: 5 });
        if (!page) continue;
        const messages = page.messages;
        const snippet = messages.filter(m => m.state === "committed").flatMap(m => m.parts.flatMap(p => p.type === "text" ? [p.text] : [])).join("\n").slice(0, 1600);
        sources.push({ chatId: match.chat.id, title: match.chat.title, snippet });
      }
      return sources;
    },
    async status() {
      const record = await access();
      return { state: record.activeRun?.status ?? "idle" };
    },
  };
}
