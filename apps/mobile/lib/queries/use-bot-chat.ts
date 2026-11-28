import { useAuth } from "@clerk/clerk-expo";
import { useQuery } from "@tanstack/react-query";
import { useCanonicalChatSession } from "@/lib/canonical-chat-session-context";
import { updateNativeBotModel, fetchNativeBotChat, mutateNativeBotMemory, resolveNativeBotInteraction, revokeNativeBotGrant, type NativeBotChatSnapshot } from "@/lib/requests/bots";
import type { CanonicalChatModelSelection, BotMemoryMutationRequest, ResolveBotInteractionRequest } from "@matrix-os/contracts";
import { mobileQueryKeys } from "@/lib/requests";

const REFRESH_INTERVAL_MS = 15_000;
// The event stream reports a bot's interactions, tasks and access as they
// change, so while it is up polling only has to catch what it might miss.
const LIVE_STREAM_REFRESH_INTERVAL_MS = 60_000;

/**
 * Only a bot's own chat has status worth polling. Most chats have no bot
 * (`null`), and one whose status failed to load is retried by the next chat
 * event or refresh rather than on a timer.
 */
export function botChatRefetchInterval(
  snapshot: NativeBotChatSnapshot | null | undefined,
  streamLive: boolean,
): number | false {
  if (!snapshot) return false;
  return streamLive ? LIVE_STREAM_REFRESH_INTERVAL_MS : REFRESH_INTERVAL_MS;
}

export function useBotChat(chatId: string | null, gatewayUrl: string | null) {
  const { streamLive } = useCanonicalChatSession();
  const { getToken, isLoaded, isSignedIn, userId } = useAuth();
  const enabled = Boolean(isLoaded && isSignedIn && userId && chatId && gatewayUrl);
  const query = useQuery({
    queryKey: mobileQueryKeys.botChat(userId ?? "signed-out", gatewayUrl ?? "none", chatId ?? "none"),
    enabled,
    queryFn: async () => {
      if (!chatId || !gatewayUrl) throw new Error("Bot status could not be loaded. Try again.");
      return fetchNativeBotChat(getToken, gatewayUrl, chatId);
    },
    refetchInterval: ({ state }) => botChatRefetchInterval(state.data, streamLive),
    refetchIntervalInBackground: false,
  });
  const requireActionContext = () => {
    if (!enabled || !chatId || !gatewayUrl || !query.data) throw new Error("Bot action unavailable. Try again.");
    return { requestToken: getToken, gatewayUrl, chatId, agentId: query.data.agentId };
  };
  return {
    resolved: enabled && query.isSuccess,
    snapshot: query.data ?? null,
    isError: query.isError,
    refresh: async () => {
      const result = await query.refetch();
      if (result.isError) throw new Error("Bot status could not be loaded. Try again.");
    },
    updateModel: async (selection: CanonicalChatModelSelection) => {
      const auth = requireActionContext();
      const revision = query.data?.revision;
      if (!revision) throw new Error("Bot model could not be loaded. Refresh and try again.");
      await updateNativeBotModel(auth.requestToken, auth.gatewayUrl, auth.agentId, revision, selection);
    },
    resolve: async (interactionId: string, input: ResolveBotInteractionRequest) => {
      const auth = requireActionContext();
      return resolveNativeBotInteraction(auth.requestToken, auth.gatewayUrl, auth.chatId, interactionId, input);
    },
    revoke: async (grantId: string) => {
      const auth = requireActionContext();
      await revokeNativeBotGrant(auth.requestToken, auth.gatewayUrl, auth.agentId, grantId);
    },
    memory: async (itemId: string, action: "confirm" | "forget", input: BotMemoryMutationRequest) => {
      const auth = requireActionContext();
      await mutateNativeBotMemory(auth.requestToken, auth.gatewayUrl, auth.agentId, itemId, action, input);
    },
  };
}
