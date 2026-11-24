import { createHash } from "node:crypto";
import type { ChatRunContext } from "@matrix-os/contracts";
import { ChatAgentContextError } from "./agent-context.js";
import { transcript } from "./context-transcript.js";
import { hasAudienceRestrictedChatMaterial } from "./drive-sharing-guard.js";
import { privateBotSourceChat } from "./private-routine-authority.js";
import { toMessage, type ChatOwner } from "./records.js";
import type { ChatRepository } from "./repository.js";

export type SelectedBotChats = NonNullable<ChatRunContext["botChatSources"]>;
const unavailable = () => new ChatAgentContextError("context_unavailable");

/** Keep only evidence of the owner's selection in the admitted Run. Resolve raw text at inference. */
export function createBotSelectedChatReader(repository: Pick<ChatRepository, "kysely">) {
  const db = repository.kysely;
  async function assertPrivate(owner: ChatOwner, chatId: string) {
    const current = await privateBotSourceChat(db, owner, chatId);
    if (!current) throw unavailable();
    return current.title;
  }
  async function snapshot(owner: ChatOwner, destination: string, chatId: string, throughSeq?: number) {
    if (chatId === destination) throw unavailable();
    const title = await assertPrivate(owner, chatId);
    if (await hasAudienceRestrictedChatMaterial(db, chatId)) throw unavailable();
    let query = db.selectFrom("chat_messages").selectAll().where("chat_id", "=", chatId);
    if (throughSeq !== undefined) query = query.where("seq", "<=", throughSeq);
    const rows = await query.orderBy("seq", "desc").limit(41).execute();
    const messages = rows.slice(0, 40).reverse().map(toMessage);
    const content = transcript(messages, 2048);
    const reference = { chatId, title, ...content, truncated: content.truncated || rows.length > 40 };
    const digest = createHash("sha256").update(JSON.stringify(reference)).digest("hex");
    return { reference, marker: { chatId, throughSeq: messages.at(-1)?.seq ?? 0, digest } };
  }
  return {
    async prepare(owner: ChatOwner, destination: string, botId: string, sourceIds: string[]): Promise<SelectedBotChats> {
      if (!sourceIds.length || sourceIds.length > 3 || new Set(sourceIds).size !== sourceIds.length) throw unavailable();
      await assertPrivate(owner, destination);
      const snapshots = await Promise.all(sourceIds.map(id => snapshot(owner, destination, id)));
      if (Buffer.byteLength(JSON.stringify(snapshots.map(item => item.reference))) > 16 * 1024) throw unavailable();
      return { botId, sources: snapshots.map(item => item.marker) };
    },
    async read(owner: ChatOwner, destination: string, selection: SelectedBotChats): Promise<string> {
      await assertPrivate(owner, destination);
      const selected = await Promise.all(selection.sources.map(async source => {
        const { marker, reference } = await snapshot(owner, destination, source.chatId, source.throughSeq);
        if (marker.digest !== source.digest || marker.throughSeq !== source.throughSeq) throw unavailable();
        return reference;
      }));
      return JSON.stringify(selected);
    },
  };
}
export type BotSelectedChatReader = ReturnType<typeof createBotSelectedChatReader>;
