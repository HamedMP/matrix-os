/**
 * Board data model. The wire types come from the spec 2699 contract in
 * `@matrix-os/contracts/project-tasks`; only UI labels and ordering live here.
 */
import type { TaskPriority, TaskStatus } from "@matrix-os/contracts/project-tasks";

export {
  BOARD_COLUMN_STATUSES, TASK_LIMITS, TASK_PRIORITIES, TASK_STATUSES, TaskRankError, rankBetween,
} from "@matrix-os/contracts/project-tasks";
export type {
  ActorRef, AttachableSession, BoardMember, BoardSettings, ProjectTask, TaskActivity, TaskActivityKind, TaskAgentStatus,
  TaskComment, TaskExternalLink, TaskGitSummary, TaskPriority, TaskPullRequest, TaskSession, TaskStatus,
} from "@matrix-os/contracts/project-tasks";

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: "Backlog", todo: "To do", in_progress: "In progress", in_review: "In review", done: "Done", canceled: "Canceled",
};

export const TASK_PRIORITY_LABEL: Record<TaskPriority, string> = {
  none: "No priority", low: "Low", normal: "Normal", high: "High", urgent: "Urgent",
};

/** Higher sorts first in the list view. */
export const TASK_PRIORITY_WEIGHT: Record<TaskPriority, number> = { none: 0, low: 1, normal: 2, high: 3, urgent: 4 };
