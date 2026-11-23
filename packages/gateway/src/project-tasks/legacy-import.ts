/**
 * Mapping from the legacy JSON task files (`~/system/projects/<slug>/tasks/`)
 * to board rows (spec 2699 section 1). The files are owner data and are never
 * modified or removed here.
 */
import { TASK_LIMITS, spreadRanks, type TaskPriority, type TaskStatus } from "@matrix-os/contracts/project-tasks";
import type { createTaskManager, TaskRecord } from "../task-manager.js";
import type { OwnerScope } from "../state-ops.js";
import type { ImportedTask } from "./repository.js";

type LegacyTasks = Pick<ReturnType<typeof createTaskManager>, "listTasks">;
const PAGE = 100;

const STATUS: Record<TaskRecord["status"], TaskStatus> = {
  todo: "todo", running: "in_progress", waiting: "in_progress", blocked: "in_progress", complete: "done", archived: "done",
};

function validIso(value: string | undefined): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** Board rows for legacy tasks, ordered within each status by their old `order`. */
export function mapLegacyTasks(records: readonly TaskRecord[]): ImportedTask[] {
  const mapped = records.map((record) => ({
    record,
    status: STATUS[record.status],
  }));
  const byStatus: Partial<Record<TaskStatus, typeof mapped>> = {};
  for (const entry of mapped) (byStatus[entry.status] ??= []).push(entry);
  const ranks: Record<string, string> = {};
  for (const entries of Object.values(byStatus)) {
    const ordered = [...entries!].sort((a, b) => a.record.order - b.record.order
      || a.record.createdAt.localeCompare(b.record.createdAt) || a.record.id.localeCompare(b.record.id));
    const spread = spreadRanks(ordered.length);
    ordered.forEach((entry, index) => { ranks[entry.record.id] = spread[index]!; });
  }
  return mapped.map(({ record, status }) => {
    const createdAt = validIso(record.createdAt) ?? new Date(0).toISOString();
    return {
      id: record.id,
      title: record.title.trim().slice(0, TASK_LIMITS.title) || "Untitled task",
      description: (record.description ?? "").slice(0, TASK_LIMITS.description),
      status,
      priority: record.priority as TaskPriority,
      labels: record.status === "blocked" ? ["blocked"] : [],
      parentTaskId: record.parentTaskId ?? null,
      dueAt: validIso(record.dueAt),
      worktreeId: record.linkedWorktreeId ?? null,
      legacySessionId: record.linkedSessionId ?? null,
      createdAt,
      updatedAt: validIso(record.updatedAt) ?? createdAt,
      archivedAt: record.status === "archived" ? validIso(record.archivedAt) ?? validIso(record.updatedAt) ?? createdAt : null,
      rank: ranks[record.id]!,
    };
  });
}

/**
 * Every legacy task of a project, or null when the files cannot be read in a
 * way a retry would fix. The read is bounded by the board's task limit.
 */
export async function readLegacyTasks(legacy: LegacyTasks, projectSlug: string, ownerScope: OwnerScope): Promise<TaskRecord[] | null> {
  const records: TaskRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await legacy.listTasks(projectSlug, { includeArchived: true, limit: PAGE, ...(cursor ? { cursor } : {}) }, ownerScope);
    if (!page.ok) {
      console.warn("[project-tasks] legacy task files unreadable", page.error.code);
      return null;
    }
    records.push(...page.tasks);
    cursor = page.nextCursor ?? undefined;
  } while (cursor && records.length < TASK_LIMITS.tasksPerProject);
  return records.slice(0, TASK_LIMITS.tasksPerProject);
}
