/**
 * Bot memory (spec 536, technical-design "Memory Model"). A bot proposes an
 * item; it is confirmed only when its source is the owner's own committed
 * message in this chat, checked on the server. Anything sourced from a web
 * page, an email, or a tool stays unconfirmed, is never searched or put in
 * context, and waits for the owner to confirm it. Admitted memory is capped
 * at a 2K-token budget, preferences first. The owner can forget or confirm
 * an item at its revision.
 */
import {
  BotMemoryItemIdSchema,
  BotMemoryMutationRequestSchema,
  BotMemoryMutationResponseSchema,
  ChatAgentIdSchema,
  type BotToolRequest,
  type BotToolResult,
} from "@matrix-os/contracts";
import type { z } from "zod/v4";
import { BotBrokerActionError } from "./broker-actions.js";
import type { BotStateTransaction, BotStateTransactions } from "./events.js";
import { createBotBindingsRepository } from "./repositories/bindings.js";
import { createBotMemoryRepository, type BotMemoryRecord } from "./repositories/memory.js";
import { BotStateError } from "./repositories/shared.js";
import type { BotRuntimeBinding } from "./runtime-registry.js";
import { estimatePromptTokens } from "./system-prompt.js";

export const BOT_MEMORY_TOKEN_BUDGET = 2_000;
type BotMemoryMutationResponse = z.infer<typeof BotMemoryMutationResponseSchema>;
const KIND_ORDER = ["preference", "fact", "episode"] as const;

export type BotMemoryErrorCode = "invalid_request" | "not_found" | "conflict";

export class BotMemoryError extends Error {
  constructor(readonly code: BotMemoryErrorCode) {
    super(`Bot memory refused: ${code}`);
    this.name = "BotMemoryError";
  }
}

type ProposeArgs = Extract<BotToolRequest, { capability: "memory.propose" }>["args"];
type SearchArgs = Extract<BotToolRequest, { capability: "memory.search" }>["args"];

function scopesFor(chatId: string): string[] {
  return ["bot", `chat:${chatId}`];
}

