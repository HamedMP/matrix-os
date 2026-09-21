import { z } from "zod/v4";
import { canonicalReferenceId, canonicalSafeErrorText } from "#canonical-chat-primitives";

/** Observed child evidence, not a routable provider thread or execution authority. */
export const ChatSubagentSchema = z.object({
  agentId: canonicalReferenceId(128),
  parentAgentId: canonicalReferenceId(128),
  name: canonicalSafeErrorText(120, 480),
  role: canonicalSafeErrorText(80, 320).optional(),
  status: z.enum(["running", "waiting", "completed", "failed", "cancelled", "unknown"]),
  activity: canonicalSafeErrorText(120, 480).optional(),
  parentName: canonicalSafeErrorText(120, 480).optional(),
  task: canonicalSafeErrorText(1_000, 4_000).optional(),
  result: canonicalSafeErrorText(2_000, 8_000).optional(),
}).strict();

export type ChatSubagent = z.infer<typeof ChatSubagentSchema>;

/** Parent completion is not proof of child completion. Replayed unresolved work is unknown. */
export function projectChatSubagent(agent: ChatSubagent, runStatus: string): ChatSubagent {
  return ["completed", "failed", "aborted"].includes(runStatus) && ["running", "waiting"].includes(agent.status)
    ? { ...agent, status: "unknown", activity: undefined } : agent;
}

const STATUS: Record<ChatSubagent["status"], string> = {
  running: "Working", waiting: "Waiting", completed: "Completed", failed: "Failed",
  cancelled: "Stopped", unknown: "Status unavailable",
};

const ROLE_ICONS = new Map<string, "search" | "code" | "review">([
  ["explorer", "search"], ["research", "search"], ["researcher", "search"],
  ["worker", "code"], ["implementer", "code"], ["reviewer", "review"],
]); // Fixed six-entry vocabulary; custom roles use the generic icon.

export function chatSubagentPresentation(agent: ChatSubagent) {
  return {
    icon: ROLE_ICONS.get(agent.role?.toLowerCase() ?? "") ?? "agent",
    role: agent.role ?? "Subagent",
    status: STATUS[agent.status],
    label: `${agent.name} · ${STATUS[agent.status]}`,
    parent: `Parent agent${agent.parentName ? ` · ${agent.parentName}` : ""} · Delegated task`,
    empty: "No task details available.",
    sections: [
      ...(agent.role ? [{ title: "Type", text: agent.role }] : []),
      ...(agent.activity ? [{ title: "Activity", text: agent.activity }] : []),
      ...(agent.task ? [{ title: "Task", text: agent.task }] : []),
      ...(agent.result ? [{ title: "Result", text: agent.result }] : []),
    ],
  };
}
