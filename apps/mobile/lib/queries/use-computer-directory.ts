import { useMemo } from "react";
import { useAuth } from "@clerk/clerk-expo";
import { useQuery } from "@tanstack/react-query";

import {
  fetchActiveComputer,
  fetchFileList,
  mobileQueryKeys,
} from "@/lib/requests";
import { HOSTED_GATEWAY_URL } from "@/lib/storage";

export function useComputerDirectory(path: string) {
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
  const directory = useQuery({
    queryKey: mobileQueryKeys.files(userId ?? "signed-out", computerKey, path),
    enabled: authEnabled && Boolean(computer),
    queryFn: async () => {
      const token = await getToken();
      if (!token || !computer) throw new Error("Files unavailable.");
      return fetchFileList(token, `${HOSTED_GATEWAY_URL}${computer.gatewayPath}`, path);
    },
  });
  const entries = useMemo(
    () => [...(directory.data?.entries ?? [])].sort((left, right) => {
      if (left.type !== right.type) return left.type === "directory" ? -1 : 1;
      return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
    }),
    [directory.data?.entries],
  );

  return {
    computer,
    entries,
    isPending: authEnabled && (
      activeComputer.isPending
      || (Boolean(computer) && directory.isPending)
    ),
    isError: activeComputer.isError || directory.isError,
  };
}
