import {
  KernelConversationHistoryResponseSchema,
  KernelConversationSummarySchema,
  type KernelConversationHistoryResponse,
} from "@matrix-os/contracts";
import { z } from "zod/v4";

import { buildGatewayRequestUrl, fetchAuthenticatedJson } from "@/lib/requests/http";

const CONVERSATION_LIST_LIMIT = 50;
const CONVERSATION_RESPONSE_LIMIT = 200;
const CONVERSATIONS_UNAVAILABLE_ERROR = "Chats unavailable. Try again.";
const CONVERSATION_HISTORY_ERROR = "Chat history unavailable. Try again.";
const CONVERSATION_HISTORY_LIMIT = 50;

// Server-validated per-item (KernelConversationSummarySchema is `.strict()`), but
// tolerant at the list level: a single malformed entry is dropped rather than
// blanking the whole recents list.
const ConversationListSchema = z.array(z.unknown())
  .max(CONVERSATION_RESPONSE_LIMIT)
  .transform((items) => {
    const conversations: ConversationSummary[] = [];
    for (const item of items.slice(0, CONVERSATION_LIST_LIMIT)) {
      const parsed = KernelConversationSummarySchema.safeParse(item);
      if (parsed.success) conversations.push(parsed.data);
    }
    return conversations;
  });

export type ConversationSummary = z.infer<typeof KernelConversationSummarySchema>;

export type ConversationHistoryResponse = KernelConversationHistoryResponse;

export function fetchConversations(
  clerkToken: string,
  computerGatewayUrl: string,
): Promise<ConversationSummary[]> {
  let url: string;
  try {
    url = buildGatewayRequestUrl(computerGatewayUrl, "/api/conversations");
  } catch {
    return Promise.reject(new Error(CONVERSATIONS_UNAVAILABLE_ERROR));
  }
  return fetchAuthenticatedJson({
    url,
    token: clerkToken,
    schema: ConversationListSchema,
    errorMessage: CONVERSATIONS_UNAVAILABLE_ERROR,
  });
}

export function fetchConversationHistory(
  clerkToken: string,
  computerGatewayUrl: string,
  conversationId: string,
  cursor?: string,
): Promise<ConversationHistoryResponse> {
  let url: string;
  try {
    url = buildGatewayRequestUrl(
      computerGatewayUrl,
      `/api/conversations/${encodeURIComponent(conversationId)}`,
      cursor
        ? { cursor, limit: String(CONVERSATION_HISTORY_LIMIT) }
        : { limit: String(CONVERSATION_HISTORY_LIMIT) },
    );
  } catch {
    return Promise.reject(new Error(CONVERSATION_HISTORY_ERROR));
  }
  return fetchAuthenticatedJson({
    url,
    token: clerkToken,
    schema: KernelConversationHistoryResponseSchema,
    errorMessage: CONVERSATION_HISTORY_ERROR,
  });
}
