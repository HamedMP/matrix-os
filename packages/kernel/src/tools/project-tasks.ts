import { z } from "zod/v4";
import {
  PROJECT_SLUG_PATTERN, PROJECT_TASK_CLIENT_MESSAGES, ProjectTaskClientError,
  projectMatchesSession, resolveTaskId, type ProjectTaskClient, type ProjectTaskSession,
} from "@matrix-os/contracts/project-task-client";
import {
  ProjectIdSchema, TASK_LIMITS, TASK_PRIORITIES, TASK_STATUSES, TaskIdSchema, type ProjectTask,
} from "@matrix-os/contracts/project-tasks";
import { wrapExternalContent } from "../security/external-content.js";

/**
 * The project board tools (spec 2699 section 5) for agents. One definition set
 * serves the kernel's in-process server and the integrations MCP server. Each
 * session is bounded to its own project; actors come from the server-side
 * principal, never from tool input.
 */
export const PROJECT_TASK_TOOL_NAMES = [
  "project_task_list", "project_task_get", "project_task_create", "project_task_update",
  "project_task_move", "project_task_comment", "project_task_start",
] as const;
export const PROJECT_TASK_IPC_TOOL_NAMES = PROJECT_TASK_TOOL_NAMES.map((name) => `mcp__matrix-os-ipc__${name}`);

export interface ProjectTaskToolContext {
  client: ProjectTaskClient;
  /** The session's own project, or null when the run has none (each call then names a project slug). */
  session(): Promise<ProjectTaskSession | null>;
}

/** What the gateway injects into a kernel run that belongs to a project. */
export interface ProjectTaskKernelBinding {
  client: ProjectTaskClient;
  session: ProjectTaskSession;
}

const CLIENT_METHODS = [
  "listTasks", "getTask", "createTask", "updateTask", "moveTask", "listComments", "createComment", "listActivity", "startTask",
] as const satisfies readonly (keyof ProjectTaskClient)[];

/** Verifies every dependency at registration so a broken wiring fails at startup, not on the first call. */
export function projectTaskKernelContext(binding: ProjectTaskKernelBinding): ProjectTaskToolContext {
  if (!binding || typeof binding !== "object" || !binding.client) throw new Error("ProjectTaskBindingMissing");
  for (const method of CLIENT_METHODS) {
    if (typeof binding.client[method] !== "function") throw new Error("ProjectTaskBindingIncomplete");
  }
  const { projectId, projectSlug, taskId } = binding.session ?? {};
  if (!ProjectIdSchema.safeParse(projectId).success || typeof projectSlug !== "string" || !PROJECT_SLUG_PATTERN.test(projectSlug)
    || (taskId !== undefined && !TaskIdSchema.safeParse(taskId).success)) {
    throw new Error("ProjectTaskBindingInvalidSession");
  }
  const session: ProjectTaskSession = { projectId: projectId!, projectSlug, ...(taskId ? { taskId } : {}) };
  return { client: binding.client, session: async () => session };
}

class ToolRefusal extends Error {
  constructor(readonly text: string) { super("ToolRefusal"); }
}

const ProjectArg = z.string().min(1).max(140).optional()
  .describe("Project slug. Defaults to this session's project; a session cannot reach another project.");
const TaskArg = z.string().min(1).max(140).optional()
  .describe("Task id (task_…) or key such as MOS-42. Defaults to this session's task.");
const ActorArg = z.string().max(200).regex(/^(user|agent|system):[A-Za-z0-9_.:@-]{1,190}$/);
const LabelArg = z.string().trim().min(1).max(TASK_LIMITS.label).regex(/^[^\u0000-\u001f\u007f,]+$/);
const DateArg = z.iso.datetime({ offset: true });

