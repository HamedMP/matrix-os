import type { z } from "zod/v4";
import type {
  CreateTaskBodySchema, MoveTaskBodySchema, ProjectTaskErrorCode, StartTaskBody, UpdateTaskBodySchema,
} from "@matrix-os/contracts/project-tasks";
import type {
  AttachableSession, BoardMember, BoardSettings, ProjectTask, TaskActivity, TaskComment, TaskGitSummary, TaskSession,
} from "./types.js";

// Parsed shapes, so actor fields keep their `user:`/`agent:`/`system:` types.
export type CreateTaskInput = z.infer<typeof CreateTaskBodySchema>;
export type UpdateTaskInput = Omit<z.infer<typeof UpdateTaskBodySchema>, "baseRevision">;
export type MoveTaskInput = z.infer<typeof MoveTaskBodySchema>;
export type StartSessionInput = Pick<StartTaskBody, "kind" | "harness" | "worktree" | "message">;
export type UpdateBoardSettingsInput = Partial<Pick<BoardSettings, "taskKey">> & { automation?: Partial<BoardSettings["automation"]> };

export interface ListTasksOptions {
  includeArchived?: boolean;
}

/** Thrown for a lost optimistic-concurrency race; carries the server's copy. */
export class TaskConflictError extends Error {
  constructor(readonly current: ProjectTask) {
    super("task_conflict");
    this.name = "TaskConflictError";
  }
}

/** Thrown when closing a task while one of its agents is working and the move did not pass `force`. */
export class TaskAgentWorkingError extends Error {
  constructor() {
    super("task_agent_working");
    this.name = "TaskAgentWorkingError";
  }
}

export const GENERIC_BOARD_ERROR = "Something went wrong. Try again.";

/** A failed request. The message is generic and safe to show; callers may replace the generic one with their own. */
export class ProjectBoardRequestError extends Error {
  constructor(message = GENERIC_BOARD_ERROR, readonly code?: ProjectTaskErrorCode) {
    super(message);
    this.name = "ProjectBoardRequestError";
  }
}

/**
 * Everything the board UI needs from a project's task store. The owner's view
 * talks to `/api/projects/:slug/tasks` (`createHttpProjectBoardClient`); tests
 * use the in-memory fixture. `subscribe` delivers change signals only: callers
 * refetch what they show.
 */
export interface ProjectBoardClient {
  listTasks(options?: ListTasksOptions): Promise<readonly ProjectTask[]>;
  getTask(taskId: string): Promise<ProjectTask>;
  createTask(input: CreateTaskInput): Promise<ProjectTask>;
  /** Rejects with `TaskConflictError` when `baseRevision` is stale. */
  updateTask(taskId: string, baseRevision: number, input: UpdateTaskInput): Promise<ProjectTask>;
  /** Rejects with `TaskAgentWorkingError` when closing a task with a working agent without `force`. */
  moveTask(taskId: string, input: MoveTaskInput): Promise<ProjectTask>;
  archiveTask(taskId: string, archived: boolean): Promise<ProjectTask>;
  deleteTask(taskId: string): Promise<void>;
  listComments(taskId: string): Promise<readonly TaskComment[]>;
  addComment(taskId: string, body: string): Promise<TaskComment>;
  listActivity(taskId: string): Promise<readonly TaskActivity[]>;
  /** Prepare the task's own chat (`kind: "chat"`) or attach a new terminal (`kind: "terminal"`). */
  startWork(taskId: string, input: StartSessionInput): Promise<StartedTaskWork>;
  /** Terminal tabs of the project that no task owns yet. */
  listAttachableSessions(): Promise<readonly AttachableSession[]>;
  attachSession(taskId: string, session: AttachableSession): Promise<TaskSession>;
  detachSession(taskId: string, ref: string): Promise<ProjectTask>;
  getGitSummary(taskId: string): Promise<TaskGitSummary>;
  createPullRequest(taskId: string): Promise<ProjectTask>;
  listMembers(): Promise<readonly BoardMember[]>;
  getSettings(): Promise<BoardSettings>;
  updateSettings(input: UpdateBoardSettingsInput): Promise<BoardSettings>;
  /** Returns an unsubscribe function. */
  subscribe(listener: (event: ProjectBoardEvent) => void): () => void;
}

/**
 * What Start work did: the task after it, the attached terminal (null for a
 * chat start, whose chat is `task.chatId`), and the first message when the
 * server did not send it (no model selected yet).
 */
export interface StartedTaskWork {
  task: ProjectTask;
  session: TaskSession | null;
  firstMessage?: string;
}

export const PROJECT_BOARD_EVENT_TYPES = ["task.created", "task.updated", "task.moved", "task.deleted", "task.comment_added"] as const;
export type ProjectBoardEventType = (typeof PROJECT_BOARD_EVENT_TYPES)[number];
export interface ProjectBoardEvent { type: ProjectBoardEventType; taskId: string; revision: number }
