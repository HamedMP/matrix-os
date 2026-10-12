import type { CanonicalChatRecord } from "@matrix-os/contracts";
import { useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";

import { MAX_OLDER_CHAT_PAGES, mergeChatPages } from "@/lib/chat-pages";
import { useActiveGateway } from "@/lib/queries/use-active-gateway";
import { fetchProjectChats, mobileQueryKeys } from "@/lib/requests";

const EMPTY_CHATS: CanonicalChatRecord[] = [];
// Every loaded page is read again whenever the chat list is refreshed, so the
// number of pages is bounded the same way as for the list of every chat.
const MAX_PROJECT_CHAT_PAGES = MAX_OLDER_CHAT_PAGES + 1;

/**
 * The chats of one project (by project id, not slug), most recent activity
 * first, a page at a time. Its key extends the chat list's, so whatever
 * refreshes that list -- a sent message, a chat event -- refreshes this too.
 */
export function useProjectChats(projectId: string | null) {
  const gateway = useActiveGateway();
  const enabled = gateway.ready && Boolean(projectId);
  const query = useInfiniteQuery({
    queryKey: mobileQueryKeys.projectChats(gateway.userId, gateway.computerKey, projectId ?? "none"),
    enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const session = await gateway.session();
      if (!session || !projectId) throw new Error("Chats unavailable.");
      return fetchProjectChats(session.token, session.gatewayUrl, projectId, { cursor: pageParam });
    },
    // An empty page that still has a cursor is not the end of the list.
    getNextPageParam: (last) => last.nextCursor,
  });
  const pages = query.data?.pages;
  const chats = useMemo(
    () => pages ? mergeChatPages(pages.map((page) => page.items)) : EMPTY_CHATS,
    [pages],
  );
  const atPageLimit = (pages?.length ?? 0) >= MAX_PROJECT_CHAT_PAGES;
  const hasMore = query.hasNextPage && !atPageLimit;
  const fetchNextPage = query.fetchNextPage;

  return {
    chats,
    isPending: Boolean(projectId) && gateway.authEnabled && (
      gateway.isComputerPending
      || (gateway.ready && query.isPending)
    ),
    /** The first page could not be loaded; a failed further page is `isLoadMoreError`. */
    isError: Boolean(projectId) && (gateway.isComputerError || query.isLoadingError),
    /** There are further chats that `loadMore` would fetch. */
    hasMore,
    /** Fetches the next page. Never rejects; a failure shows as `isLoadMoreError`. */
    loadMore: async () => {
      if (hasMore) await fetchNextPage();
    },
    isLoadingMore: query.isFetchingNextPage,
    isLoadMoreError: query.isFetchNextPageError,
    /** The server has more, but this list holds as many pages as it will. */
    atPageLimit: query.hasNextPage && atPageLimit,
    /** Reads every loaded page again, as a screen does when it regains focus. */
    refetch: () => query.refetch(),
  };
}