const ListSchema = z.object({
  project: ProjectArg,
  status: z.enum(TASK_STATUSES).optional(),
  assignee: z.union([z.literal("unassigned"), ActorArg]).optional(),
  label: LabelArg.optional(),
  q: z.string().max(TASK_LIMITS.search).optional().describe("Search text, matches keys and titles."),
  cursor: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/).optional(),
  limit: z.number().int().min(1).max(TASK_LIMITS.listMax).optional(),
  includeArchived: z.boolean().optional(),
}).strict();
const GetSchema = z.object({
  project: ProjectArg, task: TaskArg,
  comments: z.boolean().optional().describe("Include the task's comments, oldest first, one page at a time."),
  commentsCursor: z.string().regex(/^tcm_[A-Za-z0-9_-]{1,128}$/).optional()
    .describe("The commentsNextCursor of the previous page, to read the next page of comments."),
  activity: z.boolean().optional().describe("Include the task's activity history, oldest first, one page at a time."),
  activityCursor: z.string().regex(/^(?:0|[1-9][0-9]{0,15})$/).optional()
    .describe("The activityNextCursor of the previous page, to read the next page of activity."),
}).strict();
/** Caller-held retry key: a lost response can be retried without a duplicate write. */
const RetryKeyArg = z.string().regex(/^req_[A-Za-z0-9_-]{1,128}$/);
const CreateSchema = z.object({
  project: ProjectArg,
  title: z.string().trim().min(1).max(TASK_LIMITS.title),
  description: z.string().max(TASK_LIMITS.description).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  assignee: ActorArg.nullable().optional(),
  labels: z.array(LabelArg).max(TASK_LIMITS.labels).optional(),
  parentTask: z.string().min(1).max(140).optional().describe("Parent task id or key, for a subtask."),
  dueAt: DateArg.nullable().optional(),
  clientRequestId: RetryKeyArg
    .describe("A key you choose, such as req_<uuid>. Send the same value when retrying so the task is not created twice."),
}).strict();
const UpdateSchema = z.object({
  project: ProjectArg, task: TaskArg,
  baseRevision: z.number().int().positive().describe("The revision of the task you read. A newer change is reported, never overwritten."),
  title: z.string().trim().min(1).max(TASK_LIMITS.title).optional(),
  description: z.string().max(TASK_LIMITS.description).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  assignee: ActorArg.nullable().optional(),
  labels: z.array(LabelArg).max(TASK_LIMITS.labels).optional().describe("Replaces the task's labels."),
  dueAt: DateArg.nullable().optional(),
  blockedBy: z.array(TaskIdSchema).max(TASK_LIMITS.relations).optional(),
}).strict();
const MoveSchema = z.object({
  project: ProjectArg, task: TaskArg,
  status: z.enum(TASK_STATUSES),
  afterTaskId: TaskIdSchema.optional(),
  beforeTaskId: TaskIdSchema.optional(),
  force: z.boolean().optional().describe("Close the task even while one of its agents is working. Only after the user agrees."),
}).strict();
const CommentSchema = z.object({
  project: ProjectArg, task: TaskArg,
  body: z.string().trim().min(1).max(TASK_LIMITS.comment),
}).strict();
const StartSchema = z.object({
  project: ProjectArg, task: TaskArg,
  kind: z.enum(["chat", "terminal"]),
  harness: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/).optional(),
  worktree: z.enum(["new", "existing", "none"]).optional(),
  message: z.string().max(TASK_LIMITS.comment).optional(),
  clientRequestId: RetryKeyArg
    .describe("A key you choose, such as req_<uuid>. Send the same value when retrying so no second session starts."),
}).strict();

type Text = { content: Array<{ type: "text"; text: string }>; isError?: true };

function text(value: string): Text {
  return { content: [{ type: "text", text: value }] };
}

/** Task text is written by people and other agents, so it is returned as untrusted data. */
function data(value: unknown): Text {
  return text(wrapExternalContent(JSON.stringify(value, null, 2), { source: "api", from: "Matrix project board" }));
}

