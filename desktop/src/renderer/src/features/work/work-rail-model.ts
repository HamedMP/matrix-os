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
