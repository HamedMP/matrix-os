import { z } from "zod/v4";

import { buildGatewayRequestUrl, fetchAuthenticatedJson } from "@/lib/requests/http";

const CONVERSATION_LIST_LIMIT = 50;
const CONVERSATION_RESPONSE_LIMIT = 200;
const CONVERSATIONS_UNAVAILABLE_ERROR = "Chats unavailable. Try again.";

const ConversationSummarySchema = z.object({
  id: z.string().min(1).max(128),
  preview: z.string().max(2_000),
  messageCount: z.number().int().nonnegative(),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
});

const ConversationListSchema = z.array(z.unknown())
  .max(CONVERSATION_RESPONSE_LIMIT)
  .transform((items) => {
    const conversations: ConversationSummary[] = [];
    for (const item of items.slice(0, CONVERSATION_LIST_LIMIT)) {
      const parsed = ConversationSummarySchema.safeParse(item);
      if (parsed.success) conversations.push(parsed.data);
    }
    return conversations;
  });

export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;

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
