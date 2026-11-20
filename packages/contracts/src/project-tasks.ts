/**
 * Project task board wire contract (spec 2699). The gateway validates every
 * request with these schemas at the route boundary; the board UI, the
 * `matrix tasks` CLI and the agent tools read responses through them.
 */
import { z } from "zod/v4";
import { CanonicalChatModelSelectionSchema } from "#canonical-chat";

export const TASK_STATUSES = ["backlog", "todo", "in_progress", "in_review", "done", "canceled"] as const;
export const TaskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/** Statuses shown as board columns; `canceled` sits behind a filter. */
export const BOARD_COLUMN_STATUSES = ["backlog", "todo", "in_progress", "in_review", "done"] as const satisfies readonly TaskStatus[];

export const TASK_PRIORITIES = ["none", "low", "normal", "high", "urgent"] as const;
export const TaskPrioritySchema = z.enum(TASK_PRIORITIES);
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;

export const TASK_AGENT_STATUSES = ["idle", "working", "done", "blocked", "error"] as const;
export const TaskAgentStatusSchema = z.enum(TASK_AGENT_STATUSES);
export type TaskAgentStatus = z.infer<typeof TaskAgentStatusSchema>;

// ---------------------------------------------------------------------------
// Identifiers and bounds.

export const TASK_LIMITS = {
  title: 300,
  description: 50_000,
  comment: 10_000,
  labels: 20,
  label: 48,
  relations: 50,
  subtasks: 100,
  sessions: 16,
  tasksPerProject: 5_000,
  listDefault: 200,
  listMax: 500,
  search: 200,
  rank: 128,
  bodyBytes: 256 * 1024,
} as const;

export const TaskIdSchema = z.string().regex(/^task_[A-Za-z0-9_-]{1,128}$/);
export const TaskCommentIdSchema = z.string().regex(/^tcm_[A-Za-z0-9_-]{1,128}$/);
export const ProjectIdSchema = z.string().regex(/^proj_[A-Za-z0-9_-]{1,128}$/);
export const TaskClientRequestIdSchema = z.string().regex(/^req_[A-Za-z0-9_-]{1,128}$/);

/** `user:<id>`, `agent:<session ref>` or `system:<source>`. Set by the server from the principal, never from a body. */
export const ActorRefSchema = z.string().max(200).regex(/^(user|agent|system):[A-Za-z0-9_.:@-]{1,190}$/)
  .transform((value) => value as ActorRef);
export type ActorRef = `user:${string}` | `agent:${string}` | `system:${string}`;

/** A task's chat (`chat_<id>`) or terminal tab (`term.<workspace>.<tab>`), the spec 2697 AgentSessionRef string form. */
export const TaskSessionRefSchema = z.string().max(300)
  .regex(/^(chat_[A-Za-z0-9_-]{1,128}|term\.[A-Za-z0-9_-]{1,128}\.[A-Za-z0-9_-]{1,128})$/);

/** Short board prefix shown before task numbers, for example `MOS` in `MOS-42`. */
export const TaskKeyPrefixSchema = z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/);

/** Fractional index over base-62 digits; never ends in the zero digit. */
export const TaskRankSchema = z.string().min(1).max(TASK_LIMITS.rank).regex(/^[0-9A-Za-z]*[1-9A-Za-z]$/);

export const TaskLabelSchema = z.string().trim().min(1).max(TASK_LIMITS.label)
  .regex(/^[^\u0000-\u001f\u007f,]+$/, "labels cannot contain control characters or commas");

export const TaskTitleSchema = z.string().trim().min(1).max(TASK_LIMITS.title);
export const TaskDescriptionSchema = z.string().max(TASK_LIMITS.description);
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });

