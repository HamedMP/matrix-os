import type { CanonicalChatListResponse, CanonicalChatRecord } from "@matrix-os/contracts";
import { useEffect, useMemo } from "react";
import { useAuth } from "@clerk/clerk-expo";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";

import { MAX_OLDER_CHAT_PAGES, mergeChatPages } from "@/lib/chat-pages";
import { fetchActiveComputer, fetchChats, mobileQueryKeys } from "@/lib/requests";
import { HOSTED_GATEWAY_URL } from "@/lib/storage";

const EMPTY_CHATS: CanonicalChatRecord[] = [];

const itemsOf = (response: CanonicalChatListResponse) => response.items;
const wholePage = (response: CanonicalChatListResponse) => response;

/** The first page of chats: the one that is saved to disk and kept current by chat events. */
function useFirstChatPage<T>(select: (response: CanonicalChatListResponse) => T) {
  const queryClient = useQueryClient();
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
  const chatsQueryKey = mobileQueryKeys.canonicalChats(userId ?? "signed-out", computerKey);
  const chats = useQuery({
    queryKey: chatsQueryKey,
    enabled: authEnabled && Boolean(computer),
    queryFn: async () => {
      const token = await getToken();
      if (!token || !computer) throw new Error("Chats unavailable.");
      return fetchChats(token, `${HOSTED_GATEWAY_URL}${computer.gatewayPath}`);
    },
    select,
  });

  return {
    queryClient,
    getToken,
    userId: userId ?? "signed-out",
    computer,
    computerKey,
    chatsQueryKey,
    page: chats.data,
    isPending: authEnabled && (
      activeComputer.isPending
      || (Boolean(computer) && chats.isPending)
    ),
    isError: activeComputer.isError || chats.isError,
    invalidate: () => queryClient.invalidateQueries({ queryKey: chatsQueryKey }),
  };
}

export function useCanonicalChats() {
  const first = useFirstChatPage(itemsOf);

  return {
    computer: first.computer,
    chats: first.page ?? [],
    isPending: first.isPending,
    isError: first.isError,
    invalidate: first.invalidate,
  };
}

interface OlderChatPage {
  items: CanonicalChatRecord[];
  nextCursor?: string;
  /** Where the first page ended when the older pages were read from its end. */
  after: string | null;
}

/**
 * `useCanonicalChats` with older chats loaded a page at a time. The first page
 * is the same cached page; older pages are fetched on demand and continue
 * from where it ends.
 */
export function useCanonicalChatPages() {
  const first = useFirstChatPage(wholePage);
  const { queryClient, getToken, computer, chatsQueryKey } = first;
  const firstItems = first.page?.items ?? EMPTY_CHATS;
  const firstCursor = first.page ? first.page.nextCursor ?? null : undefined;

  const older = useInfiniteQuery({
    queryKey: mobileQueryKeys.canonicalChatsOlder(first.userId, first.computerKey),
    // Read only when asked for (`loadMore`), and again when the first page moves.
    enabled: false,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }): Promise<OlderChatPage> => {
      // The first older page starts where the first page ends at the time of
      // this read, which need not be where it ended when the read was asked for.
      const after = queryClient.getQueryData<CanonicalChatListResponse>(chatsQueryKey)?.nextCursor ?? null;
      const cursor = pageParam ?? after;
      if (!cursor) return { items: [], after };
      const token = await getToken();
      if (!token || !computer) throw new Error("Chats unavailable.");
      const page = await fetchChats(token, `${HOSTED_GATEWAY_URL}${computer.gatewayPath}`, { cursor });
      return { items: page.items, nextCursor: page.nextCursor, after };
    },
    // An empty page that still has a cursor is not the end of the list.
    getNextPageParam: (last) => last.nextCursor,
  });
  const olderPages = older.data?.pages;
  const olderAfter = olderPages?.[0]?.after;
  const refetchOlder = older.refetch;

  // Older pages continue from the first page as it was when they were read.
  // When a new chat or new activity moves the end of the first page, pages
  // read from the old end would skip or repeat a chat, so they are read again.
  useEffect(() => {
    if (olderAfter === undefined || firstCursor === undefined || olderAfter === firstCursor) return;
    void refetchOlder({ cancelRefetch: false });
  }, [firstCursor, olderAfter, refetchOlder]);

  const chats = useMemo(
    () => olderPages ? mergeChatPages([firstItems, ...olderPages.map((page) => page.items)]) : firstItems,
    [firstItems, olderPages],
  );
  const atPageLimit = (olderPages?.length ?? 0) >= MAX_OLDER_CHAT_PAGES;
  const moreOnServer = olderPages ? older.hasNextPage : Boolean(firstCursor);
  const hasMore = moreOnServer && !atPageLimit;
  const fetchNextPage = older.fetchNextPage;

  return {
    computer,
    chats,
    isPending: first.isPending,
    isError: first.isError,
    invalidate: first.invalidate,
    /**
     * Reads everything on screen again, as for pull-to-refresh. `invalidate`
     * reads the first page, and the older ones only if that moved it.
     */
    refresh: async () => {
      await first.invalidate();
      if (olderPages) await refetchOlder({ cancelRefetch: false });
    },
    /** There are older chats that `loadMore` would fetch. */
    hasMore,
    /** Fetches the next older page. Never rejects; a failure shows as `isLoadMoreError`. */
    loadMore: async () => {
      if (hasMore) await fetchNextPage();
    },
    // Only a page that was asked for: re-reading the older pages is not "loading more".
    isLoadingMore: older.isFetchingNextPage,
    isLoadMoreError: older.isFetchNextPageError,
    /** The server has more, but this list holds as many pages as it will. */
    atPageLimit: moreOnServer && atPageLimit,
  };
}
