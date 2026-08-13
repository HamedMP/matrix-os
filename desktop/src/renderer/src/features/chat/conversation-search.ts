import type { HermesConversationSummary } from "../../stores/hermes-chat";

export function normalizeConversationQuery(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function filterConversations(
  conversations: HermesConversationSummary[],
  query: string,
): HermesConversationSummary[] {
  const normalized = normalizeConversationQuery(query);
  if (!normalized) return conversations;
  return conversations.filter((conversation) =>
    `${conversation.title}\n${conversation.preview}`.toLocaleLowerCase().includes(normalized),
  );
}
