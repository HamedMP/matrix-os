import { useAuth } from "@clerk/clerk-expo";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createTerminalSession as requestTerminalSessionCreation,
  deleteTerminalSession,
  fetchActiveComputer,
  fetchTerminalSessions,
  mobileQueryKeys,
  renameTerminalSession,
  type TerminalSession,
} from "@/lib/requests";
import {
  SHELL_SESSION_CREATE_ATTEMPTS,
  twoWordShellSessionName,
} from "@/lib/shell-session-names";
import { HOSTED_GATEWAY_URL } from "@/lib/storage";

/** Tab names may repeat, so a name already in the list is only avoided, never refused. */
function nextTerminalSessionName(sessions: readonly TerminalSession[]): string {
  const existingNames = new Set(sessions.map((session) => session.name));
  let name = twoWordShellSessionName();
  for (let attempt = 1; attempt < SHELL_SESSION_CREATE_ATTEMPTS && existingNames.has(name); attempt += 1) {
    name = twoWordShellSessionName();
  }
  return name;
}

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
  const createMutation = useMutation({
    mutationFn: async () => {
      const token = await getToken();
      if (!token || !computer) throw new Error("Could not create terminal. Try again.");
      return requestTerminalSessionCreation(
        token,
        `${HOSTED_GATEWAY_URL}${computer.gatewayPath}`,
        nextTerminalSessionName(terminals.data ?? []),
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: terminalQueryKey });
    },
  });
  const renameMutation = useMutation({
    mutationFn: async ({ session, nextName }: { session: TerminalSession; nextName: string }) => {
      const token = await getToken();
      if (!token || !computer) throw new Error("Could not rename terminal. Try again.");
      await renameTerminalSession(
        token,
        `${HOSTED_GATEWAY_URL}${computer.gatewayPath}`,
        session,
        nextName,
      );
    },
    // A refused rename usually means the row's revision is out of date, so the
    // list is reloaded either way and the next attempt sends the current one.
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: terminalQueryKey });
    },
  });
  const deleteMutation = useMutation({
    mutationFn: async (session: TerminalSession) => {
      const token = await getToken();
      if (!token || !computer) throw new Error("Could not delete terminal. Try again.");
      await deleteTerminalSession(token, `${HOSTED_GATEWAY_URL}${computer.gatewayPath}`, session);
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
    // A failed background refresh keeps the last list on screen; only a list
    // that never loaded is reported as unavailable.
    isError: activeComputer.isLoadingError || terminals.isLoadingError,
    createSession: () => createMutation.mutateAsync(),
    renameSession: (session: TerminalSession, nextName: string) => (
      renameMutation.mutateAsync({ session, nextName })
    ),
    deleteSession: (session: TerminalSession) => deleteMutation.mutateAsync(session),
    isMutating: createMutation.isPending || renameMutation.isPending || deleteMutation.isPending,
    refresh: async () => {
      await Promise.all([
        activeComputer.refetch(),
        ...(computer ? [terminals.refetch()] : []),
      ]);
    },
  };
}
