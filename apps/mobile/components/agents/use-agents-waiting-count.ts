import { useAgentStatuses } from "@/lib/queries/use-agent-statuses";
import { useAgents } from "@/lib/queries/use-agents";

/**
 * How many agents are waiting on the person: the number on the Agents tab.
 * Shares its reads with the agents list, which refreshes them on focus.
 */
export function useAgentsWaitingCount(): number {
  const { agents } = useAgents();
  return useAgentStatuses(agents).waitingCount;
}
