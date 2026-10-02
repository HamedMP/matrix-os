import { z } from "zod/v4";
import { BotChatBindingResponseSchema, BotDirectChatResponseSchema, BotInteractionSchema, CanonicalChatIdSchema, ChatAgentListResponseSchema } from "@matrix-os/contracts";
import { buildGatewayRequestUrl, fetchAuthenticatedJson } from "./http";

export interface NativeBotConversationSummary {
  chatId: string;
  agentId: string;
  name: string;
  pendingApprovalCount: number;
}

export interface NativeBotNavigation {
  ordinaryChatIds: string[];
  bots: NativeBotConversationSummary[];
  unresolvedChatIds: string[];
  unavailable: boolean;
}

const interactionsSchema = z.object({ interactions: z.array(BotInteractionSchema).max(32) }).strict();
const STATUS_ERROR = "Bot status could not be loaded. Try again.";
const CONCURRENCY = 4;
const MAX_RECORDS = 1000;

async function bounded<T>(values: readonly T[], signal: AbortSignal | undefined, work: (value: T) => Promise<void>) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, values.length) }, async () => {
    while (cursor < values.length && !signal?.aborted) await work(values[cursor++]);
  }));
}

/** Current recipe Bot entries survive the recent-chat window; loaded legacy bindings remain discoverable. */
export async function fetchNativeBotNavigation(token: string, gatewayUrl: string, recordIds: readonly string[], signal?: AbortSignal): Promise<NativeBotNavigation> {
  const result: NativeBotNavigation = { ordinaryChatIds: [], bots: [], unresolvedChatIds: [], unavailable: false };
  if (signal?.aborted) return result;
  const allIds = [...new Set(recordIds)];
  const ids = allIds.slice(0, MAX_RECORDS);
  result.unresolvedChatIds = allIds.slice(MAX_RECORDS);
  result.unavailable = result.unresolvedChatIds.length > 0;
  const library = await fetchAuthenticatedJson({
    url: buildGatewayRequestUrl(gatewayUrl, "/api/chat-agents"), token,
    schema: ChatAgentListResponseSchema, errorMessage: STATUS_ERROR,
  }).catch((failure: unknown) => {
    console.warn("[mobile-bot-navigation] names unavailable", failure instanceof Error ? failure.name : "UnknownError");
    result.unavailable = true;
    return { enabled: false, agents: [] };
  });
  const bindings = new Map<string, NativeBotConversationSummary>();
  await bounded(library.agents.filter(agent => agent.recipeRef), signal, async agent => {
    try {
      const binding = await fetchAuthenticatedJson({
        url: buildGatewayRequestUrl(gatewayUrl, `/api/chat-agents/${encodeURIComponent(agent.id)}/direct-chat`), token,
        schema: BotChatBindingResponseSchema, errorMessage: STATUS_ERROR,
      });
      if (!signal?.aborted && binding.chatId) bindings.set(binding.chatId, {
        chatId: binding.chatId, agentId: agent.id, name: agent.name, pendingApprovalCount: 0,
      });
    } catch (failure: unknown) {
      console.warn("[mobile-bot-navigation] direct chat unavailable", failure instanceof Error ? failure.name : "UnknownError");
      result.unavailable = true;
    }
  });
  await bounded(ids.filter(id => !bindings.has(id)), signal, async chatId => {
    let agentId: string | null;
    try {
      const chatPath = `/api/chats/${encodeURIComponent(CanonicalChatIdSchema.parse(chatId))}`;
      const binding = await fetchAuthenticatedJson({
        url: buildGatewayRequestUrl(gatewayUrl, `${chatPath}/bot`), token,
        schema: BotDirectChatResponseSchema, errorMessage: STATUS_ERROR,
      });
      agentId = binding.agentId;
    } catch (failure: unknown) {
      console.warn("[mobile-bot-navigation] binding unavailable", failure instanceof Error ? failure.name : "UnknownError");
      result.unresolvedChatIds.push(chatId);
      result.unavailable = true;
      return;
    }
    if (signal?.aborted) return;
    if (!agentId) {
      result.ordinaryChatIds.push(chatId);
      return;
    }
    bindings.set(chatId, {
      chatId, agentId, name: library.agents.find(agent => agent.id === agentId)?.name ?? "Your bot", pendingApprovalCount: 0,
    });
  });
  // At most 100 current recipe bindings plus MAX_RECORDS loaded legacy histories.
  result.bots = [...bindings.values()];
  await bounded(result.bots, signal, async summary => {
    try {
      const response = await fetchAuthenticatedJson({
        url: buildGatewayRequestUrl(gatewayUrl, `/api/chats/${encodeURIComponent(summary.chatId)}/interactions`), token,
        schema: interactionsSchema, errorMessage: STATUS_ERROR,
      });
      if (!signal?.aborted) summary.pendingApprovalCount = response.interactions.filter(item => item.kind === "approval" && item.status === "pending" && Date.parse(item.expiresAt) > Date.now()).length;
    } catch (failure: unknown) {
      console.warn("[mobile-bot-navigation] attention unavailable", failure instanceof Error ? failure.name : "UnknownError");
      result.unavailable = true;
    }
  });
  return result;
}
