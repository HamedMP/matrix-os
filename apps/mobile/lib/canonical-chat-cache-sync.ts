import type { CanonicalChatContentFrame, CanonicalChatDetailResponse } from "@matrix-os/contracts";
import type { QueryClient, QueryKey } from "@tanstack/react-query";

import { applyCanonicalChatContentFrames } from "@/lib/canonical-chat-content";
import type { CanonicalChatInvalidation } from "@/lib/canonical-chat-events";

// A snapshot fetch normally lands within a few frames; this only bounds the
// queue if one never does.
const MAX_WAITING_FRAMES = 200;
// Streamed text arrives as many `run.message` events a second, and each one
// changes the chat's preview in the list. Refetching the list for every one
// would be constant traffic, so while text streams it refreshes this often.
const STREAMING_LIST_REFRESH_MS = 2_000;

/**
 * Keeps the React Query cache in step with the chat event stream: streamed
 * content is written straight into the open chat's detail, and everything
 * else becomes a refetch of the list or the detail.
 */
export function createCanonicalChatCacheSync(options: {
  queryClient: QueryClient;
  chatsKey: QueryKey;
  /** The chat on screen, or null while a draft has not been created yet. */
  activeChatId: string | null;
  /** The detail query of the chat on screen. */
  detailKey: QueryKey;
}): { handle(event: CanonicalChatInvalidation): void; dispose(): void } {
  const { queryClient, chatsKey, activeChatId, detailKey } = options;
  // Streamed frames that don't fit the cached detail yet: the detail is still
  // loading, or a frame was missed. They wait here for a snapshot instead of
  // being dropped, so streaming picks up right after it.
  let waitingFrames: CanonicalChatContentFrame[] = [];
  let listRefreshTimer: ReturnType<typeof setTimeout> | undefined;

  function refreshList() {
    clearTimeout(listRefreshTimer);
    listRefreshTimer = undefined;
    void queryClient.invalidateQueries({ queryKey: chatsKey });
  }

  function refreshListSoon() {
    listRefreshTimer ??= setTimeout(refreshList, STREAMING_LIST_REFRESH_MS);
  }

  function applyWaitingFrames() {
    const cached = queryClient.getQueryData<CanonicalChatDetailResponse>(detailKey);
    if (!cached) return;
    const { detail, unapplied } = applyCanonicalChatContentFrames(cached, waitingFrames);
    waitingFrames = unapplied;
    if (detail !== cached) queryClient.setQueryData(detailKey, detail);
  }

  function applyFrame(frame: CanonicalChatContentFrame) {
    const wasWaiting = waitingFrames.length > 0;
    waitingFrames = [...waitingFrames, frame].slice(-MAX_WAITING_FRAMES);
    applyWaitingFrames();
    if (waitingFrames.length === 0) return;

    // A frame that doesn't fit needs a snapshot. The first one always starts a
    // fresh fetch, because one already in flight was requested before this
    // frame existed. Later frames queue behind that fetch, and start another
    // only if it has ended without unblocking them -- that is, it failed.
    const fetching = queryClient.isFetching({ queryKey: detailKey, exact: true }) > 0;
    if (!wasWaiting || !fetching) {
      void queryClient.invalidateQueries({ queryKey: detailKey }).then(applyWaitingFrames);
    }
  }

  return {
    handle(event) {
      if (event.type === "chat.full_refresh") {
        refreshList();
        if (activeChatId) void queryClient.invalidateQueries({ queryKey: detailKey });
        return;
      }
      if (event.eventType === "run.message") refreshListSoon();
      else refreshList();

      if (event.chatId !== activeChatId) return;
      if (event.content) applyFrame(event.content);
      else void queryClient.invalidateQueries({ queryKey: detailKey });
    },
    dispose() {
      clearTimeout(listRefreshTimer);
      listRefreshTimer = undefined;
    },
  };
}
