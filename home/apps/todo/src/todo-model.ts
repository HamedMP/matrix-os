// Pure, UI-free task model: filtering, sorting, recurrence. Unit-tested.

export type TaskStatus = "open" | "done";
export type Recurrence = "daily" | "weekly" | "weekdays";

export interface Task {
  id: string;
  title: string;
  notes: string;
  due: string | null; // ISO timestamptz
  priority: 0 | 1 | 2 | 3;
  project: string | null;
  status: TaskStatus;
  recur: Recurrence | null;
  created_at: string;
}

export type SmartView = "inbox" | "today" | "upcoming";
export type ProjectView = { kind: "project"; project: string };
export type View = SmartView | ProjectView;

const RECURRENCES: ReadonlySet<string> = new Set(["daily", "weekly", "weekdays"]);

function clampPriority(value: unknown): 0 | 1 | 2 | 3 {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  const rounded = Math.round(n);
  if (rounded <= 0) return 0;
  if (rounded >= 3) return 3;
  return rounded as 1 | 2;
}

function toStringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Coerce an untyped DB row into a Task, or null if invalid (e.g. empty title). */
export function normalizeTask(row: unknown): Task | null {
  if (!row || typeof row !== "object") return null;
  const data = row as Record<string, unknown>;
  const title = typeof data.title === "string" ? data.title.trim() : "";
  if (title.length === 0) return null;
  const recurRaw = toStringOrNull(data.recur);
  const recur = recurRaw && RECURRENCES.has(recurRaw) ? (recurRaw as Recurrence) : null;
  return {
    id: typeof data.id === "string" ? data.id : crypto.randomUUID(),
    title,
    notes: typeof data.notes === "string" ? data.notes : "",
    due: toStringOrNull(data.due),
    priority: clampPriority(data.priority),
    project: toStringOrNull(data.project),
    status: data.status === "done" ? "done" : "open",
    recur,
    created_at: typeof data.created_at === "string" ? data.created_at : new Date().toISOString(),
  };
}

function startOfDay(date: Date): number {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function endOfDay(date: Date): number {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

function dueTime(task: Task): number | null {
  if (!task.due) return null;
  const t = new Date(task.due).getTime();
  return Number.isNaN(t) ? null : t;
}

export function isOpen(task: Task): boolean {
  return task.status === "open";
}

/** A task belongs to Today if it is open and due on/before the end of `now`'s day. */
export function isToday(task: Task, now: Date): boolean {
  if (!isOpen(task)) return false;
  const t = dueTime(task);
  return t !== null && t <= endOfDay(now);
}

/** Upcoming: open and due strictly after today. */
export function isUpcoming(task: Task, now: Date): boolean {
  if (!isOpen(task)) return false;
  const t = dueTime(task);
  return t !== null && t > endOfDay(now);
}

/** Inbox: open tasks with no project assigned. */
export function isInbox(task: Task): boolean {
  return isOpen(task) && task.project === null;
}

export function filterTasks(tasks: Task[], view: View, now: Date): Task[] {
  if (typeof view === "object") {
    return tasks.filter((t) => isOpen(t) && t.project === view.project);
  }
  switch (view) {
    case "inbox":
      return tasks.filter(isInbox);
    case "today":
      return tasks.filter((t) => isToday(t, now));
    case "upcoming":
      return tasks.filter((t) => isUpcoming(t, now));
    default:
      return tasks.filter(isOpen);
  }
}

export interface ViewCounts {
  inbox: number;
  today: number;
  upcoming: number;
}

export function countByView(tasks: Task[], now: Date): ViewCounts {
  return {
    inbox: tasks.filter(isInbox).length,
    today: tasks.filter((t) => isToday(t, now)).length,
    upcoming: tasks.filter((t) => isUpcoming(t, now)).length,
  };
}

/** Distinct project names among open tasks, sorted alphabetically. */
export function projectNames(tasks: Task[]): string[] {
  const names = new Set<string>();
  for (const t of tasks) {
    if (t.project) names.add(t.project);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** Sort: priority desc, then due asc (nulls last), then created_at asc. */
export function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    const da = dueTime(a);
    const db = dueTime(b);
    if (da !== db) {
      if (da === null) return 1;
      if (db === null) return -1;
      return da - db;
    }
    return a.created_at.localeCompare(b.created_at);
  });
}

/**
 * Compute the next occurrence ISO string for a recurring task.
 * `daily` +1 day, `weekly` +7 days, `weekdays` next Mon-Fri.
 * Returns null when there is no recurrence.
 */
export function nextRecurrence(recur: Recurrence | null, from: Date): string | null {
  if (!recur || !RECURRENCES.has(recur)) return null;
  const next = new Date(from);
  if (Number.isNaN(next.getTime())) return null;
  // Operate in UTC so results are deterministic regardless of the host timezone.
  const DAY = 24 * 60 * 60 * 1000;
  if (recur === "daily") {
    next.setTime(next.getTime() + DAY);
  } else if (recur === "weekly") {
    next.setTime(next.getTime() + 7 * DAY);
  } else {
    // weekdays: advance at least one day, skipping Sat (6) and Sun (0) in UTC
    next.setTime(next.getTime() + DAY);
    while (next.getUTCDay() === 0 || next.getUTCDay() === 6) {
      next.setTime(next.getTime() + DAY);
    }
  }
  return next.toISOString();
}

void startOfDay; // reserved for future range views
