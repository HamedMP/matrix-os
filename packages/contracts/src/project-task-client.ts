/**
 * One typed client for the project task routes (spec 2699), shared by the
 * `matrix tasks` CLI, the MCP tools and the kernel tools. The transport is
 * injected; callers supply their own authentication. Bodies and responses are
 * validated with the wire contract, and errors carry stable codes only.
 */
import { z } from "zod/v4";
import {
  CommentResponseSchema, CreateCommentBodySchema, CreateTaskBodySchema, ListActivityResponseSchema,
  ListCommentsResponseSchema, ListTasksQuerySchema, ListTasksResponseSchema, MoveTaskBodySchema,
  PROJECT_TASK_ERROR_CODES, PROJECT_TASK_SESSION_PATH, ProjectIdSchema, ProjectTaskErrorSchema, ProjectTaskSessionResponseSchema,
  projectTasksPath, StartTaskBodySchema, StartTaskResponseSchema, TASK_LIMITS, TaskCommentIdSchema, TaskIdSchema,
  TaskResponseSchema, UpdateTaskBodySchema,
  type CreateTaskBody, type ListTasksQuery, type MoveTaskBody, type ProjectTask, type StartTaskBody,
  type TaskActivity, type TaskComment, type TaskSession, type UpdateTaskBody,
} from "#project-tasks";

export const PROJECT_TASK_CLIENT_ERROR_CODES = [
  ...PROJECT_TASK_ERROR_CODES, "unauthorized", "unavailable", "timeout", "invalid_response",
] as const;
export type ProjectTaskClientErrorCode = (typeof PROJECT_TASK_CLIENT_ERROR_CODES)[number];

/** Generic, user-safe text for every client error code. */
export const PROJECT_TASK_CLIENT_MESSAGES: Record<ProjectTaskClientErrorCode, string> = {
  invalid_request: "The task request is not valid.",
  project_not_found: "Project not found.",
  task_not_found: "Task not found.",
  comment_not_found: "Comment not found.",
  task_revision_conflict: "The task changed since it was read. Read it again and retry.",
  task_agent_working: "An agent of this task is still working. Confirm with the user, then retry with force.",
  task_limit_reached: "The board has reached a limit.",
  task_relation_invalid: "That task relation is not allowed.",
  task_forbidden: "This session is not allowed to change that task.",
  board_unavailable: "The project board is unavailable. Try again shortly.",
  board_sync_unavailable: "Board sync is unavailable. Try again shortly.",
  task_session_unavailable: "The task session could not be started. Try again shortly.",
  task_session_not_found: "That chat or terminal was not found in this project.",
  task_session_taken: "That chat or terminal already belongs to another task.",
  unauthorized: "Not authorized to use the project board.",
  unavailable: "The project board is unavailable. Try again shortly.",
  timeout: "The project board did not answer in time. Try again.",
  invalid_response: "The project board returned an unexpected response.",
};

export class ProjectTaskClientError extends Error {
  readonly code: ProjectTaskClientErrorCode;
  readonly status: number | undefined;
  /** On `task_revision_conflict`, the server's current task. */
  readonly task: ProjectTask | undefined;

  constructor(code: ProjectTaskClientErrorCode, options: { status?: number; task?: ProjectTask } = {}) {
    super(PROJECT_TASK_CLIENT_MESSAGES[code]);
    this.name = "ProjectTaskClientError";
    this.code = code;
    this.status = options.status;
    this.task = options.task;
  }
}

export type ProjectTaskFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ProjectTaskList { tasks: ProjectTask[]; nextCursor: string | null }

/** A page request for comments (cursor: a comment id) or activity (cursor: an activity sequence number). */
export interface ProjectTaskPage { cursor?: string; limit?: number }

