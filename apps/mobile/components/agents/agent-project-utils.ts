import type { AgentThreadSummary, ProjectAgentWorkspace, RuntimeSummary } from "@matrix-os/contracts";

type RuntimeCapabilityId = RuntimeSummary["capabilities"][number]["id"];

export function countLabel(count: number, label: string): string {
  return `${count} ${label}${count === 1 ? "" : "s"}`;
}

export function taskThreads(
  workspace: Pick<ProjectAgentWorkspace, "taskThreads">,
  taskId: string,
): AgentThreadSummary[] {
  return workspace.taskThreads.items.filter((thread) => thread.taskId === taskId);
}

export function runtimeCapabilityEnabled(
  summary: Pick<RuntimeSummary, "capabilities">,
  id: RuntimeCapabilityId,
): boolean {
  return summary.capabilities.some((capability) => capability.id === id && capability.enabled);
}
