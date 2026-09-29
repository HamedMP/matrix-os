import {
  BotAuthorityViewSchema, BotDirectChatResponseSchema, BotGrantIdSchema, BotInteractionIdSchema, BotInteractionSchema,
  BotMemoryItemIdSchema, BotMemoryMutationRequestSchema, BotMemoryMutationResponseSchema,
  BotRecipeListResponseSchema, BotTaskListResponseSchema, CanonicalChatIdSchema, ChatAgentIdSchema,
  InstantiateBotRequestSchema, InstantiateBotResponseSchema, ResolveBotInteractionRequestSchema,
  ResolveBotInteractionResponseSchema, RevokeBotGrantResponseSchema,
  type BotAuthorityView, type BotInteraction, type BotMemoryMutationRequest,
  type BotRecipeSummary, type BotTaskSummary, type InstantiateBotRequest, type InstantiateBotResponse,
  type ResolveBotInteractionRequest, type ResolveBotInteractionResponse,
} from "@matrix-os/contracts";
import { z } from "zod/v4";

type BotRequest = (path: string, method: "GET" | "POST" | "DELETE", body?: unknown) => Promise<unknown>;

const safeMessages: Record<number, string> = {
  400: "The request is invalid.",
  401: "Sign in and try again.",
  403: "You do not have access to this bot.",
  404: "This bot item could not be found.",
  409: "This changed since you loaded it. Refresh and try again.",
  410: "This request has expired.",
  429: "You have reached the bot limit.",
  503: "Bots are temporarily unavailable.",
};
const fallbackMessage = "Bots are temporarily unavailable.";

export class BotClientError extends Error {
  constructor(readonly status: number | null, message: string) {
    super(message);
    this.name = "BotClientError";
  }
}

function safeError(error: unknown): BotClientError {
  const status = typeof error === "object" && error !== null && "status" in error
    && typeof error.status === "number" ? error.status : null;
  return new BotClientError(status, status === null ? fallbackMessage : safeMessages[status] ?? fallbackMessage);
}

export interface BotClient {
  directBot(chatId: string): Promise<string | null>;
  recipes(): Promise<BotRecipeSummary[]>;
  instantiate(input: InstantiateBotRequest): Promise<InstantiateBotResponse>;
  interactions(chatId: string): Promise<BotInteraction[]>;
  tasks(chatId: string): Promise<BotTaskSummary[]>;
  resolve(chatId: string, interactionId: string, input: ResolveBotInteractionRequest): Promise<ResolveBotInteractionResponse>;
  authority(agentId: string): Promise<BotAuthorityView>;
  revoke(agentId: string, grantId: string): Promise<void>;
  memory(agentId: string, itemId: string, action: "confirm" | "forget", input: BotMemoryMutationRequest): Promise<void>;
}

/** All responses are parsed and all failures become fixed, client-safe copy. */
export function createBotClient(request: BotRequest): BotClient {
  const call = async <T>(path: string, method: "GET" | "POST" | "DELETE", schema: z.ZodType<T>, body?: unknown): Promise<T> => {
    try {
      return schema.parse(await request(path, method, body));
    } catch (error: unknown) {
      throw safeError(error);
    }
  };
  const agentPath = (agentId: string) => `/api/chat-agents/${encodeURIComponent(ChatAgentIdSchema.parse(agentId))}`;
  const chatPath = (chatId: string) => `/api/chats/${encodeURIComponent(CanonicalChatIdSchema.parse(chatId))}`;
  return {
    directBot: async (chatId) => (await call(`${chatPath(chatId)}/bot`, "GET", BotDirectChatResponseSchema)).agentId,
    recipes: async () => (await call("/api/chat-agents/bot-recipes", "GET", BotRecipeListResponseSchema)).recipes,
    instantiate: (input) => call("/api/chat-agents/instantiate", "POST", InstantiateBotResponseSchema, InstantiateBotRequestSchema.parse(input)),
    interactions: async (chatId) => (await call(`${chatPath(chatId)}/interactions`, "GET", z.object({ interactions: z.array(BotInteractionSchema).max(32) }).strict())).interactions,
    tasks: async (chatId) => (await call(`${chatPath(chatId)}/bot-tasks`, "GET", BotTaskListResponseSchema)).tasks,
    resolve: (chatId, interactionId, input) => call(
      `${chatPath(chatId)}/interactions/${encodeURIComponent(BotInteractionIdSchema.parse(interactionId))}/resolve`,
      "POST", ResolveBotInteractionResponseSchema, ResolveBotInteractionRequestSchema.parse(input)),
    authority: (agentId) => call(`${agentPath(agentId)}/authority`, "GET", BotAuthorityViewSchema),
    revoke: async (agentId, grantId) => {
      await call(`${agentPath(agentId)}/grants/${encodeURIComponent(BotGrantIdSchema.parse(grantId))}`, "DELETE", RevokeBotGrantResponseSchema);
    },
    memory: async (agentId, itemId, action, input) => {
      await call(`${agentPath(agentId)}/memory/${encodeURIComponent(BotMemoryItemIdSchema.parse(itemId))}/${action}`,
        "POST", BotMemoryMutationResponseSchema, BotMemoryMutationRequestSchema.parse(input));
    },
  };
}