export interface ProjectTaskClient {
  listTasks(projectSlug: string, query?: ListTasksQuery): Promise<ProjectTaskList>;
  getTask(projectSlug: string, taskId: string): Promise<ProjectTask>;
  createTask(projectSlug: string, body: CreateTaskBody): Promise<ProjectTask>;
  updateTask(projectSlug: string, taskId: string, body: UpdateTaskBody): Promise<ProjectTask>;
  moveTask(projectSlug: string, taskId: string, body: MoveTaskBody): Promise<ProjectTask>;
  listComments(projectSlug: string, taskId: string, page?: ProjectTaskPage): Promise<{ comments: TaskComment[]; nextCursor: string | null }>;
  createComment(projectSlug: string, taskId: string, body: { body: string }): Promise<TaskComment>;
  listActivity(projectSlug: string, taskId: string, page?: ProjectTaskPage): Promise<{ activity: TaskActivity[]; nextCursor: string | null }>;
  /** `firstMessage` is set when the server opened the session without sending it (no model selection, or a terminal). */
  /** `session` is the attached terminal, or null for a chat start (the task's chat is `task.chatId`). */
  startTask(projectSlug: string, taskId: string, body: StartTaskBody): Promise<{ task: ProjectTask; session: TaskSession | null; firstMessage?: string }>;
}

export interface ProjectSummary { id: string; slug: string; name: string }

/** Lists the owner's projects, used to turn a session's `proj_…` id into its slug. */
export interface ProjectDirectory {
  listProjects(): Promise<ProjectSummary[]>;
  /** The project a session credential is bound to, from the gateway; null for an owner credential. */
  getSession(): Promise<ProjectTaskSession | null>;
}

export interface ProjectTaskHttpClientOptions {
  baseUrl: string;
  fetch?: ProjectTaskFetch;
  /** Authentication headers for each request; a throw means no usable credential. */
  headers: () => Record<string, string>;
  timeoutMs?: number;
  /** Start work creates worktrees and sessions, so it gets a longer deadline. */
  startTimeoutMs?: number;
}

/** Matches the gateway's project registry slugs. */
export const PROJECT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** Display keys such as `MOS-42`; case-insensitive on input. */
const TASK_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]{1,9}-[1-9][0-9]{0,8}$/;
/** Lists are read in pages of this many items, following the cursor, so each response has a fixed bound. */
export const PROJECT_TASK_CLIENT_PAGE_LIMIT = 50;
// JSON escapes a control character as six bytes; that covers UTF-8 (at most three per UTF-16 unit) too.
const JSON_BYTES_PER_CHAR = 6;
const KIB = 1024;
/** The largest task the contract allows: its description plus every other bounded field, with headroom. */
const MAX_TASK_BYTES = TASK_LIMITS.description * JSON_BYTES_PER_CHAR + 128 * KIB;
const MAX_COMMENT_BYTES = TASK_LIMITS.comment * JSON_BYTES_PER_CHAR + 4 * KIB;
const MAX_ACTIVITY_BYTES = 400 * JSON_BYTES_PER_CHAR + 4 * KIB;
const MAX_PROJECT_BYTES = 200 * JSON_BYTES_PER_CHAR + 2 * KIB;
const ENVELOPE_BYTES = 64 * KIB;
const RESPONSE_BYTES = {
  /** One task, a mutation's answer, an error with the current task, or a start with its first message. */
  single: 2 * MAX_TASK_BYTES + (TASK_LIMITS.comment + 1_000) * JSON_BYTES_PER_CHAR + ENVELOPE_BYTES,
  tasks: PROJECT_TASK_CLIENT_PAGE_LIMIT * MAX_TASK_BYTES + ENVELOPE_BYTES,
  comments: PROJECT_TASK_CLIENT_PAGE_LIMIT * MAX_COMMENT_BYTES + ENVELOPE_BYTES,
  activity: PROJECT_TASK_CLIENT_PAGE_LIMIT * MAX_ACTIVITY_BYTES + ENVELOPE_BYTES,
  projects: 5_000 * MAX_PROJECT_BYTES + ENVELOPE_BYTES,
} as const;
/** Pages followed for one list call; a short or empty page also stops, so a looping cursor ends. */
const MAX_PAGES = Math.ceil(TASK_LIMITS.listMax / PROJECT_TASK_CLIENT_PAGE_LIMIT);
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_START_TIMEOUT_MS = 30_000;
const KEY_SEARCH_LIMIT = PROJECT_TASK_CLIENT_PAGE_LIMIT;
const KEY_SEARCH_PAGES = Math.ceil(TASK_LIMITS.tasksPerProject / KEY_SEARCH_LIMIT);

