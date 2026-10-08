import { z } from "zod/v4";
import {
  ChatAgentSchema, UpdateChatAgentRequestSchema, BotAuthorityViewSchema, BotChatBindingResponseSchema, BotDirectChatResponseSchema, BotGrantIdSchema, BotInteractionIdSchema,
  BotInteractionSchema, BotMemoryItemIdSchema, BotMemoryMutationRequestSchema, BotMemoryMutationResponseSchema,
  BotRecipeListResponseSchema, BotTaskListResponseSchema, CanonicalChatIdSchema, ChatAgentIdSchema, ChatAgentListResponseSchema,
  InstantiateBotRequestSchema, InstantiateBotResponseSchema,
  ResolveBotInteractionRequestSchema, ResolveBotInteractionResponseSchema, RevokeBotGrantResponseSchema,
  type CanonicalChatModelSelection, type BotAuthorityView, type BotInteraction, type BotMemoryMutationRequest, type BotRecipeSummary, type BotTaskSummary,
  type ChatAgent, type ChatAgentListResponse,
  type InstantiateBotRequest, type InstantiateBotResponse,
  type ResolveBotInteractionRequest, type ResolveBotInteractionResponse,
} from "@matrix-os/contracts";
import { fetchAuthenticatedAnswer, gatewayRequestUrl, type RequestAnswer } from "./answers";
import { buildGatewayRequestUrl, fetchAuthenticatedJson, fetchAuthenticatedResponse } from "./http";

