import { useAuth } from "@clerk/clerk-expo";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  deleteTerminalSession,
  fetchActiveComputer,
  fetchTerminalSessions,
  mobileQueryKeys,
  renameTerminalSession,
} from "@/lib/requests";
import { HOSTED_GATEWAY_URL } from "@/lib/storage";

export function useComputerTerminals() {
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
  const terminals = useQuery({
    queryKey: mobileQueryKeys.terminals(userId ?? "signed-out", computerKey),
    enabled: authEnabled && Boolean(computer),
    refetchInterval: 5_000,
    queryFn: async () => {
      const token = await getToken();
      if (!token || !computer) throw new Error("Terminals unavailable.");
      return fetchTerminalSessions(token, `${HOSTED_GATEWAY_URL}${computer.gatewayPath}`);
    },
  });
  const terminalQueryKey = mobileQueryKeys.terminals(userId ?? "signed-out", computerKey);
  const renameMutation = useMutation({
    mutationFn: async ({ currentName, nextName }: { currentName: string; nextName: string }) => {
      const token = await getToken();
      if (!token || !computer) throw new Error("Could not rename terminal. Try again.");
      await renameTerminalSession(
        token,
        `${HOSTED_GATEWAY_URL}${computer.gatewayPath}`,
        currentName,
        nextName,
      );
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: terminalQueryKey });
    },
  });
  const deleteMutation = useMutation({
    mutationFn: async (name: string) => {
      const token = await getToken();
      if (!token || !computer) throw new Error("Could not delete terminal. Try again.");
      await deleteTerminalSession(token, `${HOSTED_GATEWAY_URL}${computer.gatewayPath}`, name);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: terminalQueryKey });
    },
  });

  return {
    computer,
    sessions: terminals.data ?? [],
    isPending: authEnabled && (
      activeComputer.isPending
      || (Boolean(computer) && terminals.isPending)
    ),
    isError: activeComputer.isError || terminals.isError,
    renameSession: (currentName: string, nextName: string) => (
      renameMutation.mutateAsync({ currentName, nextName })
    ),
    deleteSession: (name: string) => deleteMutation.mutateAsync(name),
    isMutating: renameMutation.isPending || deleteMutation.isPending,
  };
}
