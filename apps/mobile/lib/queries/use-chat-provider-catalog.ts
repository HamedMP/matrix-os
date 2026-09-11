import { useAuth } from "@clerk/clerk-expo";
import { useQuery } from "@tanstack/react-query";

import { fetchActiveComputer, fetchChatProviderCatalog, mobileQueryKeys } from "@/lib/requests";
import { HOSTED_GATEWAY_URL } from "@/lib/storage";

export function useChatProviderCatalog() {
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
  const catalog = useQuery({
    queryKey: mobileQueryKeys.chatProviderCatalog(userId ?? "signed-out", computerKey),
    enabled: authEnabled && Boolean(computer),
    queryFn: async () => {
      const token = await getToken();
      if (!token || !computer) throw new Error("Models unavailable.");
      return fetchChatProviderCatalog(token, `${HOSTED_GATEWAY_URL}${computer.gatewayPath}`);
    },
    staleTime: 60_000,
  });

  return {
    catalog: catalog.data ?? null,
    isPending: authEnabled && (
      activeComputer.isPending
      || (Boolean(computer) && catalog.isPending)
    ),
    isError: activeComputer.isError || catalog.isError,
  };
}
