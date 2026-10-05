import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { useAuth } from "@clerk/clerk-expo";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useCanonicalChatSession } from "@/lib/canonical-chat-session-context";
import { fetchActiveComputer, fetchChatDetail, mobileQueryKeys } from "@/lib/requests";
import { HOSTED_GATEWAY_URL } from "@/lib/storage";

// Matches desktop's fallback poll: slow enough to stay out of the stream's way.
const ACTIVE_RUN_POLL_MS = 2_000;
// With the stream up, a run that goes quiet -- a long tool call, a pending
// approval, a run that never finishes -- has nothing new to fetch. This only
// catches the case of a final event that never reached us.
const LIVE_STREAM_SAFETY_POLL_MS = 30_000;
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "aborted"]);

/**
 * Live updates -- streamed text, tool activity -- arrive over the chat event
 * stream and are written straight into this query's cache (see
 * canonical-chat-cache-sync.ts). Polling is the fallback for when that stream
 * is down, as on desktop: the gateway persists each piece of text as it is
 * generated, so a plain refetch still observes the reply growing. Polls only
 * while a run is active, and stops itself once it settles.
 */
export function activeRunPollInterval(
  detail: CanonicalChatDetailResponse | undefined,
  streamLive: boolean,
): number | false {
  const active = detail?.runs?.some((run) => !TERMINAL_RUN_STATUSES.has(run.status)) ?? false;
  if (!active) return false;
  return streamLive ? LIVE_STREAM_SAFETY_POLL_MS : ACTIVE_RUN_POLL_MS;
}

export function useCanonicalChatDetail(chatId: string | null) {
  const queryClient = useQueryClient();
  const { streamLive } = useCanonicalChatSession();
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
  const detailQueryKey = mobileQueryKeys.canonicalChatDetail(
    userId ?? "signed-out",
    computerKey,
    chatId ?? "none",
  );
  const detail = useQuery({
    queryKey: detailQueryKey,
    enabled: authEnabled && Boolean(computer) && Boolean(chatId),
    queryFn: async () => {
      const token = await getToken();
      if (!token || !computer || !chatId) throw new Error("Chat unavailable.");
      const snapshot = await fetchChatDetail(token, `${HOSTED_GATEWAY_URL}${computer.gatewayPath}`, chatId);
      // Streamed content may have moved the cache past this snapshot while it
      // was in flight; replacing it would rewind the text on screen.
      const cached = queryClient.getQueryData<CanonicalChatDetailResponse>(detailQueryKey);
      return cached && cached.record.chat.revision > snapshot.record.chat.revision ? cached : snapshot;
    },
    refetchInterval: ({ state }) => activeRunPollInterval(state.data, streamLive),
    refetchIntervalInBackground: false,
  });

  return {
    computer,
    detail: detail.data ?? null,
    isPending: authEnabled && Boolean(chatId) && (
      activeComputer.isPending || detail.isPending
    ),
    isError: activeComputer.isError || detail.isError,
    refresh: () => queryClient.invalidateQueries({ queryKey: detailQueryKey }),
  };
}
