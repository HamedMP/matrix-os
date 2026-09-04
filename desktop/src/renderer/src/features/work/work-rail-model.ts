import type { CanonicalChatRecord } from "@matrix-os/contracts";
import type { Project } from "../../stores/board";

export interface WorkRailProjectGroup {
  id: string;
  slug: string;
  name: string;
  project: Project;
  chats: CanonicalChatRecord[];
}

export interface WorkRailModel {
  pinned: CanonicalChatRecord[];
  projects: WorkRailProjectGroup[];
  recents: CanonicalChatRecord[];
}

export interface WorkRailSearchResult {
  record: CanonicalChatRecord;
  project?: Project;
  contextLabel: string;
}

const MAX_WORK_RAIL_SEARCH_RESULTS = 50;

function providerLabel(driverKind: string): string {
  return driverKind
    .split("_")
    .map((part) => `${part.charAt(0).toLocaleUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function buildWorkRailSearchResults(
  records: readonly CanonicalChatRecord[],
  projects: readonly Project[],
  query: string,
): WorkRailSearchResult[] {
  const projectByReference = new Map<string, Project>();
  for (const project of projects) {
    projectByReference.set(project.slug, project);
    if (project.id) projectByReference.set(project.id, project);
  }
  const normalized = query.trim().toLocaleLowerCase();
  const seen = new Set<string>();
  const results: WorkRailSearchResult[] = [];
  const newestFirst = [...records].sort((left, right) => (
    right.chat.updatedAt.localeCompare(left.chat.updatedAt)
  ));
  for (const record of newestFirst) {
    if (seen.has(record.chat.id)) continue;
    seen.add(record.chat.id);
    const project = record.projectId ? projectByReference.get(record.projectId) : undefined;
    if (record.projectId && !project) continue;
    const driverKind = record.providerBinding?.driverKind;
    const safeSearchText = [
      record.chat.title,
      project?.name,
      project?.slug,
      driverKind,
      driverKind ? providerLabel(driverKind) : undefined,
    ].filter((value): value is string => Boolean(value)).join("\n").toLocaleLowerCase();
    if (normalized && !safeSearchText.includes(normalized)) continue;
    const contextLabel = [
      project?.name ?? "Global",
      driverKind ? providerLabel(driverKind) : undefined,
    ].filter(Boolean).join(" · ");
    results.push({ record, ...(project ? { project } : {}), contextLabel });
    if (results.length === MAX_WORK_RAIL_SEARCH_RESULTS) break;
  }
  const duplicateCounts = new Map<string, number>();
  for (const result of results) {
    const key = `${result.record.chat.title.toLocaleLowerCase()}\0${result.contextLabel}`;
    duplicateCounts.set(key, (duplicateCounts.get(key) ?? 0) + 1);
  }
  return results.map((result) => {
    const key = `${result.record.chat.title.toLocaleLowerCase()}\0${result.contextLabel}`;
    if ((duplicateCounts.get(key) ?? 0) < 2) return result;
    const updatedLabel = `${result.record.chat.updatedAt.slice(0, 19).replace("T", " ")} UTC`;
    const sameTimestampPeers = results.filter((candidate) => (
      `${candidate.record.chat.title.toLocaleLowerCase()}\0${candidate.contextLabel}` === key
      && candidate.record.chat.updatedAt === result.record.chat.updatedAt
    ));
    const collisionLabel = sameTimestampPeers.length > 1
      ? ` · ${sameTimestampPeers.findIndex((candidate) => candidate.record.chat.id === result.record.chat.id) + 1}`
      : "";
    return {
      ...result,
      contextLabel: `${result.contextLabel} · ${updatedLabel}${collisionLabel}`,
    };
  });
}

export type WorkRailAgentState =
  | "approval_required"
  | "input_required"
  | "running"
  | "failed"
  | "unseen_completion"
  | "idle";

export function resolveWorkRailAgentState(record: CanonicalChatRecord): WorkRailAgentState {
  if (record.chat.attention === "approval_required"
    || record.activeRun?.status === "waiting_for_approval") {
    return "approval_required";
  }
  if (record.chat.attention === "input_required"
    || record.activeRun?.status === "waiting_for_input") {
    return "input_required";
  }
  if (record.activeRun) return "running";
  if (record.chat.attention === "failed") return "failed";
  if (record.latestSuccessfulCompletion?.unacknowledged) return "unseen_completion";
  return "idle";
}

export function buildWorkRailModel(
  records: readonly CanonicalChatRecord[],
  projects: readonly Project[],
): WorkRailModel {
  const groups = projects.map((project) => ({
    id: project.id ?? project.slug,
    slug: project.slug,
    name: project.name,
    project,
    chats: [] as CanonicalChatRecord[],
  }));
  const groupByProjectReference = new Map<string, WorkRailProjectGroup>();
  for (const group of groups) {
    groupByProjectReference.set(group.id, group);
    groupByProjectReference.set(group.slug, group);
  }

  const pinned: CanonicalChatRecord[] = [];
  const recents: CanonicalChatRecord[] = [];
  const placed = new Set<string>();
  for (const record of records) {
    if (placed.has(record.chat.id)) continue;
    placed.add(record.chat.id);
    if (record.chat.userState?.pinned) {
      pinned.push(record);
      continue;
    }
    if (record.projectId) {
      groupByProjectReference.get(record.projectId)?.chats.push(record);
      continue;
    }
    recents.push(record);
  }
  return { pinned, projects: groups, recents };
}