function compact(task: ProjectTask) {
  return {
    id: task.id, key: task.key, title: task.title, status: task.status, priority: task.priority,
    assignee: task.assignee, labels: task.labels, revision: task.revision,
    // Every task is a chat: its chat and the terminals attached to it.
    chatId: task.chatId, chatStatus: task.chatStatus,
    agents: task.sessions.map((session) => ({ ref: session.ref, kind: session.kind, agentStatus: session.agentStatus })),
  };
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

function refusal(error: unknown): Text {
  if (error instanceof ToolRefusal) return { ...text(error.text), isError: true };
  if (error instanceof ProjectTaskClientError) {
    if (error.code === "task_revision_conflict") {
      const revision = error.task ? ` It is now at revision ${error.task.revision}.` : "";
      return { ...text(`The task changed since it was read.${revision} Read it again with project_task_get, check the change, then retry with the new baseRevision.`), isError: true };
    }
    if (error.code === "task_agent_working") {
      return { ...text("An agent of this task is still working, so it was not closed. Ask the user first; if they agree, retry with force: true."), isError: true };
    }
    return { ...text(PROJECT_TASK_CLIENT_MESSAGES[error.code]), isError: true };
  }
  console.warn("[kernel] project task tool failed", error instanceof Error ? error.name : "unknown_error");
  return { ...text(PROJECT_TASK_CLIENT_MESSAGES.unavailable), isError: true };
}

async function safely(operation: () => Promise<Text>): Promise<Text> {
  try {
    return await operation();
  } catch (error: unknown) {
    return refusal(error);
  }
}

export function projectTaskToolDefinitions(context: ProjectTaskToolContext, options: { readOnly?: boolean } = {}) {
  const { client } = context;

  async function target(project: string | undefined): Promise<{ slug: string; session: ProjectTaskSession | null }> {
    const session = await context.session();
    if (session) {
      if (project !== undefined && !projectMatchesSession(session, project)) {
        throw new ToolRefusal("These tools only reach this session's project. Leave project out, or ask the user to work on the other project from its own session.");
      }
      return { slug: session.projectSlug, session };
    }
    if (!project || !PROJECT_SLUG_PATTERN.test(project)) {
      throw new ToolRefusal("This run has no project. Name the project slug in project.");
    }
    return { slug: project, session: null };
  }

  async function taskTarget(project: string | undefined, task: string | undefined) {
    const scope = await target(project);
    const ref = task ?? scope.session?.taskId;
    if (!ref) throw new ToolRefusal("Name the task: a task_… id or a key such as MOS-42.");
    return { ...scope, taskId: await resolveTaskId(client, scope.slug, ref) };
  }

  function bounded(task: ProjectTask, session: ProjectTaskSession | null): ProjectTask {
    if (session && task.projectId !== session.projectId) throw new ProjectTaskClientError("task_forbidden");
    return task;
  }

  const definitions = [
    {
      name: "project_task_list",
      description: "List tasks on the project board (key, title, status, priority, assignee, labels, agent sessions). Filter by status, assignee, label or search text.",
      schema: ListSchema,
      annotations: { readOnlyHint: true },
      handler: (input: unknown) => safely(async () => {
        const { project, includeArchived, ...query } = ListSchema.parse(input);
        const scope = await target(project);
        const result = await client.listTasks(scope.slug, withoutUndefined({
          ...query, ...(includeArchived !== undefined ? { includeArchived: includeArchived ? "true" as const : "false" as const } : {}),
        }));
        return data({ tasks: result.tasks.map((task) => compact(bounded(task, scope.session))), nextCursor: result.nextCursor });
      }),
    },
    {
      name: "project_task_get",
      description: "Read one task in full: description, branch, pull request, sessions and revision. Optionally a page of its comments and activity; a non-null commentsNextCursor or activityNextCursor means more, read it with commentsCursor or activityCursor.",
      schema: GetSchema,
      annotations: { readOnlyHint: true },
      handler: (input: unknown) => safely(async () => {
        const parsed = GetSchema.parse(input);
        const scope = await taskTarget(parsed.project, parsed.task);
        const task = bounded(await client.getTask(scope.slug, scope.taskId), scope.session);
        const comments = parsed.comments || parsed.commentsCursor
          ? await client.listComments(scope.slug, task.id, parsed.commentsCursor ? { cursor: parsed.commentsCursor } : {}) : undefined;
        const activity = parsed.activity || parsed.activityCursor
          ? await client.listActivity(scope.slug, task.id, parsed.activityCursor ? { cursor: parsed.activityCursor } : {}) : undefined;
        // A non-null next cursor means more history: pass it back as commentsCursor or activityCursor.
        return data(withoutUndefined({
          task, comments: comments?.comments, commentsNextCursor: comments?.nextCursor,
          activity: activity?.activity, activityNextCursor: activity?.nextCursor,
        }));
      }),
    },
    {
      name: "project_task_create",
      description: "Create a task on the project board. It goes to the top of its column. Reuse clientRequestId when retrying.",
      schema: CreateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      handler: (input: unknown) => safely(async () => {
        const { project, parentTask, clientRequestId, ...fields } = CreateSchema.parse(input);
        const scope = await target(project);
        const parentTaskId = parentTask ? await resolveTaskId(client, scope.slug, parentTask) : undefined;
        const task = bounded(await client.createTask(scope.slug, withoutUndefined({
          ...fields, parentTaskId, clientRequestId,
        }) as Parameters<ProjectTaskClient["createTask"]>[1]), scope.session);
        return data({ created: compact(task) });
      }),
    },
    {
      name: "project_task_update",
      description: "Change a task's title, description, priority, assignee, labels, due date or blockers. Pass the baseRevision you read; a newer change is reported, not overwritten.",
      schema: UpdateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false },
      handler: (input: unknown) => safely(async () => {
        const { project, task, baseRevision, ...fields } = UpdateSchema.parse(input);
        const scope = await taskTarget(project, task);
        const updated = bounded(await client.updateTask(scope.slug, scope.taskId, { baseRevision, ...withoutUndefined(fields) }), scope.session);
        return data({ updated: compact(updated) });
      }),
    },
    {
      name: "project_task_move",
      description: "Move a task to another status (backlog, todo, in_progress, in_review, done, canceled). Closing a task whose agent is working is refused unless the user agreed and force is set.",
      schema: MoveSchema,
      annotations: { readOnlyHint: false, destructiveHint: false },
      handler: (input: unknown) => safely(async () => {
        const { project, task, ...move } = MoveSchema.parse(input);
        const scope = await taskTarget(project, task);
        const moved = bounded(await client.moveTask(scope.slug, scope.taskId, withoutUndefined(move) as z.infer<typeof MoveSchema>), scope.session);
        return data({ moved: compact(moved) });
      }),
    },
    {
      name: "project_task_comment",
      description: "Add a comment to a task, for example a progress note or a pull request link.",
      schema: CommentSchema,
      annotations: { readOnlyHint: false, destructiveHint: false },
      handler: (input: unknown) => safely(async () => {
        const { project, task, body } = CommentSchema.parse(input);
        const scope = await taskTarget(project, task);
        const comment = await client.createComment(scope.slug, scope.taskId, { body });
        return data({ comment: { id: comment.id, createdAt: comment.createdAt } });
      }),
    },
    {
      name: "project_task_start",
      description: "Start work on a task. Every task is a chat: kind chat prepares the task's own chat in the task's worktree (new, existing or none); kind terminal attaches a new terminal agent there. Nothing is sent: the result has agentStarted false and the firstMessage for the user to send.",
      schema: StartSchema,
      annotations: { readOnlyHint: false, destructiveHint: false },
      handler: (input: unknown) => safely(async () => {
        const { project, task, ...start } = StartSchema.parse(input);
        const scope = await taskTarget(project, task);
        const result = await client.startTask(scope.slug, scope.taskId, withoutUndefined(start) as z.infer<typeof StartSchema>);
        const started = { task: compact(bounded(result.task, scope.session)), session: result.session };
        if (result.firstMessage === undefined) return data({ ...started, agentStarted: true });
        // The session is open but nothing was sent to it; the caller must not report work as started.
        return data({
          ...started, agentStarted: false, firstMessage: result.firstMessage,
          note: "No agent turn was started. Ask the user to send firstMessage from the session.",
        });
      }),
    },
  ];
  return options.readOnly ? definitions.filter((definition) => definition.annotations.readOnlyHint) : definitions;
}

