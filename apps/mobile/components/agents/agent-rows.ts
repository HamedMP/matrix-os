import type { CanonicalChatRecord, ChatAgent } from "@matrix-os/contracts";

import type { StatusTone } from "@/components/ui";
import {
  AGENT_STATUS_ENTRY_LOADING,
  AGENT_STATUS_IDLE,
  agentNeedsUser,
  type AgentStatusEntry,
} from "@/lib/agent-status";
import { formatRelativeTime } from "@/lib/relative-time";
import { chatActivityAt } from "@/lib/requests/canonical-chat";

/** What one row of the agents list shows. */
export interface AgentListRow {
  id: string;
  name: string;
  /** Decides the mascot's colour. Saved agents have none: the server sends no category. */
  category?: string;
  /** The dot after the name: waiting on the person, working, or none. */
  tone: StatusTone | null;
  subtitle?: string;
  /** When the agent's chat was last active, already worded; empty when unknown. */
  time: string;
}

function toneOf(status: AgentStatusEntry): StatusTone | null {
  if (agentNeedsUser(status)) return "waiting";
  return status.state === "working" ? "active" : null;
}

// These three say nothing about the agent, so its description is shown instead.
function saysNothing(status: AgentStatusEntry): boolean {
  return status.state === "loading"
    || status.state === "unavailable"
    || (status.state === "idle" && status.label === AGENT_STATUS_IDLE.label);
}

/** The rows of the agents list, in the order of `agents`. */
export function agentListRows(
  agents: readonly ChatAgent[],
  statuses: Readonly<Record<string, AgentStatusEntry>>,
  chats: readonly CanonicalChatRecord[],
  now?: Date,
): AgentListRow[] {
  const chatsById: Record<string, CanonicalChatRecord> = Object.fromEntries(
    chats.map((record) => [record.chat.id, record] as const),
  );

  return agents.map((agent) => {
    const status = Object.hasOwn(statuses, agent.id) ? statuses[agent.id] : AGENT_STATUS_ENTRY_LOADING;
    const chat = status.chatId !== null && Object.hasOwn(chatsById, status.chatId) ? chatsById[status.chatId] : null;
    return {
      id: agent.id,
      name: agent.name,
      tone: toneOf(status),
      subtitle: (saysNothing(status) ? agent.description : status.label) || undefined,
      time: chat ? formatRelativeTime(chatActivityAt(chat), now) : "",
    };
  });
}
