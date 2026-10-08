import type { ChatAgent, ChatAgentListResponse } from "@matrix-os/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useActiveGateway } from "@/lib/queries/use-active-gateway";
import {
  AgentRequestError,
  archiveAgent,
  ensureAgentDirectChat,
  fetchAgents,
  mobileQueryKeys,
} from "@/lib/requests";

const NO_AGENTS: ChatAgent[] = [];

/** The saved agents of the active computer; archived ones are not listed. */
export function useAgents() {
  const gateway = useActiveGateway();
  const library = useQuery({
    queryKey: mobileQueryKeys.agents(gateway.userId, gateway.computerKey),
    enabled: gateway.ready,
    queryFn: async () => {
      const session = await gateway.session();
      if (!session) throw new Error("Agents unavailable.");
      return fetchAgents(session.token, session.gatewayUrl);
    },
  });

  return {
    agents: library.data?.agents ?? NO_AGENTS,
    /** False when agents are switched off on this computer; null until that is known. */
    agentsEnabled: library.data?.enabled ?? null,
    isPending: gateway.authEnabled && (gateway.isComputerPending || (gateway.ready && library.isPending)),
    isError: gateway.isComputerError || library.isError,
    /** Reads the list again, as a screen does when it regains focus. */
    refetch: () => library.refetch(),
  };
}

/**
 * Resolves to the id of the agent's own chat, creating the chat when the agent
 * has none. Rejects with an `AgentRequestError`.
 */
export function useEnsureAgentChat() {
  const queryClient = useQueryClient();
  const gateway = useActiveGateway();
  const chatsKey = mobileQueryKeys.canonicalChats(gateway.userId, gateway.computerKey);

  return useMutation({
    mutationFn: async (agentId: string) => {
      const session = await gateway.session();
      if (!session) throw new AgentRequestError("unavailable");
      return ensureAgentDirectChat(session.token, session.gatewayUrl, agentId);
    },
    // The chat may have just been created, and then the chat list has gained one.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: chatsKey });
    },
  });
}

/**
 * Archives an agent under the revision the screen loaded. When that revision
 * is no longer current this rejects with an `AgentRequestError` whose reason
 * is `conflict`; the list is read again, so a retry uses the new revision.
 */
export function useArchiveAgent() {
  const queryClient = useQueryClient();
  const gateway = useActiveGateway();
  const agentsKey = mobileQueryKeys.agents(gateway.userId, gateway.computerKey);

  return useMutation({
    mutationFn: async ({ agentId, baseRevision }: { agentId: string; baseRevision: number }) => {
      const session = await gateway.session();
      if (!session) throw new AgentRequestError("unavailable");
      return archiveAgent(session.token, session.gatewayUrl, agentId, baseRevision);
    },
    // A list read still in flight was sent before this request, so its answer
    // would put the agent back after the server has archived it.
    onMutate: () => queryClient.cancelQueries({ queryKey: agentsKey }),
    // The agent leaves the list only once the server has confirmed it.
    onSuccess: (archived: ChatAgent) => {
      queryClient.setQueryData<ChatAgentListResponse>(agentsKey, (library) => library && {
        ...library,
        agents: library.agents.filter((agent) => agent.id !== archived.id),
      });
    },
    // Read again either way: a refusal means the list on screen was out of
    // date. Not awaited, so the button is released as soon as the request is.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: agentsKey });
    },
  });
}