/** Keeps the highest-priority items that fit the budget: preferences, then facts, then episodes, newest first. */
export function admitMemory(items: readonly Pick<BotMemoryRecord, "kind" | "content" | "confirmed" | "updatedAt">[], budget = BOT_MEMORY_TOKEN_BUDGET): string[] {
  const ordered = items.filter((item) => item.confirmed)
    .toSorted((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || b.updatedAt.localeCompare(a.updatedAt));
  const admitted: string[] = [];
  let used = 0;
  for (const item of ordered) {
    const line = `(${item.kind}) ${item.content}`;
    const cost = estimatePromptTokens(line) + 1;
    if (used + cost > budget) continue;
    admitted.push(line);
    used += cost;
  }
  return admitted;
}

export function createBotMemoryService(deps: { transact: BotStateTransactions; now?: () => Date }) {
  const now = () => (deps.now?.() ?? new Date()).toISOString();

  /** True only for the owner's own committed message in this chat. */
  async function ownerMessage(tx: BotStateTransaction, binding: BotRuntimeBinding, messageId: string): Promise<boolean> {
    const row = await tx.db.selectFrom("chat_messages").select("id")
      .where("id", "=", messageId).where("chat_id", "=", binding.chatId)
      .where("role", "=", "user").where("state", "=", "committed")
      .where((eb) => eb.or([eb("actor_id", "is", null), eb("actor_id", "=", binding.ownerId)]))
      .executeTakeFirst();
    return row !== undefined;
  }

  /** Locks nothing; finds the owner's item and checks it belongs to the bot. */
  async function ownedItem(tx: BotStateTransaction, ownerId: string, botId: string, itemId: string) {
    const row = await tx.db.selectFrom("bot_memory_items").select(["bot_id", "revision"])
      .where("owner_id", "=", ownerId).where("item_id", "=", itemId).where("forgotten_at", "is", null)
      .executeTakeFirst();
    if (!row || row.bot_id !== botId) throw new BotMemoryError("not_found");
    return row;
  }

  async function announceAuthority(tx: BotStateTransaction, ownerId: string, botId: string, revision: number): Promise<void> {
    const chatId = await createBotBindingsRepository(tx.db).directChatId({ ownerId, botId }, tx.db);
    if (chatId) await tx.publish(chatId, "bot.authority.changed", { agentId: botId, revision });
  }

  function parseMutation(agentIdValue: string, itemIdValue: string, body: unknown) {
    const agentId = ChatAgentIdSchema.safeParse(agentIdValue);
    const itemId = BotMemoryItemIdSchema.safeParse(itemIdValue);
    const request = BotMemoryMutationRequestSchema.safeParse(body);
    if (!agentId.success || !itemId.success || !request.success) throw new BotMemoryError("invalid_request");
    return { agentId: agentId.data, itemId: itemId.data, baseRevision: request.data.baseRevision };
  }

  return {
    /** `memory.propose` from a bot run. */
    async propose(binding: BotRuntimeBinding, args: ProposeArgs): Promise<BotToolResult> {
      if (!scopesFor(binding.chatId).includes(args.scope)) throw new BotBrokerActionError("invalid_arguments");
      try {
        const item = await deps.transact(binding.ownerId, async (tx) => {
          const confirmed = args.source.url === undefined && args.source.messageId !== undefined
            && await ownerMessage(tx, binding, args.source.messageId);
          const remembered = await createBotMemoryRepository(tx.db).remember({
            ownerId: binding.ownerId, botId: binding.botId, kind: args.kind, scope: args.scope,
            content: args.content, source: args.source, confirmed, now: now(),
          }, tx.db);
          await tx.publish(binding.chatId, "bot.memory.remembered", {
            agentId: binding.botId, chatId: binding.chatId, itemId: remembered.itemId, kind: remembered.kind, confirmed: remembered.confirmed,
          });
          return remembered;
        });
        return {
          ok: true,
          content: [{
            type: "text",
            text: item.confirmed
              ? "Remembered."
              : "Saved for the owner to confirm. It will not be used until they do.",
          }],
        };
      } catch (error: unknown) {
        if (error instanceof BotStateError) {
          if (error.code === "capacity_exceeded") throw new BotBrokerActionError("budget_exhausted");
          if (error.code === "too_large" || error.code === "invalid_input") throw new BotBrokerActionError("invalid_arguments");
        }
        throw error;
      }
    },

    /** `memory.search` from a bot run: confirmed items in this bot's and this chat's scope only. */
    async search(binding: BotRuntimeBinding, args: SearchArgs): Promise<BotToolResult> {
      const items = await deps.transact(binding.ownerId, (tx) => createBotMemoryRepository(tx.db).search({
        ownerId: binding.ownerId, botId: binding.botId, query: args.query, scopes: scopesFor(binding.chatId), limit: args.limit, now: now(),
      }, tx.db));
      const text = items.length === 0
        ? "Nothing you remember matches."
        : items.map((item) => `- (${item.kind}) ${item.content}`).join("\n");
      return { ok: true, content: [{ type: "text", text }] };
    },

    /** Confirmed memory for a run's system prompt, within the token budget. */
    async admitted(input: { ownerId: string; botId: string; chatId: string }): Promise<string[]> {
      const items = await deps.transact(input.ownerId, (tx) =>
        createBotMemoryRepository(tx.db).list({ ownerId: input.ownerId, botId: input.botId, now: now() }, tx.db));
      return admitMemory(items.filter((item) => scopesFor(input.chatId).includes(item.scope)));
    },

    async forget(ownerId: string, agentIdValue: string, itemIdValue: string, body: unknown): Promise<BotMemoryMutationResponse> {
      const { agentId, itemId, baseRevision } = parseMutation(agentIdValue, itemIdValue, body);
      return deps.transact(ownerId, async (tx) => {
        await ownedItem(tx, ownerId, agentId, itemId);
        const forgotten = await createBotMemoryRepository(tx.db).forget({ ownerId, itemId, baseRevision, now: now() }, tx.db);
        if (!forgotten) throw new BotMemoryError("conflict");
        await announceAuthority(tx, ownerId, agentId, baseRevision + 1);
        return BotMemoryMutationResponseSchema.parse({ itemId, revision: baseRevision + 1 });
      });
    },

    async confirm(ownerId: string, agentIdValue: string, itemIdValue: string, body: unknown): Promise<BotMemoryMutationResponse> {
      const { agentId, itemId, baseRevision } = parseMutation(agentIdValue, itemIdValue, body);
      return deps.transact(ownerId, async (tx) => {
        await ownedItem(tx, ownerId, agentId, itemId);
        let confirmed: BotMemoryRecord;
        try {
          confirmed = await createBotMemoryRepository(tx.db).confirm({ ownerId, itemId, baseRevision, now: now() }, tx.db);
        } catch (error: unknown) {
          if (error instanceof BotStateError && error.code === "revision_conflict") throw new BotMemoryError("conflict");
          throw error;
        }
        await announceAuthority(tx, ownerId, agentId, confirmed.revision);
        return BotMemoryMutationResponseSchema.parse({ itemId, revision: confirmed.revision });
      });
    },
  };
}

export type BotMemoryService = ReturnType<typeof createBotMemoryService>;
