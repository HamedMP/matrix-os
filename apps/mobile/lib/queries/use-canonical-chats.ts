import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import { useAuth } from "@clerk/clerk-expo";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { fetchActiveComputer, fetchChats, mobileQueryKeys } from "@/lib/requests";
import { fetchNativeBotNavigation, type NativeBotNavigation } from "@/lib/requests/bot-navigation";
import { HOSTED_GATEWAY_URL } from "@/lib/storage";

export function useCanonicalChats() {
  const queryClient = useQueryClient();
  const [foreground, setForeground] = useState(AppState.currentState !== "background" && AppState.currentState !== "inactive");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", state => setForeground(state === "active"));
    return () => subscription.remove();
  }, []);
  const { getToken, isLoaded, isSignedIn, userId, sessionId } = useAuth();
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
    select: (response) => response.items,
  });

  const gatewayUrl = computer ? `${HOSTED_GATEWAY_URL}${computer.gatewayPath}` : "none";
  const botNavigationKey = mobileQueryKeys.botNavigation(userId ?? "signed-out", gatewayUrl);
  const recordIds = useMemo(() => (chats.data ?? []).map(record => record.chat.id).sort(), [chats.data]);
  const authority = authEnabled ? JSON.stringify([userId, sessionId, gatewayUrl]) : null;
  const retained = useRef<{ authority: string; client: QueryClient; value: NativeBotNavigation } | null>(null);
  const navigation = useQuery({
    queryKey: [...botNavigationKey, sessionId, recordIds.join(",")],
    enabled: authEnabled && foreground && Boolean(computer) && Boolean(chats.data),
    staleTime: 15_000,
    gcTime: 60_000,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    queryFn: async ({ signal }) => {
      const token = await getToken();
      if (!token) throw new Error("Bot status could not be loaded. Try again.");
      return fetchNativeBotNavigation(token, gatewayUrl, recordIds, signal);
    },
  });
  useLayoutEffect(() => {
    if (retained.current?.authority !== authority || retained.current.client !== queryClient) retained.current = null;
    if (authority && navigation.data) retained.current = {authority, client:queryClient, value:navigation.data};
  }, [authority, navigation.data, queryClient]);
  const projection = navigation.data ?? (retained.current?.authority === authority && retained.current.client === queryClient ? retained.current.value : undefined);
  const ordinaryChats = useMemo(() => {
    const ordinaryIds = new Set(projection?.ordinaryChatIds ?? []);
    return (chats.data ?? []).filter(record => ordinaryIds.has(record.chat.id));
  }, [chats.data, projection]);

  return {
    computer,
    chats: authEnabled ? ordinaryChats : [],
    botConversations: authEnabled ? (projection?.bots ?? []).map(bot => navigation.isError ? {...bot, pendingApprovalCount:0} : bot) : [],
    botStatusUnavailable: navigation.isError || Boolean(navigation.data?.unavailable),
    isPending: authEnabled && (
      activeComputer.isPending
      || (Boolean(computer) && chats.isPending)
      || (Boolean(chats.data) && navigation.isPending && !projection)
    ),
    isError: activeComputer.isError || chats.isError || navigation.isError,
    invalidate: () => Promise.all([
      queryClient.invalidateQueries({ queryKey: chatsQueryKey }),
      queryClient.invalidateQueries({ queryKey: botNavigationKey }),
    ]),
  };
}