/** Branch names follow the worktree manager's safe pattern. */
export const TaskBranchSchema = z.string().min(1).max(200)
  .regex(/^(?!\/|.*\/\/|.*\.\.|.*@\{|.*\.lock$|.*\/$)[A-Za-z0-9][A-Za-z0-9._/-]*$/);

// ---------------------------------------------------------------------------
// Records on the wire.

export const TaskSessionSchema = z.object({
  ref: TaskSessionRefSchema,
  kind: z.enum(["chat", "terminal"]),
  title: z.string().min(1).max(200),
  role: z.enum(["main", "extra"]),
  agentStatus: TaskAgentStatusSchema,
  harness: z.string().min(1).max(80).optional(),
  /** The chat was deleted or archived, or the terminal tab closed; the link stays until it is detached or replaced. */
  unavailable: z.boolean().optional(),
});
export type TaskSession = z.infer<typeof TaskSessionSchema>;

export const PullRequestStateSchema = z.enum(["open", "draft", "merged", "closed"]);
export const PullRequestChecksSchema = z.enum(["passing", "failing", "pending", "none"]);
export const PullRequestReviewSchema = z.enum(["approved", "changes_requested", "review_required", "none"]);

export const TaskPullRequestSchema = z.object({
  number: z.number().int().positive(),
  url: z.string().url().max(500),
  state: PullRequestStateSchema,
  checks: PullRequestChecksSchema,
  review: PullRequestReviewSchema,
});
export type TaskPullRequest = z.infer<typeof TaskPullRequestSchema>;

export const TaskExternalLinkSchema = z.object({
  provider: z.literal("linear"),
  key: z.string().min(1).max(40),
  url: z.string().url().max(500),
});
export type TaskExternalLink = z.infer<typeof TaskExternalLinkSchema>;

export const ProjectTaskSchema = z.object({
  id: TaskIdSchema,
  projectId: ProjectIdSchema,
  number: z.number().int().positive(),
  /** Display key, for example `MOS-42`. */
  key: z.string().min(3).max(24),
  title: z.string().min(1).max(TASK_LIMITS.title),
  description: TaskDescriptionSchema,
  status: TaskStatusSchema,
  priority: TaskPrioritySchema,
  rank: TaskRankSchema,
  assignee: ActorRefSchema.nullable(),
  labels: z.array(TaskLabelSchema).max(TASK_LIMITS.labels),
  parentTaskId: TaskIdSchema.nullable(),
  blockedBy: z.array(TaskIdSchema).max(TASK_LIMITS.relations),
  dueAt: IsoDateTimeSchema.nullable(),
  worktreeId: z.string().max(140).nullable(),
  branch: TaskBranchSchema.nullable(),
  pullRequest: TaskPullRequestSchema.nullable(),
  externalLink: TaskExternalLinkSchema.nullable(),
  sessions: z.array(TaskSessionSchema).max(TASK_LIMITS.sessions),
  commentCount: z.number().int().min(0),
  createdBy: ActorRefSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  archivedAt: IsoDateTimeSchema.nullable(),
  revision: z.number().int().positive(),
});
export type ProjectTask = z.infer<typeof ProjectTaskSchema>;

export const TaskCommentSchema = z.object({
  id: TaskCommentIdSchema,
  taskId: TaskIdSchema,
  author: ActorRefSchema,
  body: z.string().min(1).max(TASK_LIMITS.comment),
  createdAt: IsoDateTimeSchema,
  editedAt: IsoDateTimeSchema.nullable(),
});
export type TaskComment = z.infer<typeof TaskCommentSchema>;

export const TASK_ACTIVITY_KINDS = [
  "created", "moved", "assigned", "priority_changed", "labels_changed", "renamed", "described", "due_changed",
  "relations_changed", "parent_changed", "session_started", "session_attached", "session_detached",
  "pr_opened", "pr_merged", "archived", "unarchived", "deleted", "imported", "synced",
] as const;
export const TaskActivityKindSchema = z.enum(TASK_ACTIVITY_KINDS);
export type TaskActivityKind = z.infer<typeof TaskActivityKindSchema>;

export const TaskActivitySchema = z.object({
  seq: z.number().int().positive(),
  taskId: TaskIdSchema,
  actor: ActorRefSchema,
  kind: TaskActivityKindSchema,
  /** Short, server-built description, for example "To do → In progress". */
  summary: z.string().min(1).max(400),
  at: IsoDateTimeSchema,
});
export type TaskActivity = z.infer<typeof TaskActivitySchema>;

export const BoardMemberSchema = z.object({
  actor: ActorRefSchema,
  name: z.string().min(1).max(120),
  handle: z.string().regex(/^[A-Za-z0-9._-]{1,40}$/),
  avatarUrl: z.string().url().max(500).optional(),
});
export type BoardMember = z.infer<typeof BoardMemberSchema>;

export const BoardAutomationSchema = z.object({
  startMovesToInProgress: z.boolean(),
  prOpenMovesToReview: z.boolean(),
  prMergeMovesToDone: z.boolean(),
});

export const BoardSettingsSchema = z.object({
  projectId: ProjectIdSchema,
  taskKey: TaskKeyPrefixSchema,
  linearConnected: z.boolean(),
  automation: BoardAutomationSchema,
});
export type BoardSettings = z.infer<typeof BoardSettingsSchema>;

export const TaskGitSummarySchema = z.object({
  branch: TaskBranchSchema.nullable(),
  dirty: z.boolean(),
  ahead: z.number().int().min(0),
  behind: z.number().int().min(0),
  changedFiles: z.number().int().min(0),
  pullRequest: TaskPullRequestSchema.nullable(),
  /** `unavailable` when `gh` is missing, signed out or slow on the owner's computer. */
  prStatus: z.enum(["ok", "unavailable"]),
});
export type TaskGitSummary = z.infer<typeof TaskGitSummarySchema>;

/** A chat or terminal tab in the project that no task owns yet. */
export const AttachableSessionSchema = z.object({
  ref: TaskSessionRefSchema,
  kind: z.enum(["chat", "terminal"]),
  title: z.string().min(1).max(200),
});
export type AttachableSession = z.infer<typeof AttachableSessionSchema>;

// ---------------------------------------------------------------------------
// Requests. Actors are never accepted from a body.

export const ListTasksQuerySchema = z.object({
  status: TaskStatusSchema.optional(),
  assignee: z.union([z.literal("unassigned"), ActorRefSchema]).optional(),
  label: TaskLabelSchema.optional(),
  q: z.string().max(TASK_LIMITS.search).optional(),
  cursor: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/).optional(),
  limit: z.coerce.number().int().min(1).max(TASK_LIMITS.listMax).default(TASK_LIMITS.listDefault),
  includeArchived: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
});
export type ListTasksQuery = z.input<typeof ListTasksQuerySchema>;

