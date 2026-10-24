import {
  BotChatBindingResponseSchema,
  CanonicalChatIdSchema,
  ChatAgentIdSchema,
  GetStartedSavedBotsResponseSchema,
  type GetStartedRecipeBotId,
  type GettingStartedBotStatuses,
} from "@matrix-os/contracts";
import { useEffect, useState } from "react";
import { z } from "zod/v4";

/** A JSON request to the owner's gateway; the host adds auth and a timeout. */
export type GettingStartedRequest = (path: string, method: "GET" | "POST", body?: unknown) => Promise<unknown>;

export interface GettingStartedBots {
  statuses: GettingStartedBotStatuses;
  agentIds: Partial<Record<GetStartedRecipeBotId, string>>;
}

// Only the fields this check reads; the list route validates the full records.
const BotListSchema = z.looseObject({
  enabled: z.boolean(),
  agents: z.array(z.looseObject({ id: ChatAgentIdSchema, archived: z.boolean() })).max(100),
});
const ChatActivitySchema = z.looseObject({ record: z.looseObject({ chat: z.looseObject({ messageCount: z.number().int().min(0) }) }) });

const EMPTY: GettingStartedBots = { statuses: {}, agentIds: {} };

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

const agentPath = (agentId: string) => `/api/chat-agents/${encodeURIComponent(ChatAgentIdSchema.parse(agentId))}/direct-chat`;

/**
 * Spec 635: whether the owner has chatted with each bot they added in Get started. Each row is the
 * bot its Get started request made, never another copy of the same recipe. A bot they removed drops
 * out (null); one whose creation never finished reads as "missing", so it can be created again,
 * even when part of it exists; a failed check reads as unavailable, never as done.
 */
export async function loadGettingStartedBots(request: GettingStartedRequest, recipeIds: readonly GetStartedRecipeBotId[]): Promise<GettingStartedBots> {
  if (recipeIds.length === 0) return EMPTY;
  let list: z.infer<typeof BotListSchema>;
  let saved: z.infer<typeof GetStartedSavedBotsResponseSchema>["bots"];
  try {
    [list, saved] = await Promise.all([
      request("/api/chat-agents", "GET").then((body) => BotListSchema.parse(body)),
      request("/api/settings/get-started/bots", "GET").then((body) => GetStartedSavedBotsResponseSchema.parse(body).bots),
    ]);
  } catch (error: unknown) {
    console.warn("[getting-started] bot status unavailable:", errorName(error));
    return { statuses: Object.fromEntries(recipeIds.map((id) => [id, "unavailable"])), agentIds: {} };
  }
  const present = new Set(list.enabled ? list.agents.filter((agent) => !agent.archived).map((agent) => agent.id) : []);
  const result: GettingStartedBots = { statuses: {}, agentIds: {} };
  await Promise.all(recipeIds.map(async (recipeId) => {
    const bot = saved[recipeId];
    if (!list.enabled || !bot) {
      result.statuses[recipeId] = null;
      return;
    }
    if (bot.status === "pending") {
      result.statuses[recipeId] = "missing";
      return;
    }
    if (!present.has(bot.agentId)) {
      result.statuses[recipeId] = null;
      return;
    }
    result.agentIds[recipeId] = bot.agentId;
    try {
      const { chatId } = BotChatBindingResponseSchema.parse(await request(agentPath(bot.agentId), "GET"));
      if (!chatId) {
        result.statuses[recipeId] = "incomplete";
        return;
      }
      const chat = ChatActivitySchema.parse(await request(`/api/chats/${encodeURIComponent(CanonicalChatIdSchema.parse(chatId))}?limit=1`, "GET"));
      result.statuses[recipeId] = chat.record.chat.messageCount > 0 ? "complete" : "incomplete";
    } catch (error: unknown) {
      console.warn("[getting-started] bot chat status unavailable:", errorName(error));
      result.statuses[recipeId] = "unavailable";
    }
  }));
  return result;
}

const RetryBotsResponseSchema = z.object({ bots: z.record(z.string().max(128), z.enum(["ready", "failed"])) });

/**
 * Spec 635: creates the owner's saved bot choices again (idempotent on the gateway), then calls
 * `done` either way so the rows reload with the result. Shared by every Getting started surface.
 */
export function retryGettingStartedBots(request: GettingStartedRequest, done: () => void): void {
  void request("/api/settings/get-started/bots", "POST", {})
    .then((body) => { RetryBotsResponseSchema.parse(body); })
    .catch((error: unknown) => { console.warn("[getting-started] unable to create bots:", errorName(error)); })
    .finally(done);
}

/** The bot's own chat, created on first use; null when the gateway has none to give. */
export async function openGettingStartedBotChat(request: GettingStartedRequest, agentId: string): Promise<string | null> {
  return BotChatBindingResponseSchema.parse(await request(agentPath(agentId), "POST", {})).chatId;
}

/** Loads the bots' chat status whenever the list of bots or `refreshKey` changes. */
export function useGettingStartedBots(
  request: GettingStartedRequest | null,
  recipeIds: readonly GetStartedRecipeBotId[] | undefined,
  refreshKey: unknown,
): GettingStartedBots {
  const [bots, setBots] = useState<GettingStartedBots>(EMPTY);
  const idsKey = (recipeIds ?? []).join(",");
  useEffect(() => {
    const ids = idsKey ? (idsKey.split(",") as GetStartedRecipeBotId[]) : [];
    if (!request || ids.length === 0) return;
    let current = true;
    void loadGettingStartedBots(request, ids).then((next) => {
      if (current) setBots(next);
    });
    return () => {
      current = false;
    };
  }, [request, idsKey, refreshKey]);
  return bots;
}