export interface NativeBotChatSnapshot {
  agentId: string;
  name: string;
  selection?: CanonicalChatModelSelection;
  revision?: number;
  interactions: BotInteraction[];
  tasks: BotTaskSummary[];
  authority: BotAuthorityView;
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
  // A computer whose gateway predates bots has no such route: its chats simply
  // have no bot, which is not an error to show or a request to keep retrying.
  const direct = await fetchAuthenticatedResponse(
    { url: buildGatewayRequestUrl(gatewayUrl, `${chat}/bot`), token, errorMessage: STATUS_ERROR, expectedStatuses: [404] },
    async (response) => response.status === 404 ? null : BotDirectChatResponseSchema.parse(await response.json()),
  );
  if (!direct?.agentId) return null;
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
  const agent = library.status === "fulfilled" ? library.value.agents.find((candidate) => candidate.id === agentId) : undefined;
  return {
    agentId,
    ...(agent ? { selection: agent.selection, revision: agent.revision } : {}),
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

export async function updateNativeBotModel(token: string, gatewayUrl: string, agentId: string,
  baseRevision: number, selection: CanonicalChatModelSelection): Promise<void> {
  const validated = UpdateChatAgentRequestSchema.parse({ baseRevision, selection });
  const body = { baseRevision: validated.baseRevision, selection: validated.selection };
  await fetchAuthenticatedJson({ url: buildGatewayRequestUrl(gatewayUrl, agentPath(agentId)), token,
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    schema: ChatAgentSchema, errorMessage: "Bot model could not be saved. Try again." });
}

// -- Agents (the product's name for what this code calls bots) ---------------

const AGENTS_UNAVAILABLE_ERROR = "Agents unavailable. Try again.";
const AGENT_UNAVAILABLE_ERROR = "Agent unavailable. Try again.";
const AGENT_STATUS_ERROR = "Agent status unavailable. Try again.";
const JSON_HEADERS = { "Content-Type": "application/json" };

/**
 * - `conflict`: the agent changed since the screen loaded it (a newer
 *   revision), or its chat can no longer be opened.
 * - `not_found`: the agent no longer exists, or is archived.
 * - `unavailable`: anything else.
 */
export type AgentRequestFailure = "conflict" | "not_found" | "unavailable";

// Written here, so safe to show; the server's own wording never reaches a screen.
const AGENT_FAILURE_MESSAGES: Record<AgentRequestFailure, string> = {
  conflict: "This agent changed. Refresh and try again.",
  not_found: "This agent no longer exists.",
  unavailable: AGENT_UNAVAILABLE_ERROR,
};

/** Carries a reason and this app's wording for it; never the server's. */
export class AgentRequestError extends Error {
  constructor(readonly reason: AgentRequestFailure) {
    super(AGENT_FAILURE_MESSAGES[reason]);
    this.name = "AgentRequestError";
  }
}

function agentUrl(gatewayUrl: string, agentId: string, suffix = ""): string | null {
  const id = ChatAgentIdSchema.safeParse(agentId);
  return id.success ? gatewayRequestUrl(gatewayUrl, `/api/chat-agents/${encodeURIComponent(id.data)}${suffix}`) : null;
}

function agentChatUrl(gatewayUrl: string, chatId: string, suffix: string): string | null {
  const id = CanonicalChatIdSchema.safeParse(chatId);
  return id.success ? gatewayRequestUrl(gatewayUrl, `/api/chats/${encodeURIComponent(id.data)}${suffix}`) : null;
}

/** A write whose 404 and 409 answers mean something to the screen. */
async function writeAgent<T>(request: {
  url: string;
  token: string;
  method: "POST" | "PATCH";
  body: unknown;
  schema: { parse(value: unknown): T };
}): Promise<T> {
  let answer: RequestAnswer<T>;
  try {
    answer = await fetchAuthenticatedAnswer({
      url: request.url,
      token: request.token,
      schema: request.schema,
      errorMessage: AGENT_UNAVAILABLE_ERROR,
      refusalStatuses: [404, 409],
      method: request.method,
      headers: JSON_HEADERS,
      body: JSON.stringify(request.body),
    });
  } catch (error: unknown) {
    console.warn("[mobile] agent request failed", error instanceof Error ? error.name : "unknown");
    throw new AgentRequestError("unavailable");
  }
  if (answer.ok) return answer.value;
  throw new AgentRequestError(answer.status === 404 ? "not_found" : "conflict");
}

/** `GET /api/chat-agents`: the saved agents, archived ones left out. `enabled` is false when agents are switched off. */
export function fetchAgents(token: string, gatewayUrl: string): Promise<ChatAgentListResponse> {
  const url = gatewayRequestUrl(gatewayUrl, "/api/chat-agents");
  if (!url) return Promise.reject(new Error(AGENTS_UNAVAILABLE_ERROR));
  return fetchAuthenticatedJson({ url, token, schema: ChatAgentListResponseSchema, errorMessage: AGENTS_UNAVAILABLE_ERROR });
}

/** `GET /api/chat-agents/:agentId/direct-chat`: the agent's own chat, or null when it has none yet. */
export async function fetchAgentDirectChat(token: string, gatewayUrl: string, agentId: string): Promise<string | null> {
  const url = agentUrl(gatewayUrl, agentId, "/direct-chat");
  if (!url) throw new Error(AGENT_UNAVAILABLE_ERROR);
  const binding = await fetchAuthenticatedJson({
    url, token, schema: BotChatBindingResponseSchema, errorMessage: AGENT_UNAVAILABLE_ERROR,
  });
  return binding.chatId;
}

/** `POST /api/chat-agents/:agentId/direct-chat`: the agent's own chat, created if it had none. */
export async function ensureAgentDirectChat(token: string, gatewayUrl: string, agentId: string): Promise<string> {
  const url = agentUrl(gatewayUrl, agentId, "/direct-chat");
  if (!url) throw new AgentRequestError(ChatAgentIdSchema.safeParse(agentId).success ? "unavailable" : "not_found");
  const binding = await writeAgent({ url, token, method: "POST", body: {}, schema: BotChatBindingResponseSchema });
  if (!binding.chatId) throw new AgentRequestError("unavailable");
  return binding.chatId;
}

/**
 * `PATCH /api/chat-agents/:agentId` with `{ baseRevision, archived: true }`.
 * A `baseRevision` that is no longer the agent's revision rejects with the
 * reason `conflict`: load the agent again and retry with its new revision.
 */
export async function archiveAgent(token: string, gatewayUrl: string, agentId: string, baseRevision: number): Promise<ChatAgent> {
  const body = UpdateChatAgentRequestSchema.safeParse({ baseRevision, archived: true });
  const url = agentUrl(gatewayUrl, agentId);
  if (!url) throw new AgentRequestError(ChatAgentIdSchema.safeParse(agentId).success ? "unavailable" : "not_found");
  if (!body.success) throw new AgentRequestError("unavailable");
  return writeAgent({
    url, token, method: "PATCH", schema: ChatAgentSchema,
    body: { baseRevision: body.data.baseRevision, archived: true },
  });
}

/** `GET /api/chats/:chatId/bot-tasks`: the unfinished tasks of the agent whose chat this is, newest first. */
export async function fetchAgentTasks(token: string, gatewayUrl: string, chatId: string): Promise<BotTaskSummary[]> {
  const url = agentChatUrl(gatewayUrl, chatId, "/bot-tasks");
  if (!url) throw new Error(AGENT_STATUS_ERROR);
  return (await fetchAuthenticatedJson({ url, token, schema: BotTaskListResponseSchema, errorMessage: AGENT_STATUS_ERROR })).tasks;
}

/** `GET /api/chats/:chatId/interactions`: what the agent in this chat is waiting on the person for. */
export async function fetchAgentInteractions(token: string, gatewayUrl: string, chatId: string): Promise<BotInteraction[]> {
  const url = agentChatUrl(gatewayUrl, chatId, "/interactions");
  if (!url) throw new Error(AGENT_STATUS_ERROR);
  return (await fetchAuthenticatedJson({ url, token, schema: interactionsSchema, errorMessage: AGENT_STATUS_ERROR })).interactions;
}
