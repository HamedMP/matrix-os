import { useAuth } from "@clerk/clerk-expo";
import { useQuery } from "@tanstack/react-query";
import {
  BotStatusUnsupportedError, updateNativeBotModel, fetchNativeBotChat, mutateNativeBotMemory, resolveNativeBotInteraction,
  revokeNativeBotGrant, type NativeBotChatSnapshot,
} from "@/lib/requests/bots";
import type { CanonicalChatModelSelection, BotMemoryMutationRequest, ResolveBotInteractionRequest } from "@matrix-os/contracts";
import { mobileQueryKeys } from "@/lib/requests";

const REFRESH_INTERVAL_MS = 15_000;
// A missing route may only mean the gateway is still starting. Looking again
// is cheap, but a computer that really has no such route should not be asked
// at the pace a bot's own status needs.
const UNSUPPORTED_RECHECK_MS = 60_000;

interface BotStatusState {
  data: NativeBotChatSnapshot | null | undefined;
  error: unknown;
}

/**
 * What is known about whether a chat belongs to a bot. What has been read
 * decides, not how the latest read went: a chat does not stop being a bot's,
 * or become one, because a later request failed.
 * - `bot`: it does, and its status is held.
 * - `ordinary`: the computer answered that it does not. That is fixed when a
 *   chat is created, so there is nothing further to read.
 * - `unsupported`: nothing is held and the computer has no bot-status route.
 * - `unknown`: nothing is held because it was not read yet or the read failed.
 */
export function botStatusKnowledge(state: BotStatusState | undefined): "bot" | "ordinary" | "unsupported" | "unknown" {
  if (state?.data) return "bot";
  if (state?.data === null) return "ordinary";
  return state?.error instanceof BotStatusUnsupportedError ? "unsupported" : "unknown";
}

/** How soon to read a chat's bot status again, or false when there is nothing to keep fresh. */
export function botStatusRefetchInterval(state: BotStatusState | undefined): number | false {
  const knowledge = botStatusKnowledge(state);
  if (knowledge === "ordinary") return false;
  return knowledge === "unsupported" ? UNSUPPORTED_RECHECK_MS : REFRESH_INTERVAL_MS;
}

export function useBotChat(chatId: string | null, gatewayUrl: string | null) {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth();
  const enabled = Boolean(isLoaded && isSignedIn && userId && chatId && gatewayUrl);
  const query = useQuery({
    queryKey: mobileQueryKeys.botChat(userId ?? "signed-out", gatewayUrl ?? "none", chatId ?? "none"),
    enabled,
    queryFn: async () => {
      const token = await getToken();
      if (!token || !chatId || !gatewayUrl) throw new Error("Bot status could not be loaded. Try again.");
      return fetchNativeBotChat(token, gatewayUrl, chatId);
    },
    // Asking a computer without the route a second time gets the same answer.
    retry: (failures, error) => !(error instanceof BotStatusUnsupportedError) && failures < 1,
    // An ordinary chat's answer never goes stale, so reopening it reads nothing.
    staleTime: (current) => (botStatusKnowledge(current.state) === "ordinary" ? Infinity : 0),
    refetchInterval: (current) => botStatusRefetchInterval(current.state),
    refetchIntervalInBackground: false,
  });
  // A failed read is only worth reporting for a bot's chat, or one that might
  // be: an ordinary chat, and any chat on a computer without the route, has no
  // bot status to miss.
  const knowledge = botStatusKnowledge(query);
  const requireAuth = async () => {
    const token = await getToken();
    if (!token || !chatId || !gatewayUrl || !query.data) throw new Error("Bot action unavailable. Try again.");
    return { token, gatewayUrl, chatId, agentId: query.data.agentId };
  };
  return {
    snapshot: query.data ?? null,
    isError: query.isError && (knowledge === "bot" || knowledge === "unknown"),
    refresh: async () => {
      const result = await query.refetch();
      if (result.isError) throw new Error("Bot status could not be loaded. Try again.");
    },
    updateModel: async (selection: CanonicalChatModelSelection) => {
      const auth = await requireAuth();
      const revision = query.data?.revision;
      if (!revision) throw new Error("Bot model could not be loaded. Refresh and try again.");
      await updateNativeBotModel(auth.token, auth.gatewayUrl, auth.agentId, revision, selection);
    },
    resolve: async (interactionId: string, input: ResolveBotInteractionRequest) => {
      const auth = await requireAuth();
      return resolveNativeBotInteraction(auth.token, auth.gatewayUrl, auth.chatId, interactionId, input);
    },
    revoke: async (grantId: string) => {
      const auth = await requireAuth();
      await revokeNativeBotGrant(auth.token, auth.gatewayUrl, auth.agentId, grantId);
    },
    memory: async (itemId: string, action: "confirm" | "forget", input: BotMemoryMutationRequest) => {
      const auth = await requireAuth();
      await mutateNativeBotMemory(auth.token, auth.gatewayUrl, auth.agentId, itemId, action, input);
    },
  };
}
