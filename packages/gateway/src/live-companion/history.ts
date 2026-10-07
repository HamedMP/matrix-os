import { openingVoiceTitle, finishVoiceTitle } from "./voice-title.js";
import { createHash } from "node:crypto";
import { sql } from "kysely";
import { z } from "zod/v4";
import { CanonicalChatIdSchema, CanonicalOwnerScopeSchema, CanonicalChatMessageSchema } from "@matrix-os/contracts";
import { ChatConflictError, ChatNotFoundError } from "../chat/errors.js";
import type { ChatRepository } from "../chat/repository.js";
import { jsonb, parseJson, type ChatOwner } from "../chat/records.js";
import type { LiveCompanionPort } from "./coordinator.js";

const JournalSchema = z.object({ id: z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/), role: z.enum(["user", "assistant"]), text: z.string().trim().min(1).max(8000).refine(t => Buffer.byteLength(t) <= 32_000), heard: z.boolean().optional(), playedThroughMs: z.number().positive().max(1_800_000).optional() }).strict();
const PLAYBACK_LABEL = "Aoede confirmed playback";
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
    finish: () => finishVoiceTitle(repository, owner, chatId),
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
        const note = state === "failed" && input.role === "assistant" && input.playedThroughMs !== undefined
          ? { type: "status" as const, tone: "warning" as const, label: PLAYBACK_LABEL, detail: `[Aoede playback note: interrupted after ${Math.round(input.playedThroughMs)} ms of confirmed playback. Exact heard words are unavailable; do not assume the generated transcript was heard.]` } : null;
        const parts = [{ type: "text", text: input.text }, ...(note ? [note] : [])];
        const same = (row: typeof existing) => {
          if (!row || row.chat_id !== chatId || row.role !== input.role || row.state !== state || row.search_text !== input.text) return false;
          const recorded = CanonicalChatMessageSchema.shape.parts.parse(parseJson(row.parts))
            .find(part => part.type === "status" && part.label === PLAYBACK_LABEL);
          return (recorded?.type === "status" ? recorded.detail : undefined) === note?.detail;
        };
        if (existing) {
          if (!same(existing)) throw new ChatConflictError(chatId, 0);
          return;
        }
        const max = await db.selectFrom("chat_messages").select(sql<number>`COALESCE(MAX(seq), 0)`.as("seq")).where("chat_id", "=", chatId).executeTakeFirstOrThrow();
        const now = new Date().toISOString();
        const inserted = await db.insertInto("chat_messages").values({ id: messageId, chat_id: chatId, seq: Number(max.seq) + 1, role: input.role,
          purpose: input.role === "user" ? "discussion" : "assistant", state, turn_id: null, run_id: null,
          actor_id: input.role === "user" ? owner.ownerId : null, parts: jsonb(parts), byte_count: Buffer.byteLength(input.text), search_text: input.text, created_at: now,
        }).onConflict(oc => oc.column("id").doNothing()).returning("id").executeTakeFirst();
        if (!inserted) {
          const elected = await db.selectFrom("chat_messages").selectAll().where("id", "=", messageId).executeTakeFirstOrThrow();
          if (!same(elected)) throw new ChatConflictError(chatId, Number(chat.revision));
          return;
        }
        // The first exchange is complete or the opening 2–3 messages reveal a
        // topic. Rename under the same row lock/CAS as the transcript, once only;
        // manual owner titles and ordinary Chat are never touched.
        let title: string | null = null;
        if (Number(chat.message_count) >= 1 || input.role === "assistant") title = await openingVoiceTitle(db, chat);
        const updated = await db.updateTable("chats").set({ revision: Number(chat.revision) + 1, message_count: Number(chat.message_count) + 1, last_message_preview: input.text.slice(0, 280), activity_at: now, updated_at: now,
          ...(title ? { title, title_version: Number(chat.title_version) + 1 } : {}),
        })
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
      return messages.filter(m => m.role === "user" || m.role === "assistant").reverse().flatMap(m => {
        const text = m.state === "committed" ? m.parts.flatMap(p => p.type === "text" ? [p.text] : []).join("\n")
          : m.state === "failed" && m.role === "assistant" && m.id.startsWith("msg_live_")
            ? m.parts.flatMap(p => p.type === "status" && p.label === PLAYBACK_LABEL && p.detail ? [p.detail] : []).join("\n") : "";
        const size = Buffer.byteLength(text);
        if (!text || bytes + size > 16_000) return [];
        bytes += size;
        return [{ role: m.role as "user" | "assistant", text }];
      }).reverse();
    },
    async search(query: string) {
      const binding = await access();
      const text = z.string().trim().min(1).max(160).parse(query);
      const matches = await repository.search(owner, text, 5, binding.projectId);
      const sources = [];
      for (const match of matches) {
        const authorized = await repository.get(owner, match.chat.id);
        if (!authorized || authorized.chat.collaboration || authorized.projectId !== binding.projectId) continue;
        // Reapply ownership/project/private-chat authorization in the query
        // that reads the matching passage, including concurrent access changes.
        let passage = repository.kysely.selectFrom("chat_messages")
          .innerJoin("chats", "chats.id", "chat_messages.chat_id")
          .select(sql<string>`ts_headline('simple', chat_messages.search_text, plainto_tsquery('simple', ${text}), 'StartSel="", StopSel="", MaxWords=200, MinWords=40')`.as("excerpt"))
          .where("chats.id", "=", match.chat.id).where("chats.owner_type", "=", owner.type).where("chats.owner_id", "=", owner.ownerId)
          .where("chats.collaboration", "is", null).where("chat_messages.state", "=", "committed")
          .where(sql<boolean>`to_tsvector('simple', chat_messages.search_text) @@ plainto_tsquery('simple', ${text})`);
        passage = binding.projectId == null ? passage.where("chats.project_id", "is", null) : passage.where("chats.project_id", "=", binding.projectId);
        const found = await passage.orderBy("chat_messages.seq", "desc").limit(1).executeTakeFirst();
        if (!found) continue;
        const snippet = found.excerpt.slice(0, 1600);
        sources.push({ chatId: match.chat.id, title: match.chat.title, snippet });
      }
      return sources;
    },
  };
}
