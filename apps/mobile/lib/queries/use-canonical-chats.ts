import { useAuth } from "@clerk/clerk-expo";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { fetchActiveComputer, fetchChats, mobileQueryKeys } from "@/lib/requests";
import { HOSTED_GATEWAY_URL } from "@/lib/storage";

export function useCanonicalChats() {
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
    select: (response) => [...response.items].sort(
      (left, right) => Date.parse(right.chat.updatedAt) - Date.parse(left.chat.updatedAt),
    ),
  });

  return {
    computer,
    chats: chats.data ?? [],
    isPending: authEnabled && (
      activeComputer.isPending
      || (Boolean(computer) && chats.isPending)
    ),
    isError: activeComputer.isError || chats.isError,
    invalidate: () => queryClient.invalidateQueries({ queryKey: chatsQueryKey }),
  };
}
