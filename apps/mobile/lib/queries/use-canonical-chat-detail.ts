import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { useAuth } from "@clerk/clerk-expo";
import { useQuery, useQueryClient, type Query } from "@tanstack/react-query";

import { fetchActiveComputer, fetchChatDetail, mobileQueryKeys } from "@/lib/requests";
import { HOSTED_GATEWAY_URL } from "@/lib/storage";

const ACTIVE_RUN_POLL_MS = 1_200;
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "aborted"]);

/**
 * The event-invalidation WS is the intended live-update path, but polling is
 * a self-contained fallback that works regardless of it: appendAssistantDelta
 * (packages/gateway/src/chat/run-lifecycle-repository.ts) writes each token
 * straight into the pending assistant message's persisted parts, so a plain
 * refetch already observes growing text -- no client-side delta merging
 * needed. Polls only while a run is active, and stops itself once it settles.
 */
function pollWhileRunActive(query: Query<CanonicalChatDetailResponse>): number | false {
  const runs = query.state.data?.runs;
  if (!runs?.some((run) => !TERMINAL_RUN_STATUSES.has(run.status))) return false;
  return ACTIVE_RUN_POLL_MS;
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
      return fetchChatDetail(token, `${HOSTED_GATEWAY_URL}${computer.gatewayPath}`, chatId);
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
