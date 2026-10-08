import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";

import { AgentsListScreen } from "@/components/agents/AgentsListScreen";
import { agentListRows } from "@/components/agents/agent-rows";
import { useCanonicalChatSession } from "@/lib/canonical-chat-session-context";
import { useAgentStatuses } from "@/lib/queries/use-agent-statuses";
import { useAgents, useEnsureAgentChat } from "@/lib/queries/use-agents";
import { useCanonicalChats } from "@/lib/queries/use-canonical-chats";
import { useShowChatScreen } from "@/lib/use-shell-navigation";

export default function AgentsScreen() {
  const router = useRouter();
  const { selectChat } = useCanonicalChatSession();
  const showChatScreen = useShowChatScreen();
  const library = useAgents();
  const { statuses, refetch: refetchStatuses } = useAgentStatuses(library.agents);
  const { chats } = useCanonicalChats();
  const ensureChat = useEnsureAgentChat();
  const [refreshing, setRefreshing] = useState(false);
  const opening = useRef(false);
  const shownBefore = useRef(false);

  const rows = useMemo(
    () => agentListRows(library.agents, statuses, chats),
    [library.agents, statuses, chats],
  );

  const reload = async () => {
    try {
      await Promise.all([
        // A first read still on its way is left to finish.
        library.isPending ? null : library.refetch(),
        library.agents.length > 0 ? refetchStatuses() : null,
      ]);
    } catch (error: unknown) {
      console.warn("[mobile] agents reload failed", error instanceof Error ? error.name : "unknown");
    }
  };
  const reloadRef = useRef(reload);
  useEffect(() => {
    reloadRef.current = reload;
  });

  useFocusEffect(
    useCallback(() => {
      // The queries read on their own when the screen is first shown.
      if (!shownBefore.current) {
        shownBefore.current = true;
        return;
      }
      void reloadRef.current();
    }, []),
  );

  const refresh = async () => {
    setRefreshing(true);
    try {
      await reload();
    } finally {
      setRefreshing(false);
    }
  };

  const openAgent = async (agentId: string) => {
    if (opening.current) return;
    opening.current = true;
    try {
      const chatId = await ensureChat.mutateAsync(agentId);
      selectChat(chatId);
      showChatScreen();
    } catch (error: unknown) {
      console.warn("[mobile] agent chat unavailable", error instanceof Error ? error.name : "unknown");
      Alert.alert("Agent could not be opened", "Try again.");
    } finally {
      opening.current = false;
    }
  };

  const unavailable = library.agentsEnabled === false || (library.isError && library.agents.length === 0);

  return (
    <AgentsListScreen
      state={library.isPending ? "loading" : unavailable ? "unavailable" : "ready"}
      rows={rows}
      refreshing={refreshing}
      onRefresh={() => void refresh()}
      onRetry={() => void reload()}
      onNewAgent={() => router.push("/agents/new" as never)}
      onOpenAgent={(agentId) => void openAgent(agentId)}
    />
  );
}
