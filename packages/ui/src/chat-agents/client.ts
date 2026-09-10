import {
  CanonicalChatIdSchema, CanonicalProviderCatalogSchema,
  ChatAgentIdSchema, ChatAgentSchema, ChatAgentListResponseSchema, ChatMentionSearchResponseSchema,
  ChatContextSnapshotSchema, CreateChatAgentRequestSchema, UpdateChatAgentRequestSchema,
  type ChatAgent, type ChatAgentListResponse, type ChatMentionSearchResponse,
  type ChatContextSnapshot, type CreateChatAgentRequest, type UpdateChatAgentRequest,
  type CanonicalProviderCatalog,
} from "@matrix-os/contracts";

export interface ChatAgentClient {
  list(): Promise<ChatAgentListResponse>;
  catalog(): Promise<CanonicalProviderCatalog>;
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
