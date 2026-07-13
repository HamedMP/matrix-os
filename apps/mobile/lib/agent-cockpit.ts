import type { AgentThreadSummary, ProjectSummary, RuntimeSummary } from "@matrix-os/contracts";

export type AgentCockpitProjectGroup = {
  projectId: string | null;
  label: string;
  status: ProjectSummary["status"];
  threads: AgentThreadSummary[];
  workingCount: number;
  attentionCount: number;
  latestActivityMs: number;
};

export type AgentCockpitModel = {
  needsAttention: AgentThreadSummary[];
  working: AgentThreadSummary[];
  recent: AgentThreadSummary[];
  projects: AgentCockpitProjectGroup[];
};

type AgentCockpitSummary = Pick<RuntimeSummary, "activeThreads" | "attentionThreads" | "projects">;

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

function isWorkingStatus(thread: AgentThreadSummary): boolean {
  return thread.status === "queued" || thread.status === "starting" || thread.status === "running";
}

export function formatRelativeAge(isoTimestamp: string, nowMs: number): string {
  const timestamp = Date.parse(isoTimestamp);
  if (Number.isNaN(timestamp)) return "";
  const elapsedMs = nowMs - timestamp;
  if (elapsedMs < 60_000) return "now";
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function buildProjectGroups(
  summary: AgentCockpitSummary,
  needsAttention: AgentThreadSummary[],
  groupedThreads: AgentThreadSummary[],
): AgentCockpitProjectGroup[] {
  const attentionIds = new Set(needsAttention.map((thread) => thread.id));
  const attentionByProject = new Map<string | null, number>();
  for (const thread of needsAttention) {
    const key = thread.projectId ?? null;
    attentionByProject.set(key, (attentionByProject.get(key) ?? 0) + 1);
  }

  const groups = new Map<string | null, AgentCockpitProjectGroup>();
  const ensureGroup = (projectId: string | null, label: string, status: ProjectSummary["status"]): AgentCockpitProjectGroup => {
    const existing = groups.get(projectId);
    if (existing) return existing;
    const group: AgentCockpitProjectGroup = {
      projectId,
      label,
      status,
      threads: [],
      workingCount: 0,
      attentionCount: attentionByProject.get(projectId) ?? 0,
      latestActivityMs: 0,
    };
    groups.set(projectId, group);
    return group;
  };

  // Known projects stay visible even with no threads so the cockpit doubles
  // as the project inventory.
  for (const project of summary.projects.items) {
    ensureGroup(project.id, project.label, project.status);
  }

  for (const thread of groupedThreads) {
    if (attentionIds.has(thread.id)) continue;
    const projectId = thread.projectId ?? null;
    const group = ensureGroup(
      projectId,
      projectId === null ? "No project" : projectId,
      "unknown",
    );
    group.threads.push(thread);
    if (isWorkingStatus(thread)) group.workingCount += 1;
    group.latestActivityMs = Math.max(group.latestActivityMs, updatedAtMs(thread));
  }

  for (const group of groups.values()) {
    group.threads.sort((left, right) => {
      const workingOrder = Number(isWorkingStatus(right)) - Number(isWorkingStatus(left));
      return workingOrder || updatedAtMs(right) - updatedAtMs(left);
    });
  }

  return [...groups.values()].sort((left, right) => {
    const leftActive = left.threads.length > 0 || left.attentionCount > 0;
    const rightActive = right.threads.length > 0 || right.attentionCount > 0;
    if (leftActive !== rightActive) return leftActive ? -1 : 1;
    if (leftActive) return right.latestActivityMs - left.latestActivityMs;
    return left.label.localeCompare(right.label);
  });
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
    .sort((left, right) => updatedAtMs(right) - updatedAtMs(left));

  const projects = buildProjectGroups(summary, needsAttention, uniqueThreads);

  return { needsAttention, working, recent, projects };
}
