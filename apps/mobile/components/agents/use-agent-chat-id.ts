import { useEffect, useState } from "react";

import { useActiveGateway } from "@/lib/queries/use-active-gateway";
import { useEnsureAgentChat } from "@/lib/queries/use-agents";

/**
 * The id of an agent's own chat. `knownChatId` is the one the agents' statuses
 * already carry; without it the server is asked, which creates the chat when
 * the agent has none yet.
 */
export function useAgentChatId(agentId: string, knownChatId: string | null) {
  const gateway = useActiveGateway();
  const { mutate, data, variables, isError } = useEnsureAgentChat();
  const asked = variables === agentId;
  const found = knownChatId ?? (asked ? data ?? null : null);
  // Kept once found: a later status read that fails must not close the chat.
  const [kept, setKept] = useState<{ agentId: string; chatId: string } | null>(null);
  if (found !== null && (kept?.agentId !== agentId || kept.chatId !== found)) {
    setKept({ agentId, chatId: found });
  }
  const chatId = found ?? (kept?.agentId === agentId ? kept.chatId : null);
  // The server can only be asked once the computer to ask is known.
  const ask = chatId === null && gateway.ready;

  useEffect(() => {
    if (ask) mutate(agentId);
  }, [ask, agentId, mutate]);

  return {
    chatId,
    /** The chat could not be found: the computer or the chat itself is out of reach. */
    failed: chatId === null && (gateway.isComputerError || (asked && isError)),
    retry: () => mutate(agentId),
  };
}
