import type { AgentThreadSummary, RuntimeSummary } from "@matrix-os/contracts";

export type AgentCockpitModel = {
  needsAttention: AgentThreadSummary[];
  working: AgentThreadSummary[];
  recent: AgentThreadSummary[];
};

const RECENT_THREAD_LIMIT = 5;

type AgentCockpitSummary = Pick<RuntimeSummary, "activeThreads" | "attentionThreads">;

function updatedAtMs(thread: AgentThreadSummary): number {
  const timestamp = Date.parse(thread.updatedAt);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function attentionPriority(thread: AgentThreadSummary): number {
  if (thread.attention === "approval_required" || thread.status === "waiting_for_approval") return 0;
  if (thread.attention === "input_required" || thread.status === "waiting_for_input") return 1;
  if (thread.attention === "failed" || thread.status === "failed") return 2;
  return 10;
}

function threadGroup(thread: AgentThreadSummary): keyof AgentCockpitModel {
  switch (thread.attention) {
    case "approval_required":
    case "input_required":
    case "failed":
      return "needsAttention";
    case "completed":
      return "recent";
    case "none":
      break;
  }

  switch (thread.status) {
    case "queued":
    case "starting":
    case "running":
      return "working";
    case "waiting_for_approval":
    case "waiting_for_input":
    case "failed":
      return "needsAttention";
    case "completed":
    case "aborted":
    case "stale":
    case "archived":
      return "recent";
  }
}

export function buildAgentCockpit(summary: AgentCockpitSummary): AgentCockpitModel {
  const threadsById = new Map<string, AgentThreadSummary>();
  for (const thread of summary.activeThreads.items) threadsById.set(thread.id, thread);
  for (const thread of summary.attentionThreads.items) threadsById.set(thread.id, thread);

  const uniqueThreads = [...threadsById.values()];
  const needsAttention = uniqueThreads
    .filter((thread) => threadGroup(thread) === "needsAttention")
    .sort((left, right) => {
      const priority = attentionPriority(left) - attentionPriority(right);
      return priority || updatedAtMs(right) - updatedAtMs(left);
    });
  const working = uniqueThreads
    .filter((thread) => threadGroup(thread) === "working")
    .sort((left, right) => updatedAtMs(right) - updatedAtMs(left));
  const recent = uniqueThreads
    .filter((thread) => threadGroup(thread) === "recent")
    .sort((left, right) => updatedAtMs(right) - updatedAtMs(left))
    .slice(0, RECENT_THREAD_LIMIT);

  return { needsAttention, working, recent };
}
