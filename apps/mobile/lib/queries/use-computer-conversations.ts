import { useAuth } from "@clerk/clerk-expo";
import { useQuery } from "@tanstack/react-query";

import { fetchActiveComputer, fetchConversations, mobileQueryKeys } from "@/lib/requests";
import { HOSTED_GATEWAY_URL } from "@/lib/storage";

export function useComputerConversations() {
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
  const conversations = useQuery({
    queryKey: mobileQueryKeys.conversations(userId ?? "signed-out", computerKey),
    enabled: authEnabled && Boolean(computer),
    queryFn: async () => {
      const token = await getToken();
      if (!token || !computer) throw new Error("Chats unavailable.");
      return fetchConversations(token, `${HOSTED_GATEWAY_URL}${computer.gatewayPath}`);
    },
    select: (items) => [...items].sort((left, right) => right.updatedAt - left.updatedAt),
  });

  return {
    computer,
    conversations: conversations.data ?? [],
    isPending: authEnabled && (
      activeComputer.isPending
      || (Boolean(computer) && conversations.isPending)
    ),
    isError: activeComputer.isError || conversations.isError,
    refresh: async () => {
      await Promise.all([
        activeComputer.refetch(),
        ...(computer ? [conversations.refetch()] : []),
      ]);
    },
  };
}
