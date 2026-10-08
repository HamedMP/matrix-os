import {createBotConnectionClient, type BotConnectionClient} from "./provider-connections-client.js";
import {
  BotAccountLabelSchema, BotChatBindingResponseSchema, BotAuthorityViewSchema, BotDirectChatResponseSchema, BotGrantIdSchema, BotInteractionIdSchema, BotInteractionSchema,
  BotMemoryItemIdSchema, BotMemoryMutationRequestSchema, BotMemoryMutationResponseSchema,
  BotRecipeListResponseSchema, BotTaskListResponseSchema, CanonicalChatApiCursorSchema, CanonicalChatIdSchema,
  CanonicalChatListResponseSchema, CanonicalChatRecordSchema, CanonicalChatRequestIdSchema, ChatAgentIdSchema,
  InstantiateBotRequestSchema, InstantiateBotResponseSchema, ResolveBotInteractionRequestSchema,
  ResolveBotInteractionResponseSchema, RevokeBotGrantResponseSchema,
  type BotAuthorityView, type BotInteraction, type BotMemoryMutationRequest, type CanonicalChatListResponse,
  type CanonicalChatRecord,
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

/** Thread routes (spec 567): a thread is one more Chat of a recipe Bot, fixed to one project when it is created. */
const ThreadProjectIdSchema = z.string().regex(/^proj_[A-Za-z0-9_-]{1,128}$/);
/** The thread title rule is the same safe label as an account label: at most 120 characters. */
const ThreadTitleSchema = BotAccountLabelSchema;
const ThreadPageLimit = z.number().int().min(1).max(100);

export interface BotThreadCreateInput { clientRequestId: string; projectId: string; title?: string }
export interface BotThreadListInput { projectId: string; limit?: number; cursor?: string }

export class BotClientError extends Error {
  constructor(readonly status: number | null, message: string) {
    super(message);
    this.name = "BotClientError";
  }
}

function safeError(error: unknown): BotClientError {
  const status = typeof error === "object" && error !== null && "status" in error
    && typeof error.status === "number" ? error.status
    : typeof error === "object" && error !== null && "category" in error && error.category === "unauthorized" ? 401 : null;
  return new BotClientError(status, status === null ? fallbackMessage : safeMessages[status] ?? fallbackMessage);
}

export interface BotClient extends Partial<BotConnectionClient> {
  ensureDirectChat(agentId: string): Promise<string | null>;
  directChat(agentId: string): Promise<string | null>;
  directBot(chatId: string): Promise<string | null>;
  /** The listed recipes; a recipe kept out of the list (the Company Brain) comes back only when asked for by id. */
  recipes(recipeId?: string): Promise<BotRecipeSummary[]>;
  threads: {
    /** POST /api/chat-agents/:agentId/threads: the new (or replayed) Chat record. */
    create(agentId: string, input: BotThreadCreateInput): Promise<CanonicalChatRecord>;
    /** GET /api/chat-agents/:agentId/threads: the Bot's Chats for one project, newest activity first. */
    list(agentId: string, input: BotThreadListInput): Promise<CanonicalChatListResponse>;
  };
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
    ...createBotConnectionClient((path, method, body) => request(path, method, body)),
    ensureDirectChat: async (agentId) => (await call(`${agentPath(agentId)}/direct-chat`, "POST", BotChatBindingResponseSchema, {})).chatId,
    directChat: async (agentId) => (await call(`${agentPath(agentId)}/direct-chat`, "GET", BotChatBindingResponseSchema)).chatId,
    directBot: async (chatId) => (await call(`${chatPath(chatId)}/bot`, "GET", BotDirectChatResponseSchema)).agentId,
    recipes: async (recipeId) => (await call(recipeId === undefined ? "/api/chat-agents/bot-recipes"
      : `/api/chat-agents/bot-recipes?${new URLSearchParams({ recipeId })}`, "GET", BotRecipeListResponseSchema)).recipes,
    threads: {
      create: async (agentId, input) => {
        // An unsafe or long generated title is left out; the server then names the thread itself.
        const title = ThreadTitleSchema.safeParse(input.title);
        return call(`${agentPath(agentId)}/threads`, "POST", CanonicalChatRecordSchema, {
          clientRequestId: CanonicalChatRequestIdSchema.parse(input.clientRequestId),
          projectId: ThreadProjectIdSchema.parse(input.projectId),
          ...(title.success ? { title: title.data } : {}),
        });
      },
      list: async (agentId, input) => {
        const query = new URLSearchParams({ projectId: ThreadProjectIdSchema.parse(input.projectId) });
        if (input.limit !== undefined) query.set("limit", String(ThreadPageLimit.parse(input.limit)));
        if (input.cursor !== undefined) query.set("cursor", CanonicalChatApiCursorSchema.parse(input.cursor));
        return call(`${agentPath(agentId)}/threads?${query}`, "GET", CanonicalChatListResponseSchema);
      },
    },
    instantiate: (input) => call("/api/chat-agents/instantiate", "POST", InstantiateBotResponseSchema, InstantiateBotRequestSchema.parse(input)),
    interactions: async (chatId) => (await call(`${chatPath(chatId)}/interactions`, "GET", z.object({ interactions: z.array(BotInteractionSchema).max(32) }).strict())).interactions,
    tasks: async (chatId) => (await call(`${chatPath(chatId)}/bot-tasks?includeRunIds=true`, "GET", BotTaskListResponseSchema)).tasks,
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
