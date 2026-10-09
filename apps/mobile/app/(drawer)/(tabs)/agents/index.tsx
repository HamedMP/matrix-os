import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFocusEffect, useRouter } from "expo-router";

import { AgentsListScreen } from "@/components/agents/AgentsListScreen";
import { agentListRows } from "@/components/agents/agent-rows";
import { agentChatRoute } from "@/components/agents/agent-routes";
import { useAgentStatuses } from "@/lib/queries/use-agent-statuses";
import { useAgents } from "@/lib/queries/use-agents";
import { useCanonicalChats } from "@/lib/queries/use-canonical-chats";

export default function AgentsScreen() {
  const router = useRouter();
  const library = useAgents();
  const { statuses, refetch: refetchStatuses } = useAgentStatuses(library.agents);
  const { chats } = useCanonicalChats();
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
      opening.current = false;
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

  // One screen per press: a second press before the agent's chat has covered
  // the list would open it twice. The list being shown again allows the next.
  const openAgent = (agentId: string) => {
    if (opening.current) return;
    opening.current = true;
    router.push(agentChatRoute(agentId) as never);
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
      onOpenAgent={openAgent}
    />
  );
}
