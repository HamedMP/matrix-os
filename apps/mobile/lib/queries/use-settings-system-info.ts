import { useAuth } from "@clerk/clerk-expo";
import { useQuery } from "@tanstack/react-query";

import {
  fetchActiveComputer,
  fetchMobileSystemInfo,
  mobileQueryKeys,
} from "@/lib/requests";
import { HOSTED_GATEWAY_URL } from "@/lib/storage";

export function useSettingsSystemInfo() {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth();
  const enabled = Boolean(isLoaded && isSignedIn && userId);
  const activeComputer = useQuery({
    queryKey: mobileQueryKeys.activeComputer(userId ?? "signed-out"),
    enabled,
    queryFn: async () => {
      const token = await getToken();
      if (!token) throw new Error("System information unavailable.");
      return fetchActiveComputer(token);
    },
  });
  const computer = activeComputer.data;
  const computerKey = computer ? `${computer.handle}:${computer.runtimeSlot}` : "none";
  const systemInfo = useQuery({
    queryKey: mobileQueryKeys.systemInfo(userId ?? "signed-out", computerKey),
    enabled: enabled && Boolean(computer),
    queryFn: async () => {
      const token = await getToken();
      if (!token || !computer) throw new Error("System information unavailable.");
      return fetchMobileSystemInfo(token, `${HOSTED_GATEWAY_URL}${computer.gatewayPath}`);
    },
  });

  return {
    computer,
    systemInfo: systemInfo.data,
    isPending: enabled && (activeComputer.isPending || (Boolean(computer) && systemInfo.isPending)),
    isError: activeComputer.isError || systemInfo.isError,
  };
}