export const CreateTaskBodySchema = z.object({
  title: TaskTitleSchema,
  description: TaskDescriptionSchema.optional(),
  status: TaskStatusSchema.optional(),
  priority: TaskPrioritySchema.optional(),
  assignee: ActorRefSchema.nullable().optional(),
  labels: z.array(TaskLabelSchema).max(TASK_LIMITS.labels).optional(),
  parentTaskId: TaskIdSchema.nullable().optional(),
  dueAt: IsoDateTimeSchema.nullable().optional(),
  /** Places the card right after this one; otherwise it goes to the top of its column. */
  afterTaskId: TaskIdSchema.optional(),
  clientRequestId: TaskClientRequestIdSchema,
}).strict();
export type CreateTaskBody = z.input<typeof CreateTaskBodySchema>;

export const UpdateTaskBodySchema = z.object({
  baseRevision: z.number().int().positive(),
  title: TaskTitleSchema.optional(),
  description: TaskDescriptionSchema.optional(),
  priority: TaskPrioritySchema.optional(),
  assignee: ActorRefSchema.nullable().optional(),
  labels: z.array(TaskLabelSchema).max(TASK_LIMITS.labels).optional(),
  dueAt: IsoDateTimeSchema.nullable().optional(),
  parentTaskId: TaskIdSchema.nullable().optional(),
  blockedBy: z.array(TaskIdSchema).max(TASK_LIMITS.relations).optional(),
}).strict();
export type UpdateTaskBody = z.input<typeof UpdateTaskBodySchema>;

export const MoveTaskBodySchema = z.object({
  status: TaskStatusSchema,
  afterTaskId: TaskIdSchema.optional(),
  beforeTaskId: TaskIdSchema.optional(),
  /** Close a task while one of its agents is working (the UI asks first; CLI `--force`). */
  force: z.boolean().optional(),
}).strict();
export type MoveTaskBody = z.input<typeof MoveTaskBodySchema>;

export const CreateCommentBodySchema = z.object({ body: z.string().trim().min(1).max(TASK_LIMITS.comment) }).strict();
export const UpdateCommentBodySchema = CreateCommentBodySchema;

export const StartTaskBodySchema = z.object({
  kind: z.enum(["chat", "terminal"]),
  harness: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/).optional(),
  worktree: z.enum(["new", "existing", "none"]).default("new"),
  message: z.string().max(TASK_LIMITS.comment).optional(),
  /** With a model selection the server sends the first chat turn; without one it returns `firstMessage` for the composer. */
  selection: CanonicalChatModelSelectionSchema.optional(),
  /** Retrying with the same id resumes the same start instead of creating another session. */
  clientRequestId: TaskClientRequestIdSchema.optional(),
}).strict();
export type StartTaskBody = z.input<typeof StartTaskBodySchema>;

