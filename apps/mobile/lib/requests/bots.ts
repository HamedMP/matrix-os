import { z } from "zod/v4";
import {
  ChatAgentSchema, UpdateChatAgentRequestSchema, BotAuthorityViewSchema, BotDirectChatResponseSchema, BotGrantIdSchema, BotInteractionIdSchema,
  BotInteractionSchema, BotMemoryItemIdSchema, BotMemoryMutationRequestSchema, BotMemoryMutationResponseSchema,
  BotRecipeListResponseSchema, BotTaskListResponseSchema, CanonicalChatIdSchema, ChatAgentIdSchema, ChatAgentListResponseSchema,
  InstantiateBotRequestSchema, InstantiateBotResponseSchema,
  ResolveBotInteractionRequestSchema, ResolveBotInteractionResponseSchema, RevokeBotGrantResponseSchema,
  type CanonicalChatModelSelection, type BotAuthorityView, type BotInteraction, type BotMemoryMutationRequest, type BotRecipeSummary, type BotTaskSummary,
  type InstantiateBotRequest, type InstantiateBotResponse,
  type ResolveBotInteractionRequest, type ResolveBotInteractionResponse,
} from "@matrix-os/contracts";
import { buildGatewayRequestUrl, fetchAuthenticatedJson } from "./http";

export interface NativeBotChatSnapshot {
  kind?: "recipe" | "custom";
  instructions?: string;
  recipeRef?: import("@matrix-os/contracts").BotRecipeRef;
  agentId: string;
  name: string;
  selection?: CanonicalChatModelSelection;
  revision?: number;
  interactions: BotInteraction[];
  tasks: BotTaskSummary[];
  authority: BotAuthorityView | null;
}

const interactionsSchema = z.object({ interactions: z.array(BotInteractionSchema).max(32) }).strict();
const STATUS_ERROR = "Bot status could not be loaded. Try again.";
const ACTION_ERROR = "Could not save your response. Try again.";
const ACCESS_ERROR = "Could not change bot access. Try again.";
const CREATE_ERROR = "Bot could not be created. Try again.";

function chatPath(chatId: string) {
  return `/api/chats/${encodeURIComponent(CanonicalChatIdSchema.parse(chatId))}`;
}

function agentPath(agentId: string) {
  return `/api/chat-agents/${encodeURIComponent(ChatAgentIdSchema.parse(agentId))}`;
}

export async function fetchNativeBotRecipes(token: string, gatewayUrl: string): Promise<BotRecipeSummary[]> {
  const result = await fetchAuthenticatedJson({
    url: buildGatewayRequestUrl(gatewayUrl, "/api/chat-agents/bot-recipes"), token,
    schema: BotRecipeListResponseSchema, errorMessage: STATUS_ERROR,
  });
  return result.recipes;
}

export function instantiateNativeBot(token: string, gatewayUrl: string,
  input: InstantiateBotRequest): Promise<InstantiateBotResponse> {
  return fetchAuthenticatedJson({
    url: buildGatewayRequestUrl(gatewayUrl, "/api/chat-agents/instantiate"), token,
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(InstantiateBotRequestSchema.parse(input)),
    schema: InstantiateBotResponseSchema, errorMessage: CREATE_ERROR,
  });
}

export async function fetchNativeBotChat(token: string, gatewayUrl: string, chatId: string): Promise<NativeBotChatSnapshot | null> {
  const chat = chatPath(chatId);
  const direct = await fetchAuthenticatedJson({ url: buildGatewayRequestUrl(gatewayUrl, `${chat}/bot`),
    token, schema: BotDirectChatResponseSchema, errorMessage: STATUS_ERROR });
  if (!direct.agentId) return null;
  const agentId = direct.agentId;
  const library = await fetchAuthenticatedJson({ url: buildGatewayRequestUrl(gatewayUrl, "/api/chat-agents"),
    token, schema: ChatAgentListResponseSchema, errorMessage: STATUS_ERROR });
  const agent = library.enabled ? library.agents.find(candidate => candidate.id === agentId && !candidate.archived) : undefined;
  if (!agent) throw new Error(STATUS_ERROR);
  const identity = { agentId, name: agent.name, selection: agent.selection, revision: agent.revision, instructions: agent.instructions, recipeRef: agent.recipeRef };
  if (!agent.recipeRef) return { ...identity, kind: "custom", interactions: [], tasks: [], authority: null };
  const [interactions, tasks, authority] = await Promise.all([
    fetchAuthenticatedJson({ url: buildGatewayRequestUrl(gatewayUrl, `${chat}/interactions`), token, schema: interactionsSchema, errorMessage: STATUS_ERROR }),
    fetchAuthenticatedJson({ url: buildGatewayRequestUrl(gatewayUrl, `${chat}/bot-tasks`), token, schema: BotTaskListResponseSchema, errorMessage: STATUS_ERROR }),
    fetchAuthenticatedJson({ url: buildGatewayRequestUrl(gatewayUrl, `${agentPath(agentId)}/authority`), token, schema: BotAuthorityViewSchema, errorMessage: STATUS_ERROR }),
  ]);
  return { ...identity, kind: "recipe", interactions: interactions.interactions, tasks: tasks.tasks, authority };

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

export async function updateNativeBotModel(token: string, gatewayUrl: string, agentId: string,
  baseRevision: number, selection: CanonicalChatModelSelection): Promise<void> {
  const validated = UpdateChatAgentRequestSchema.parse({ baseRevision, selection });
  const body = { baseRevision: validated.baseRevision, selection: validated.selection };
  await fetchAuthenticatedJson({ url: buildGatewayRequestUrl(gatewayUrl, agentPath(agentId)), token,
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    schema: ChatAgentSchema, errorMessage: "Bot model could not be saved. Try again." });
}
