import { useAuth } from "@clerk/clerk-expo";
import { useQuery } from "@tanstack/react-query";
import { updateNativeBotModel, fetchNativeBotChat, mutateNativeBotMemory, resolveNativeBotInteraction, revokeNativeBotGrant } from "@/lib/requests/bots";
import type { CanonicalChatModelSelection, BotMemoryMutationRequest, ResolveBotInteractionRequest } from "@matrix-os/contracts";
import { mobileQueryKeys } from "@/lib/requests";

const REFRESH_INTERVAL_MS = 15_000;

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
    refetchInterval: REFRESH_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });
  const requireAuth = async () => {
    const token = await getToken();
    if (!token || !chatId || !gatewayUrl || !query.data) throw new Error("Bot action unavailable. Try again.");
    return { token, gatewayUrl, chatId, agentId: query.data.agentId };
  };
  return {
    snapshot: query.data ?? null,
    isError: query.isError,
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
