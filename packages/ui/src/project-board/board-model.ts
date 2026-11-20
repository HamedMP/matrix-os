import { rollUpTerminalStatus } from "../terminal-agents/attention.js";
import {
  TASK_PRIORITY_WEIGHT, TASK_STATUSES, rankBetween,
  type ActorRef, type ProjectTask, type TaskAgentStatus, type TaskPriority, type TaskSession, type TaskStatus,
} from "./types.js";

function byRank(a: ProjectTask, b: ProjectTask): number {
  if (a.rank !== b.rank) return a.rank < b.rank ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Columns and moves.

export type BoardColumns = Record<TaskStatus, ProjectTask[]>;

export function groupTasksByStatus(tasks: readonly ProjectTask[]): BoardColumns {
  const groups = Object.fromEntries(TASK_STATUSES.map((status) => [status, [] as ProjectTask[]])) as BoardColumns;
  for (const task of tasks) groups[task.status].push(task);
  for (const status of TASK_STATUSES) groups[status].sort(byRank);
  return groups;
}

export interface MovePlan {
  afterTaskId?: string;
  beforeTaskId?: string;
  rank: string;
}

/**
 * Where a card lands when dropped at `targetIndex` of a column. The index counts
 * the column without the moving card, so moves within one column work too.
 */
export function planMove(column: readonly ProjectTask[], taskId: string, targetIndex: number): MovePlan {
  const others = column.filter((task) => task.id !== taskId);
  const index = Math.max(0, Math.min(targetIndex, others.length));
  const after = others[index - 1];
  const before = others[index];
  return { afterTaskId: after?.id, beforeTaskId: before?.id, rank: rankBetween(after?.rank ?? null, before?.rank ?? null) };
}

export interface PendingMove {
  status: TaskStatus;
  rank: string;
}

/** Overlay optimistic moves on the server's tasks; returns the same array when nothing is pending. */
export function applyPendingMoves(tasks: readonly ProjectTask[], pending: Readonly<Record<string, PendingMove>>): readonly ProjectTask[] {
  if (Object.keys(pending).length === 0) return tasks;
  return tasks.map((task) => {
    const move = pending[task.id];
    return move ? { ...task, status: move.status, rank: move.rank } : task;
  });
}

export type KeyboardMoveDirection = "up" | "down" | "left" | "right";

/**
 * The keyboard equivalent of a drag: one step within the column, or to the neighbouring column at the same height.
 * `statuses` is the column order as drawn, so filtered-out columns are skipped and a shown Canceled column takes part.
 */
export function keyboardMoveTarget(columns: BoardColumns, statuses: readonly TaskStatus[], taskId: string, direction: KeyboardMoveDirection): { status: TaskStatus; index: number } | null {
  const status = statuses.find((candidate) => columns[candidate].some((task) => task.id === taskId));
  if (!status) return null;
  const index = columns[status].findIndex((task) => task.id === taskId);
  if (direction === "up") return index > 0 ? { status, index: index - 1 } : null;
  if (direction === "down") return index < columns[status].length - 1 ? { status, index: index + 1 } : null;
  const target = statuses[statuses.indexOf(status) + (direction === "left" ? -1 : 1)];
  if (!target) return null;
  return { status: target, index: Math.min(index, columns[target].length) };
}

// ---------------------------------------------------------------------------
// Filters.

export type AssigneeFilterValue = ActorRef | "unassigned";

export interface BoardFilter {
  statuses: readonly TaskStatus[];
  priorities: readonly TaskPriority[];
  labels: readonly string[];
  assignees: readonly AssigneeFilterValue[];
  search: string;
  showCanceled: boolean;
  showArchived: boolean;
}

export const EMPTY_BOARD_FILTER: BoardFilter = {
  statuses: [], priorities: [], labels: [], assignees: [], search: "", showCanceled: false, showArchived: false,
};

export function boardFilterIsActive(filter: BoardFilter): boolean {
  return filter.statuses.length > 0 || filter.priorities.length > 0 || filter.labels.length > 0
    || filter.assignees.length > 0 || filter.search.trim() !== "" || filter.showCanceled || filter.showArchived;
}

export function matchesBoardFilter(task: ProjectTask, filter: BoardFilter): boolean {
  if (task.archivedAt !== null && !filter.showArchived) return false;
  if (task.status === "canceled" && !filter.showCanceled && !filter.statuses.includes("canceled")) return false;
  if (filter.statuses.length > 0 && !filter.statuses.includes(task.status)) return false;
  if (filter.priorities.length > 0 && !filter.priorities.includes(task.priority)) return false;
  if (filter.labels.length > 0 && !filter.labels.some((label) => task.labels.includes(label))) return false;
  if (filter.assignees.length > 0 && !filter.assignees.includes(task.assignee ?? "unassigned")) return false;
  const search = filter.search.trim().toLowerCase();
  if (!search) return true;
  const haystack = [task.title, task.key, task.externalLink?.key ?? "", task.branch ?? "", ...task.labels];
  return haystack.some((value) => value.toLowerCase().includes(search));
}

// ---------------------------------------------------------------------------
// Card facts.

/** The card badge: Herdr's roll-up over the task's sessions (blocked and error first). */
export function rollUpTaskAgentStatus(sessions: readonly TaskSession[]): TaskAgentStatus | undefined {
  return rollUpTerminalStatus(sessions.map((session) => session.agentStatus));
}

export type TaskListColumn = "key" | "title" | "status" | "priority" | "updated";
export interface TaskListSort { column: TaskListColumn; direction: "asc" | "desc" }

const STATUS_ORDER = Object.fromEntries(TASK_STATUSES.map((status, index) => [status, index])) as Record<TaskStatus, number>;

function compareTasks(a: ProjectTask, b: ProjectTask, column: TaskListColumn): number {
  switch (column) {
    case "key": return a.number - b.number;
    case "title": return a.title.localeCompare(b.title);
    case "status": return STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || byRank(a, b);
    case "priority": return TASK_PRIORITY_WEIGHT[a.priority] - TASK_PRIORITY_WEIGHT[b.priority];
    case "updated": return Date.parse(a.updatedAt) - Date.parse(b.updatedAt);
  }
}

export function sortTasksForList(tasks: readonly ProjectTask[], sort: TaskListSort): ProjectTask[] {
  const sign = sort.direction === "asc" ? 1 : -1;
  return [...tasks].sort((a, b) => sign * compareTasks(a, b, sort.column) || a.number - b.number);
}