const ProjectListResponseSchema = z.object({
  projects: z.array(z.object({ id: ProjectIdSchema, slug: z.string().regex(PROJECT_SLUG_PATTERN), name: z.string().max(200) })).max(5_000),
});

export function isTaskKey(value: string): boolean {
  return TASK_KEY_PATTERN.test(value);
}

export function newTaskClientRequestId(): string {
  return `req_${globalThis.crypto.randomUUID()}`;
}

function invalid(): ProjectTaskClientError {
  return new ProjectTaskClientError("invalid_request");
}

function parseOrInvalid<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalid();
  return parsed.data;
}

function slugPath(projectSlug: string): string {
  if (!PROJECT_SLUG_PATTERN.test(projectSlug)) throw invalid();
  return projectTasksPath(projectSlug);
}

function taskPath(projectSlug: string, taskId: string): string {
  if (!TaskIdSchema.safeParse(taskId).success) throw invalid();
  return `${slugPath(projectSlug)}/${taskId}`;
}

const ACTIVITY_CURSOR = /^(?:0|[1-9][0-9]{0,15})$/;
const PageLimitSchema = z.number().int().min(1).max(TASK_LIMITS.listMax).optional();

/** Validates a comments page (`cursor`) or an activity page (`after`) request. */
function checkPage(page: ProjectTaskPage, cursorName: "cursor" | "after"): void {
  const cursorValid = page.cursor === undefined
    || (cursorName === "after" ? ACTIVITY_CURSOR.test(page.cursor) : TaskCommentIdSchema.safeParse(page.cursor).success);
  if (!cursorValid || !PageLimitSchema.safeParse(page.limit).success) throw invalid();
}

/**
 * Up to `limit` items (the server's default when unset), read in pages of
 * PROJECT_TASK_CLIENT_PAGE_LIMIT. The cursor returned continues after the last item.
 */
async function collectPages<T>(
  limit: number | undefined,
  cursor: string | undefined,
  fetchPage: (cursor: string | undefined, limit: number) => Promise<{ items: T[]; nextCursor: string | null }>,
): Promise<{ items: T[]; nextCursor: string | null }> {
  const wanted = limit ?? TASK_LIMITS.listDefault;
  const items: T[] = [];
  let next: string | null = cursor ?? null;
  for (let page = 0; page < MAX_PAGES && items.length < wanted; page += 1) {
    const pageLimit = Math.min(PROJECT_TASK_CLIENT_PAGE_LIMIT, wanted - items.length);
    const result = await fetchPage(next ?? undefined, pageLimit);
    items.push(...result.items);
    next = result.nextCursor;
    // A short page (or an empty one) ends this call; the caller continues from the cursor.
    if (!next || result.items.length < pageLimit) break;
  }
  return { items, nextCursor: next };
}

async function readBounded(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.body) throw new ProjectTaskClientError("invalid_response", { status: response.status });
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new ProjectTaskClientError("invalid_response", { status: response.status });
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
    if (size > maxBytes) {
      await response.body.cancel().catch((error: unknown) => {
        console.warn("[project-task-client] response cleanup failed", error instanceof Error ? error.name : "unknown_error");
      });
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) throw error;
    return undefined;
  }
}

function isTimeout(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
}

