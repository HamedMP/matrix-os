import { useAuth } from "@clerk/clerk-expo";
import { useQuery } from "@tanstack/react-query";

import {
  fetchActiveComputer,
  fetchFilePreview,
  mobileQueryKeys,
} from "@/lib/requests";
import { HOSTED_GATEWAY_URL } from "@/lib/storage";

export function useComputerFilePreview(path: string) {
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
  const preview = useQuery({
    queryKey: mobileQueryKeys.filePreview(userId ?? "signed-out", computerKey, path),
    enabled: authEnabled && Boolean(computer) && Boolean(path),
    gcTime: 0,
    queryFn: async () => {
      const token = await getToken();
      if (!token || !computer) throw new Error("File preview unavailable.");
      return fetchFilePreview(token, `${HOSTED_GATEWAY_URL}${computer.gatewayPath}`, path);
    },
  });

  return {
    preview: preview.data,
    isPending: authEnabled && (
      activeComputer.isPending
      || (Boolean(computer) && preview.isPending)
    ),
    isError: activeComputer.isError || preview.isError,
    refresh: async () => {
      await Promise.all([
        activeComputer.refetch(),
        ...(computer && path ? [preview.refetch()] : []),
      ]);
    },
  };
}
