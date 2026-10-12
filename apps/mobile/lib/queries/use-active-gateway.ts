import { useAuth } from "@clerk/clerk-expo";
import { useQuery } from "@tanstack/react-query";

import { fetchActiveComputer, mobileQueryKeys } from "@/lib/requests";
import { HOSTED_GATEWAY_URL } from "@/lib/storage";

export interface GatewaySession {
  token: string;
  gatewayUrl: string;
}

/**
 * The signed-in account's active computer and how to reach its gateway. Shares
 * the active-computer query with every other hook that reads it.
 */
export function useActiveGateway() {
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
  const computer = activeComputer.data ?? null;
  const gatewayUrl = computer ? `${HOSTED_GATEWAY_URL}${computer.gatewayPath}` : null;

  return {
    authEnabled,
    userId: userId ?? "signed-out",
    computer,
    computerKey: computer ? `${computer.handle}:${computer.runtimeSlot}` : "none",
    gatewayUrl,
    /** Queries of the gateway can run: there is an account and a computer. */
    ready: authEnabled && gatewayUrl !== null,
    isComputerPending: authEnabled && activeComputer.isPending,
    isComputerError: activeComputer.isError,
    /** A fresh token for the computer on screen, or null when either is missing. */
    session: async (): Promise<GatewaySession | null> => {
      const token = await getToken();
      return token && gatewayUrl ? { token, gatewayUrl } : null;
    },
  };
}