export function createProjectTaskHttpClient(options: ProjectTaskHttpClientOptions): ProjectTaskClient & ProjectDirectory {
  const fetcher = options.fetch ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");

  async function request<T>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
    timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBytes: number = RESPONSE_BYTES.single,
  ): Promise<T> {
    let headers: Headers;
    try {
      headers = new Headers(options.headers());
    } catch (error: unknown) {
      console.warn("[project-task-client] credentials unavailable", error instanceof Error ? error.name : "unknown_error");
      throw new ProjectTaskClientError("unauthorized");
    }
    if (body !== undefined) headers.set("content-type", "application/json");
    let response: Response;
    try {
      response = await fetcher(`${baseUrl}${path}`, {
        method, headers, redirect: "error", signal: AbortSignal.timeout(timeoutMs),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error: unknown) {
      if (isTimeout(error)) throw new ProjectTaskClientError("timeout");
      console.warn("[project-task-client] request failed", error instanceof Error ? error.name : "unknown_error");
      throw new ProjectTaskClientError("unavailable");
    }
    let payload: unknown;
    try {
      payload = await readBounded(response, maxBytes);
    } catch (error: unknown) {
      if (error instanceof ProjectTaskClientError) throw error;
      if (isTimeout(error)) throw new ProjectTaskClientError("timeout");
      console.warn("[project-task-client] response unreadable", error instanceof Error ? error.name : "unknown_error");
      throw new ProjectTaskClientError("unavailable", { status: response.status });
    }
    if (!response.ok) {
      const failure = ProjectTaskErrorSchema.safeParse(payload);
      if (failure.success) {
        throw new ProjectTaskClientError(failure.data.error.code, {
          status: response.status, ...(failure.data.task ? { task: failure.data.task } : {}),
        });
      }
      const code = response.status === 401 || response.status === 403 ? "unauthorized" : "unavailable";
      throw new ProjectTaskClientError(code, { status: response.status });
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) throw new ProjectTaskClientError("invalid_response", { status: response.status });
    return parsed.data;
  }

  return {
    async listTasks(projectSlug, query = {}) {
      const path = slugPath(projectSlug);
      const parsed = parseOrInvalid(ListTasksQuerySchema, query);
      const { items, nextCursor } = await collectPages(parsed.limit, query.cursor, async (cursor, limit) => {
        const search = new URLSearchParams();
        for (const key of ["status", "assignee", "label", "q"] as const) {
          const value = query[key];
          if (value !== undefined) search.set(key, String(value));
        }
        if (cursor !== undefined) search.set("cursor", cursor);
        search.set("limit", String(limit));
        if (query.includeArchived !== undefined) search.set("includeArchived", String(query.includeArchived));
        const page = await request("GET", `${path}?${search.toString()}`, ListTasksResponseSchema, undefined, undefined, RESPONSE_BYTES.tasks);
        return { items: page.tasks, nextCursor: page.nextCursor };
      });
      return { tasks: items, nextCursor };
    },
    async getTask(projectSlug, taskId) {
      return (await request("GET", taskPath(projectSlug, taskId), TaskResponseSchema)).task;
    },
    async createTask(projectSlug, body) {
      const path = slugPath(projectSlug);
      return (await request("POST", path, TaskResponseSchema, parseOrInvalid(CreateTaskBodySchema, body))).task;
    },
    async updateTask(projectSlug, taskId, body) {
      const path = taskPath(projectSlug, taskId);
      return (await request("PATCH", path, TaskResponseSchema, parseOrInvalid(UpdateTaskBodySchema, body))).task;
    },
    async moveTask(projectSlug, taskId, body) {
      const path = `${taskPath(projectSlug, taskId)}/move`;
      return (await request("POST", path, TaskResponseSchema, parseOrInvalid(MoveTaskBodySchema, body))).task;
    },
    async listComments(projectSlug, taskId, page = {}) {
      const path = `${taskPath(projectSlug, taskId)}/comments`;
      checkPage(page, "cursor");
      const { items, nextCursor } = await collectPages(page.limit, page.cursor, async (cursor, limit) => {
        const search = new URLSearchParams({ ...(cursor !== undefined ? { cursor } : {}), limit: String(limit) });
        const result = await request("GET", `${path}?${search.toString()}`, ListCommentsResponseSchema, undefined, undefined, RESPONSE_BYTES.comments);
        return { items: result.comments, nextCursor: result.nextCursor };
      });
      return { comments: items, nextCursor };
    },
    async createComment(projectSlug, taskId, body) {
      const path = `${taskPath(projectSlug, taskId)}/comments`;
      return (await request("POST", path, CommentResponseSchema, parseOrInvalid(CreateCommentBodySchema, body))).comment;
    },
    async listActivity(projectSlug, taskId, page = {}) {
      const path = `${taskPath(projectSlug, taskId)}/activity`;
      checkPage(page, "after");
      const { items, nextCursor } = await collectPages(page.limit, page.cursor, async (cursor, limit) => {
        const search = new URLSearchParams({ ...(cursor !== undefined ? { after: cursor } : {}), limit: String(limit) });
        const result = await request("GET", `${path}?${search.toString()}`, ListActivityResponseSchema, undefined, undefined, RESPONSE_BYTES.activity);
        return { items: result.activity, nextCursor: result.nextCursor };
      });
      return { activity: items, nextCursor };
    },
    async startTask(projectSlug, taskId, body) {
      const path = `${taskPath(projectSlug, taskId)}/start`;
      return request("POST", path, StartTaskResponseSchema, parseOrInvalid(StartTaskBodySchema, body),
        options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS);
    },
    async listProjects() {
      return (await request("GET", "/api/workspace/projects?visibility=all", ProjectListResponseSchema, undefined, undefined, RESPONSE_BYTES.projects)).projects;
    },
    async getSession() {
      const { session } = await request("GET", PROJECT_TASK_SESSION_PATH, ProjectTaskSessionResponseSchema);
      return session ? { projectId: session.projectId, projectSlug: session.projectSlug, ...(session.taskId ? { taskId: session.taskId } : {}) } : null;
    },
  };
}

/** A `task_…` id as given, or a display key such as `MOS-42` resolved through search. */
export async function resolveTaskId(client: Pick<ProjectTaskClient, "listTasks">, projectSlug: string, ref: string): Promise<string> {
  if (TaskIdSchema.safeParse(ref).success) return ref;
  if (!isTaskKey(ref)) throw invalid();
  const key = ref.toUpperCase();
  // Title matches can rank ahead of the exact key, so follow pages to the end of a full board.
  let cursor: string | undefined;
  for (let page = 0; page < KEY_SEARCH_PAGES; page += 1) {
    const result = await client.listTasks(projectSlug, {
      q: key, limit: KEY_SEARCH_LIMIT, includeArchived: "true", ...(cursor ? { cursor } : {}),
    });
    const match = result.tasks.find((task) => task.key.toUpperCase() === key);
    if (match) return match.id;
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  throw new ProjectTaskClientError("task_not_found");
}

export async function resolveProjectSlug(directory: ProjectDirectory, projectId: string): Promise<string> {
  if (!ProjectIdSchema.safeParse(projectId).success) throw invalid();
  const project = (await directory.listProjects()).find((candidate) => candidate.id === projectId);
  if (!project) throw new ProjectTaskClientError("project_not_found");
  return project.slug;
}

/** The project an agent session belongs to; its tools and CLI calls stay inside it. */
export interface ProjectTaskSession {
  projectId: string;
  projectSlug: string;
  /** The session's own task, the default for task arguments. */
  taskId?: string;
}

export function projectMatchesSession(session: Pick<ProjectTaskSession, "projectId" | "projectSlug">, project: string): boolean {
  return project === session.projectSlug || project === session.projectId;
}