export const AttachSessionBodySchema = z.object({ ref: TaskSessionRefSchema }).strict();

/** Pushes the task's branch and opens a pull request titled after the task. */
export const CreatePullRequestBodySchema = z.object({ draft: z.boolean().optional() }).strict();

export const UpdateBoardSettingsBodySchema = z.object({
  taskKey: TaskKeyPrefixSchema.optional(),
  automation: BoardAutomationSchema.partial().optional(),
}).strict();

export const ArchiveTaskBodySchema = z.object({}).strict();

// ---------------------------------------------------------------------------
// Responses.

export const ListTasksResponseSchema = z.object({ tasks: z.array(ProjectTaskSchema), nextCursor: z.string().nullable() });
export const TaskResponseSchema = z.object({ task: ProjectTaskSchema });
export const ListCommentsResponseSchema = z.object({ comments: z.array(TaskCommentSchema), nextCursor: z.string().nullable() });
export const CommentResponseSchema = z.object({ comment: TaskCommentSchema });
export const ListActivityResponseSchema = z.object({ activity: z.array(TaskActivitySchema), nextCursor: z.string().nullable() });
export const StartTaskResponseSchema = z.object({
  task: ProjectTaskSchema,
  session: TaskSessionSchema,
  /** The first message, when the server did not send it (no model selection, or a terminal session). */
  firstMessage: z.string().min(1).max(TASK_LIMITS.description + TASK_LIMITS.comment + 1_000).optional(),
});
export const TaskGitResponseSchema = z.object({ git: TaskGitSummarySchema });
export const TaskPullRequestResponseSchema = z.object({ task: ProjectTaskSchema, git: TaskGitSummarySchema });
export const BoardSettingsResponseSchema = z.object({ settings: BoardSettingsSchema });
export const BoardMembersResponseSchema = z.object({ members: z.array(BoardMemberSchema) });
export const AttachableSessionsResponseSchema = z.object({ sessions: z.array(AttachableSessionSchema) });

/**
 * The project (and task) the gateway bounds a session credential to: a terminal pane's
 * loopback token or a chat run's token. Null for an owner credential, which is unbounded.
 */
export const PROJECT_TASK_SESSION_PATH = "/api/project-tasks/session";
export const ProjectTaskSessionSchema = z.object({
  projectId: ProjectIdSchema,
  projectSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  taskId: TaskIdSchema.optional(),
}).strict();
export type ProjectTaskSessionBinding = z.infer<typeof ProjectTaskSessionSchema>;
export const ProjectTaskSessionResponseSchema = z.object({ session: ProjectTaskSessionSchema.nullable() });
/**
 * A task terminal tab's gateway-issued credential: set in the tab's environment at launch
 * and presented with the local terminal token. The gateway derives the tab's project and
 * actor only from a credential it signed.
 */
export const TASK_SESSION_TOKEN_ENV = "MATRIX_TASK_SESSION_TOKEN";
export const TASK_SESSION_TOKEN_HEADER = "x-matrix-task-session-token";

/** Stable error codes; messages are generic. */
export const PROJECT_TASK_ERROR_CODES = [
  "invalid_request", "project_not_found", "task_not_found", "comment_not_found", "task_revision_conflict",
  "task_agent_working", "task_limit_reached", "task_relation_invalid", "task_forbidden", "board_unavailable",
  "board_sync_unavailable", "task_session_unavailable", "task_session_not_found", "task_session_taken",
] as const;
export type ProjectTaskErrorCode = (typeof PROJECT_TASK_ERROR_CODES)[number];
export const ProjectTaskErrorSchema = z.object({
  error: z.object({ code: z.enum(PROJECT_TASK_ERROR_CODES), message: z.string().max(200) }),
  /** On `task_revision_conflict`, the server's current task. */
  task: ProjectTaskSchema.optional(),
});

/** Base path of a project's board routes. */
export function projectTasksPath(projectSlug: string): string {
  return `/api/projects/${encodeURIComponent(projectSlug)}/tasks`;
}

export function projectBoardPath(projectSlug: string): string {
  return `/api/projects/${encodeURIComponent(projectSlug)}/board`;
}

export function formatTaskKey(prefix: string, number: number): string {
  return `${prefix}-${number}`;
}

export * from "#project-task-rank";
