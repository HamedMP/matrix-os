import type { AgentThreadSummary, RuntimeSummary } from "@matrix-os/contracts";

export type AgentCockpitModel = {
  needsAttention: AgentThreadSummary[];
  working: AgentThreadSummary[];
};

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

function needsAction(thread: AgentThreadSummary): boolean {
  return attentionPriority(thread) < 10;
}

function isWorking(thread: AgentThreadSummary): boolean {
  return thread.status === "queued" || thread.status === "starting" || thread.status === "running";
}

export function buildAgentCockpit(summary: AgentCockpitSummary): AgentCockpitModel {
  const threadsById = new Map<string, AgentThreadSummary>();
  for (const thread of summary.activeThreads.items) threadsById.set(thread.id, thread);
  for (const thread of summary.attentionThreads.items) threadsById.set(thread.id, thread);

  const uniqueThreads = [...threadsById.values()];
  const needsAttention = uniqueThreads
    .filter(needsAction)
    .sort((left, right) => {
      const priority = attentionPriority(left) - attentionPriority(right);
      return priority || updatedAtMs(right) - updatedAtMs(left);
    });
  const attentionIds = new Set(needsAttention.map((thread) => thread.id));
  const working = summary.activeThreads.items
    .filter((thread, index, items) => items.findIndex((candidate) => candidate.id === thread.id) === index)
    .filter((thread) => !attentionIds.has(thread.id) && isWorking(thread))
    .sort((left, right) => updatedAtMs(right) - updatedAtMs(left));

  return { needsAttention, working };
}
