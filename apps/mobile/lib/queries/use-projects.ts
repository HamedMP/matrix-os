import { useAuth } from "@clerk/clerk-expo";
import { useQuery } from "@tanstack/react-query";

import { fetchActiveComputer, fetchProjects, mobileQueryKeys } from "@/lib/requests";
import { HOSTED_GATEWAY_URL } from "@/lib/storage";

export function useProjects() {
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
  const projects = useQuery({
    queryKey: mobileQueryKeys.projects(userId ?? "signed-out", computerKey),
    enabled: authEnabled && Boolean(computer),
    queryFn: async () => {
      const token = await getToken();
      if (!token || !computer) throw new Error("Projects unavailable.");
      return fetchProjects(token, `${HOSTED_GATEWAY_URL}${computer.gatewayPath}`);
    },
    staleTime: 60_000,
  });

  return {
    projects: projects.data ?? [],
    isPending: authEnabled && (
      activeComputer.isPending
      || (Boolean(computer) && projects.isPending)
    ),
    isError: activeComputer.isError || projects.isError,
  };
}
