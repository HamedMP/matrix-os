import type { ChatAgent } from "@matrix-os/contracts";
import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import {
  AGENT_STATUS_ENTRY_LOADING,
  AGENT_STATUS_ENTRY_UNAVAILABLE,
  MAX_AGENT_STATUSES,
  agentNeedsUser,
  readAgentStatuses,
  type AgentStatusEntry,
} from "@/lib/agent-status";
import { useActiveGateway } from "@/lib/queries/use-active-gateway";
import {
  fetchAgentDirectChat,
  fetchAgentInteractions,
  fetchAgentTasks,
  mobileQueryKeys,
} from "@/lib/requests";

const STATUS_UNAVAILABLE_ERROR = "Agent status unavailable.";

/**
 * A status for each of `agents`, derived as the web does it: from the agent's
 * own chat, that chat's unfinished tasks and its pending interactions. Never
 * more than four requests are in flight. There is no timer: a screen reads
 * again with `refetch` when it regains focus.
 *
 * An agent whose reads fail, or that was not made from a template (those have
 * no task or interaction reads), is "unavailable"; nothing here throws.
 */
export function useAgentStatuses(agents: readonly ChatAgent[]) {
  const gateway = useActiveGateway();
  const { session } = gateway;
  // Which agents, and whether each is from a template: all that decides what is read.
  const agentIds = agents
    .slice(0, MAX_AGENT_STATUSES)
    .map((agent) => `${agent.id}${agent.recipeRef ? "" : "!"}`)
    .join(",");
  const enabled = gateway.ready && agents.length > 0;
  const query = useQuery({
    queryKey: mobileQueryKeys.agentStatuses(gateway.userId, gateway.computerKey, agentIds),
    enabled,
    queryFn: ({ signal }) => {
      // A token is asked for per read: reading a long list outlasts one token.
      const authorized = async <T,>(read: (token: string, gatewayUrl: string) => Promise<T>): Promise<T> => {
        const current = await session();
        if (!current) throw new Error(STATUS_UNAVAILABLE_ERROR);
        return read(current.token, current.gatewayUrl);
      };
      return readAgentStatuses(agents, {
        directChat: (agentId) => authorized((token, gatewayUrl) => fetchAgentDirectChat(token, gatewayUrl, agentId)),
        tasks: (chatId) => authorized((token, gatewayUrl) => fetchAgentTasks(token, gatewayUrl, chatId)),
        interactions: (chatId) => authorized((token, gatewayUrl) => fetchAgentInteractions(token, gatewayUrl, chatId)),
      }, { signal });
    },
    // A list that gained or lost an agent keeps the statuses already known
    // while it is read again.
    placeholderData: keepPreviousData,
  });
  const known = query.data;
  // Without an account or a reachable computer nothing can be read at all.
  const unreadable = !gateway.authEnabled || gateway.isComputerError || (enabled && query.isError);
  const missing = unreadable ? AGENT_STATUS_ENTRY_UNAVAILABLE : AGENT_STATUS_ENTRY_LOADING;
  const settled = enabled && !query.isFetching;

  const statuses = useMemo(() => {
    const byAgent: Record<string, AgentStatusEntry> = {};
    for (const agent of agents) {
      // An agent the finished read did not answer for is past the hundredth.
      byAgent[agent.id] = known?.[agent.id] ?? (settled ? AGENT_STATUS_ENTRY_UNAVAILABLE : missing);
    }
    return byAgent;
  }, [agents, known, missing, settled]);
  const waitingCount = useMemo(
    () => Object.values(statuses).filter(agentNeedsUser).length,
    [statuses],
  );

  return {
    /** By agent id. Each entry also carries the agent's chat id and last activity time when the reads provide them. */
    statuses,
    /** How many agents are waiting on the person. */
    waitingCount,
    isPending: agents.length > 0 && gateway.authEnabled && (gateway.isComputerPending || (enabled && query.isPending)),
    refetch: () => query.refetch(),
  };
}
