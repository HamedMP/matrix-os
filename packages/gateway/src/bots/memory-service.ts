/**
 * Bot memory (spec 536, technical-design "Memory Model"). Provenance is
 * decided on the server, never by the bot. An item is confirmed only when:
 *
 * - the run was started by a message the owner typed in this chat (not an
 *   answer continuation, whose text the gateway assembled);
 * - the item is grounded in that message: it appears in it verbatim, or at
 *   least half of its significant words do;
 * - it names no outside source, and the run has not yet read outside
 *   content (an integration call or a file read).
 *
 * Anything else stays unconfirmed, is never searched or put in context, and
 * waits for the owner to confirm it. Admitted memory is capped at a 2K-token
 * budget, preferences first. The owner can forget or confirm an item at its
 * revision.
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
import { createBotCheckpointsRepository } from "./repositories/checkpoints.js";
import { createBotMemoryRepository, type BotMemoryRecord } from "./repositories/memory.js";
import { BotStateError } from "./repositories/shared.js";
import type { BotRuntimeBinding } from "./runtime-registry.js";
import { estimatePromptTokens } from "./system-prompt.js";

export const BOT_MEMORY_TOKEN_BUDGET = 2_000;
type BotMemoryMutationResponse = z.infer<typeof BotMemoryMutationResponseSchema>;
const KIND_ORDER = ["preference", "fact", "episode"] as const;
/** Tools whose results can carry someone else's words into the run. */
const OUTSIDE_CONTENT: readonly string[] = ["integration.call", "artifact.read"];
/** Answer continuations are admitted under this request prefix with gateway-built text. */
const CONTINUATION_REQUEST_PREFIX = "req_answer_";
const WORD = /[\p{L}\p{N}]+/gu;

function normalized(text: string): string {
  return text.toLocaleLowerCase().normalize("NFKC").replace(/\s+/g, " ").trim();
}

/** Auto-confirm only a complete owner statement, allowing a request preface and verb inflection. */
export function groundedIn(content: string, message: string): boolean {
  const statement = (words: string[]) => {
    if (words[0] === "i") return words.slice(1);
    if (words[0] === "the" && words[1] === "owner") return words.slice(2);
    return words[0] === "owner" ? words.slice(1) : words;
  };
  const prefaces = [
    ["please", "remember", "that"], ["remember", "that"], ["please", "remember"],
    ["can", "you", "remember", "that"], ["could", "you", "remember", "that"],
    ["please", "note", "that"],
  ];
  const proposed = statement(normalized(content).match(WORD) ?? []);
  if (proposed.length === 0) return false;
  const clauses = message.split(/[.!?;\n]+/u);
  let laterNegation = false;
  for (let index = clauses.length - 1; index >= 0; index -= 1) {
    const part = clauses[index]!;
    let said: string[] = normalized(part).match(WORD) ?? [];
    const preface = prefaces.find((words) => words.every((word, index) => said[index] === word));
    if (preface) said = said.slice(preface.length);
    said = statement(said);
    if (!laterNegation && proposed.length === said.length && proposed.every((word, index) => word === said[index]
      || (word.length >= 5 && word.endsWith("s") && word.slice(0, -1) === said[index]))) return true;
    laterNegation ||= /\b(?:not|never|no|don['’]?t)\b/iu.test(part);
  }
  return false;
}

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

  /**
   * The message that started this run, when the owner typed it in this chat.
   * An answer continuation is excluded: the gateway assembled its text,
   * including the bot's own question.
   */
  async function ownerMessage(tx: BotStateTransaction, binding: BotRuntimeBinding): Promise<{ id: string; text: string } | undefined> {
    const row = await tx.db.selectFrom("chat_runs as run")
      .innerJoin("chat_turns as turn", "turn.id", "run.turn_id")
      .innerJoin("chat_messages as message", "message.id", "turn.input_message_id")
      .select(["message.id", "message.search_text", "turn.client_request_id"])
      .where("run.id", "=", binding.runId).where("run.chat_id", "=", binding.chatId)
      .where("message.chat_id", "=", binding.chatId).where("message.role", "=", "user").where("message.state", "=", "committed")
      .where((eb) => eb.or([eb("message.actor_id", "is", null), eb("message.actor_id", "=", binding.ownerId)]))
      .executeTakeFirst();
    if (!row || row.client_request_id.startsWith(CONTINUATION_REQUEST_PREFIX)) return undefined;
    return { id: row.id, text: row.search_text };
  }

  /** True once the run has used a tool that can bring outside content into it. */
  async function readOutsideContent(tx: BotStateTransaction, binding: BotRuntimeBinding): Promise<boolean> {
    const used = await createBotCheckpointsRepository(tx.db).listForRun({ ownerId: binding.ownerId, runId: binding.runId }, tx.db);
    return used.some((checkpoint) => OUTSIDE_CONTENT.includes(String(checkpoint.action.capability)));
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
      if (binding.group) throw new BotBrokerActionError("denied");
      if (!scopesFor(binding.chatId).includes(args.scope)) throw new BotBrokerActionError("invalid_arguments");
      try {
        const item = await deps.transact(binding.ownerId, async (tx) => {
          // A message ID from the bot is ignored; the server names the source.
          const message = await ownerMessage(tx, binding);
          const confirmed = args.source.url === undefined && message !== undefined
            && groundedIn(args.content, message.text) && !await readOutsideContent(tx, binding);
          const source = {
            at: args.source.at,
            ...(args.source.url !== undefined ? { url: args.source.url } : {}),
            ...(message !== undefined ? { messageId: message.id } : {}),
          };
          const remembered = await createBotMemoryRepository(tx.db).remember({
            ownerId: binding.ownerId, botId: binding.botId, kind: args.kind, scope: args.scope,
            content: args.content, source, confirmed, now: now(),
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
      if (binding.group) throw new BotBrokerActionError("denied");
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
      const items = await deps.transact(input.ownerId, async (tx) => {
        const bindings = await createBotBindingsRepository(tx.db).forChat({ ownerId: input.ownerId, chatId: input.chatId }, tx.db);
        if (bindings.length !== 1 || bindings[0]!.kind !== "direct" || bindings[0]!.botId !== input.botId) return [];
        return createBotMemoryRepository(tx.db).listAdmissible({
          ownerId: input.ownerId, botId: input.botId, scopes: scopesFor(input.chatId), now: now(),
        }, tx.db);
      });
      return admitMemory(items);
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
