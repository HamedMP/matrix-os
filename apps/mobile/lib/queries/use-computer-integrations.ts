import { useAuth } from "@clerk/clerk-expo";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createIntegrationConnectUrl,
  deleteIntegrationConnection,
  fetchActiveComputer,
  fetchAvailableIntegrations,
  fetchConnectedIntegrations,
  mobileQueryKeys,
  refreshIntegrationConnection,
  syncIntegrationConnections,
} from "@/lib/requests";
import { HOSTED_GATEWAY_URL } from "@/lib/storage";

export function useComputerIntegrations() {
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
  const integrations = useQuery({
    queryKey: mobileQueryKeys.integrations(userId ?? "signed-out", computerKey),
    enabled: authEnabled && Boolean(computer),
    refetchInterval: 10_000,
    queryFn: async () => {
      const token = await getToken();
      if (!token || !computer) throw new Error("Integrations unavailable. Try again.");
      const gatewayUrl = `${HOSTED_GATEWAY_URL}${computer.gatewayPath}`;
      const [available, connected] = await Promise.all([
        fetchAvailableIntegrations(token, gatewayUrl),
        fetchConnectedIntegrations(token, gatewayUrl),
      ]);
      return { available, connected };
    },
  });
  const integrationQueryKey = mobileQueryKeys.integrations(userId ?? "signed-out", computerKey);
  const refreshMutation = useMutation({
    mutationFn: async (connectionId: string) => {
      const token = await getToken();
      if (!token || !computer) throw new Error("Could not refresh connection. Try again.");
      await refreshIntegrationConnection(
        token,
        `${HOSTED_GATEWAY_URL}${computer.gatewayPath}`,
        connectionId,
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: integrationQueryKey });
    },
  });
  const deleteMutation = useMutation({
    mutationFn: async (connectionId: string) => {
      const token = await getToken();
      if (!token || !computer) throw new Error("Could not delete connection. Try again.");
      await deleteIntegrationConnection(
        token,
        `${HOSTED_GATEWAY_URL}${computer.gatewayPath}`,
        connectionId,
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: integrationQueryKey });
    },
  });
  const startConnectionMutation = useMutation({
    mutationFn: async (serviceId: string) => {
      const token = await getToken();
      if (!token || !computer) throw new Error("Could not start connection. Try again.");
      return createIntegrationConnectUrl(
        token,
        `${HOSTED_GATEWAY_URL}${computer.gatewayPath}`,
        serviceId,
      );
    },
  });
  const syncMutation = useMutation({
    mutationFn: async () => {
      const token = await getToken();
      if (!token || !computer) throw new Error("Could not sync connections. Try again.");
      await syncIntegrationConnections(
        token,
        `${HOSTED_GATEWAY_URL}${computer.gatewayPath}`,
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: integrationQueryKey });
    },
  });

  return {
    computer,
    available: integrations.data?.available ?? [],
    connected: integrations.data?.connected ?? [],
    isPending: authEnabled && (
      activeComputer.isPending
      || (Boolean(computer) && integrations.isPending)
    ),
    isError: activeComputer.isError || integrations.isError,
    refreshConnection: (connectionId: string) => refreshMutation.mutateAsync(connectionId),
    deleteConnection: (connectionId: string) => deleteMutation.mutateAsync(connectionId),
    startConnection: (serviceId: string) => startConnectionMutation.mutateAsync(serviceId),
    syncConnections: () => syncMutation.mutateAsync(),
    isMutating: refreshMutation.isPending || deleteMutation.isPending,
    refreshingConnectionId: refreshMutation.isPending ? refreshMutation.variables : null,
    deletingConnectionId: deleteMutation.isPending ? deleteMutation.variables : null,
    connectingServiceId: startConnectionMutation.isPending
      ? startConnectionMutation.variables
      : null,
    isSyncing: syncMutation.isPending,
  };
}
