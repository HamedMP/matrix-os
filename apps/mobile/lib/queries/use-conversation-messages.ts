import { useAuth } from "@clerk/clerk-expo";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import type { Message } from "@/lib/chat-message";
import {
  fetchActiveComputer,
  fetchConversationHistory,
  mobileQueryKeys,
  type ConversationHistoryResponse,
} from "@/lib/requests";
import { HOSTED_GATEWAY_URL } from "@/lib/storage";

/** Newest-first, matching the inverted transcript FlatList. */
function flattenNewestFirst(pages: ConversationHistoryResponse[]): Message[] {
  const messages: Message[] = [];
  for (const page of pages) {
    for (let index = page.messages.length - 1; index >= 0; index -= 1) {
      const item = page.messages[index]!;
      messages.push({
        id: `${page.id}:${item.index}`,
        role: item.role,
        content: item.content,
        tool: item.tool,
        timestamp: item.timestamp,
      });
    }
  }
  return messages;
}

export function useConversationMessages(conversationId: string | null) {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth();
  const authEnabled = Boolean(isLoaded && isSignedIn && userId);
  const activeComputer = useQuery({
    queryKey: mobileQueryKeys.activeComputer(userId ?? "signed-out"),
    enabled: authEnabled,
    queryFn: async () => {
      const token = await getToken();
      if (!token) throw new Error("Computer unavailable.");
      return fetchActiveComputer(token);
    },
  });
  const computer = activeComputer.data;
  const computerKey = computer ? `${computer.handle}:${computer.runtimeSlot}` : "none";

  const query = useInfiniteQuery({
    queryKey: mobileQueryKeys.messages(userId ?? "signed-out", computerKey, conversationId ?? "none"),
    enabled: authEnabled && Boolean(computer) && Boolean(conversationId),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const token = await getToken();
      if (!token || !computer || !conversationId) throw new Error("Chat history unavailable. Try again.");
      return fetchConversationHistory(
        token,
        `${HOSTED_GATEWAY_URL}${computer.gatewayPath}`,
        conversationId,
        pageParam,
      );
    },
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.nextCursor : undefined),
  });

  const messages = useMemo(
    () => (query.data ? flattenNewestFirst(query.data.pages) : []),
    [query.data],
  );

  return {
    messages,
    isPending: authEnabled && Boolean(conversationId) && (
      activeComputer.isPending || query.isPending
    ),
    isError: activeComputer.isError || query.isError,
    hasOlder: query.hasNextPage,
    isLoadingOlder: query.isFetchingNextPage,
    loadOlder: () => query.fetchNextPage(),
  };
}
