import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { useAuth } from "@clerk/clerk-expo";
import { useQuery, useQueryClient, type Query } from "@tanstack/react-query";

import { fetchActiveComputer, fetchChatDetail, mobileQueryKeys } from "@/lib/requests";
import { HOSTED_GATEWAY_URL } from "@/lib/storage";

// Matches desktop's fallback poll: slow enough to stay out of the stream's way.
const ACTIVE_RUN_POLL_MS = 2_000;
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "aborted"]);

/**
 * Live updates -- streamed text, tool activity -- arrive over the chat event
 * stream and are written straight into this query's cache (see
 * canonical-chat-cache-sync.ts). Polling is only the safety net for when
 * that stream is down: the gateway persists each piece of text as it is
 * generated, so a plain refetch still observes the reply growing. Polls only
 * while a run is active, and stops itself once it settles.
 */
function pollWhileRunActive(query: Query<CanonicalChatDetailResponse>): number | false {
  const runs = query.state.data?.runs;
  const active = runs?.some((run) => !TERMINAL_RUN_STATUSES.has(run.status)) ?? false;
  return active ? ACTIVE_RUN_POLL_MS : false;
}

export function useCanonicalChatDetail(chatId: string | null) {
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
    refetchInterval: pollWhileRunActive,
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
