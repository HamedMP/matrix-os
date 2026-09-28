import { z } from "zod/v4";
import {
  BotAuthorityViewSchema, BotDirectChatResponseSchema, BotGrantIdSchema, BotInteractionIdSchema,
  BotInteractionSchema, BotMemoryItemIdSchema, BotMemoryMutationRequestSchema, BotMemoryMutationResponseSchema,
  BotTaskListResponseSchema, CanonicalChatIdSchema, ChatAgentIdSchema, ChatAgentListResponseSchema,
  ResolveBotInteractionRequestSchema, ResolveBotInteractionResponseSchema, RevokeBotGrantResponseSchema,
  type BotAuthorityView, type BotInteraction, type BotMemoryMutationRequest, type BotTaskSummary,
  type ResolveBotInteractionRequest, type ResolveBotInteractionResponse,
} from "@matrix-os/contracts";
import { buildGatewayRequestUrl, fetchAuthenticatedJson } from "./http";

export interface NativeBotChatSnapshot {
  agentId: string;
  name: string;
  interactions: BotInteraction[];
  tasks: BotTaskSummary[];
  authority: BotAuthorityView;
}

const interactionsSchema = z.object({ interactions: z.array(BotInteractionSchema).max(32) }).strict();
const STATUS_ERROR = "Bot status could not be loaded. Try again.";
const ACTION_ERROR = "Could not save your response. Try again.";
const ACCESS_ERROR = "Could not change bot access. Try again.";

function chatPath(chatId: string) {
  return `/api/chats/${encodeURIComponent(CanonicalChatIdSchema.parse(chatId))}`;
}

function agentPath(agentId: string) {
  return `/api/chat-agents/${encodeURIComponent(ChatAgentIdSchema.parse(agentId))}`;
}

export async function fetchNativeBotChat(token: string, gatewayUrl: string, chatId: string): Promise<NativeBotChatSnapshot | null> {
  const chat = chatPath(chatId);
  const direct = await fetchAuthenticatedJson({ url: buildGatewayRequestUrl(gatewayUrl, `${chat}/bot`),
    token, schema: BotDirectChatResponseSchema, errorMessage: STATUS_ERROR });
  if (!direct.agentId) return null;
  const agentId = direct.agentId;
  const [interactions, tasks, authority, library] = await Promise.allSettled([
    fetchAuthenticatedJson({ url: buildGatewayRequestUrl(gatewayUrl, `${chat}/interactions`),
      token, schema: interactionsSchema, errorMessage: STATUS_ERROR }),
    fetchAuthenticatedJson({ url: buildGatewayRequestUrl(gatewayUrl, `${chat}/bot-tasks`),
      token, schema: BotTaskListResponseSchema, errorMessage: STATUS_ERROR }),
    fetchAuthenticatedJson({ url: buildGatewayRequestUrl(gatewayUrl, `${agentPath(agentId)}/authority`),
      token, schema: BotAuthorityViewSchema, errorMessage: STATUS_ERROR }),
    fetchAuthenticatedJson({ url: buildGatewayRequestUrl(gatewayUrl, "/api/chat-agents"),
      token, schema: ChatAgentListResponseSchema, errorMessage: STATUS_ERROR }),
  ]);
  if (interactions.status === "rejected" || tasks.status === "rejected" || authority.status === "rejected") {
    throw new Error(STATUS_ERROR);
  }
  return {
    agentId,
    name: library.status === "fulfilled"
      ? library.value.agents.find((agent) => agent.id === agentId)?.name ?? "Your bot" : "Your bot",
    interactions: interactions.value.interactions,
    tasks: tasks.value.tasks,
    authority: authority.value,
  };
}

export function resolveNativeBotInteraction(token: string, gatewayUrl: string, chatId: string,
  interactionId: string, input: ResolveBotInteractionRequest): Promise<ResolveBotInteractionResponse> {
  const id = BotInteractionIdSchema.parse(interactionId);
  const body = ResolveBotInteractionRequestSchema.parse(input);
  return fetchAuthenticatedJson({
    url: buildGatewayRequestUrl(gatewayUrl, `${chatPath(chatId)}/interactions/${encodeURIComponent(id)}/resolve`),
    token, method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    schema: ResolveBotInteractionResponseSchema, errorMessage: ACTION_ERROR,
  });
}

export async function revokeNativeBotGrant(token: string, gatewayUrl: string, agentId: string, grantId: string): Promise<void> {
  const id = BotGrantIdSchema.parse(grantId);
  await fetchAuthenticatedJson({ url: buildGatewayRequestUrl(gatewayUrl, `${agentPath(agentId)}/grants/${encodeURIComponent(id)}`),
    token, method: "DELETE", schema: RevokeBotGrantResponseSchema, errorMessage: ACCESS_ERROR });
}

export async function mutateNativeBotMemory(token: string, gatewayUrl: string, agentId: string, itemId: string,
  action: "confirm" | "forget", input: BotMemoryMutationRequest): Promise<void> {
  const id = BotMemoryItemIdSchema.parse(itemId);
  const body = BotMemoryMutationRequestSchema.parse(input);
  await fetchAuthenticatedJson({ url: buildGatewayRequestUrl(gatewayUrl,
    `${agentPath(agentId)}/memory/${encodeURIComponent(id)}/${action}`),
  token, method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  schema: BotMemoryMutationResponseSchema, errorMessage: ACCESS_ERROR });
}
