import {
  CanonicalChatIdSchema, CanonicalProviderCatalogSchema,
  ChatAgentIdSchema, ChatAgentSchema, ChatAgentListResponseSchema, ChatMentionSearchResponseSchema,
  ChatAgentRecipeCatalogSchema, ChatContextSnapshotSchema, CreateChatAgentRequestSchema, UpdateChatAgentRequestSchema,
  type ChatAgent, type ChatAgentListResponse, type ChatMentionSearchResponse,
  type ChatAgentRecipeCatalog,
  type ChatContextSnapshot, type CreateChatAgentRequest, type UpdateChatAgentRequest,
  type CanonicalProviderCatalog,
} from "@matrix-os/contracts";
import { z } from "zod/v4";

const MAX_RECIPE_CONNECTIONS = 200;
const IntegrationConnectionSchema = z.object({
  service: z.string().trim().min(1).max(80).regex(/^[a-z][a-z0-9_]{0,79}$/),
  account_label: z.string().trim().min(1).max(100),
  account_email: z.string().trim().min(1).max(256).nullable().optional().transform((value) => value ?? null),
  status: z.string().trim().min(1).max(32),
});
const IntegrationConnectionListSchema = z.array(IntegrationConnectionSchema).max(MAX_RECIPE_CONNECTIONS);

export type ChatAgentIntegrationConnection = z.infer<typeof IntegrationConnectionSchema>;

export interface ChatAgentClient {
  list(): Promise<ChatAgentListResponse>;
  catalog(): Promise<CanonicalProviderCatalog>;
  recipeCatalog(): Promise<ChatAgentRecipeCatalog>;
  integrations(): Promise<ChatAgentIntegrationConnection[]>;
  create(input: CreateChatAgentRequest): Promise<ChatAgent>;
  update(id: string, input: UpdateChatAgentRequest): Promise<ChatAgent>;
  search(query: string, chatId?: string): Promise<ChatMentionSearchResponse>;
  preview(chatId: string): Promise<ChatContextSnapshot>;
}

/** The surface supplies its existing authenticated, timeout-bounded transport. */
export function createChatAgentClient(request: (
  path: string, method: "GET" | "POST" | "PATCH", body?: unknown,
) => Promise<unknown>): ChatAgentClient {
  return {
    list: async () => ChatAgentListResponseSchema.parse(await request("/api/chat-agents", "GET")),
    catalog: async () => CanonicalProviderCatalogSchema.parse(await request("/api/chat-providers", "GET")),
    recipeCatalog: async () => ChatAgentRecipeCatalogSchema.parse(await request("/api/chat-agents/recipe-catalog", "GET")),
    integrations: async () => IntegrationConnectionListSchema.parse(await request("/api/integrations", "GET")),
    create: async (input) => ChatAgentSchema.parse(await request("/api/chat-agents", "POST", CreateChatAgentRequestSchema.parse(input))),
    update: async (id, input) => ChatAgentSchema.parse(await request(`/api/chat-agents/${encodeURIComponent(ChatAgentIdSchema.parse(id))}`,
      "PATCH", UpdateChatAgentRequestSchema.parse(input))),
    search: async (query, chatId) => {
      const params = new URLSearchParams({ query: query.slice(0, 200) });
      if (chatId) params.set("chatId", CanonicalChatIdSchema.parse(chatId));
      return ChatMentionSearchResponseSchema.parse(await request(`/api/chat-mentions?${params}`, "GET"));
    },
    preview: async (chatId) => ChatContextSnapshotSchema.parse(await request(
      `/api/chat-context/${encodeURIComponent(CanonicalChatIdSchema.parse(chatId))}`, "GET")),
  };
}
