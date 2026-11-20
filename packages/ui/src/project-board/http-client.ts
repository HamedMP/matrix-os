import { z } from "zod/v4";
import {
  AttachableSessionsResponseSchema, BoardMembersResponseSchema, BoardSettingsResponseSchema, CommentResponseSchema,
  ListActivityResponseSchema, ListCommentsResponseSchema, ListTasksResponseSchema, ProjectTaskErrorSchema, StartTaskResponseSchema,
  TASK_LIMITS, TaskGitResponseSchema, TaskIdSchema, TaskResponseSchema, TaskSessionRefSchema, projectBoardPath, projectTasksPath,
  type ProjectTaskErrorCode,
} from "@matrix-os/contracts/project-tasks";
import {
  GENERIC_BOARD_ERROR, PROJECT_BOARD_EVENT_TYPES, ProjectBoardRequestError, TaskAgentWorkingError, TaskConflictError,
  type ProjectBoardClient, type ProjectBoardEvent, type ProjectBoardEventType,
} from "./client.js";
import type { ProjectTask } from "./types.js";

export interface HttpProjectBoardClientOptions {
  /** The gateway base, as `getGatewayUrl()` returns it (origin plus any `/vm/<handle>` prefix). */
  gatewayUrl: string;
  projectSlug: string;
  fetch?: typeof globalThis.fetch;
}

const PROJECT_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Whether a project slug can address the board routes; `createHttpProjectBoardClient` throws otherwise. */
export function isProjectBoardSlug(slug: string): boolean {
  return PROJECT_SLUG.test(slug);
}
const REQUEST_TIMEOUT_MS = 10_000;
/** 500 tasks with full descriptions stay under this; anything larger is refused. */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const LIST_PAGE_SIZE = TASK_LIMITS.listMax;
/** Comments and activity follow `nextCursor` this many pages at most. */
const MAX_DETAIL_PAGES = 20;

const POLL_MS = 2_000;
const POLL_BACKOFF_MS = 10_000;
const EVENTS_PAGE_SIZE = 100;
/** The first poll skips the existing backlog; it walks this many pages at most. */
const MAX_BASELINE_PAGES = 50;
/** A later poll catches up this many pages before waiting for the next tick. */
const MAX_CATCH_UP_PAGES = 10;
const MAX_LISTENERS = 32;

/** Local copy for server error codes. Server messages are never shown. */
const ERROR_COPY: Partial<Record<ProjectTaskErrorCode, string>> = {
  project_not_found: "This project is no longer available.",
  task_not_found: "That task no longer exists.",
  comment_not_found: "That comment no longer exists.",
  task_limit_reached: "This board is full.",
  task_relation_invalid: "Those tasks can't be linked that way.",
  task_forbidden: "You can't change this task.",
  task_session_unavailable: "That chat or terminal isn't available.",
};

const WorkspaceEventsResponseSchema = z.object({
  events: z.array(z.object({
    id: z.string().regex(/^evt_[A-Za-z0-9_-]{1,128}$/),
    type: z.string().min(1).max(100),
    scope: z.object({ taskId: z.string().max(140).optional() }),
    payload: z.record(z.string(), z.unknown()),
  })).max(EVENTS_PAGE_SIZE),
  nextCursor: z.string().max(140).nullable(),
});

const OkResponseSchema = z.object({ ok: z.literal(true) });

const BOARD_EVENT_TYPES: readonly string[] = PROJECT_BOARD_EVENT_TYPES;

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function taskPath(base: string, taskId: string, suffix = ""): string {
  if (!TaskIdSchema.safeParse(taskId).success) throw new ProjectBoardRequestError("That task no longer exists.", "task_not_found");
  return `${base}/${encodeURIComponent(taskId)}${suffix}`;
}

interface RequestOptions<T> {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  query?: Record<string, string | undefined>;
  body?: unknown;
  schema: z.ZodType<T>;
}

/**
 * `ProjectBoardClient` over the gateway's `/api/projects/:slug/{tasks,board}`
 * routes. Every response is checked against the spec 2699 contract; failures
 * surface as `ProjectBoardRequestError` with local copy. Change signals come
 * from polling `/api/workspace/events` while anyone is subscribed.
 */
export function createHttpProjectBoardClient(options: HttpProjectBoardClientOptions): ProjectBoardClient {
  if (!isProjectBoardSlug(options.projectSlug)) throw new TypeError("invalid project slug");
  // Every call below passes `signal: AbortSignal.timeout(...)`.
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const gateway = options.gatewayUrl.replace(/\/+$/, "");
  const slug = options.projectSlug;
  const tasks = projectTasksPath(slug);
  const board = projectBoardPath(slug);

  async function request<T>(path: string, { method = "GET", query, body, schema }: RequestOptions<T>): Promise<T> {
    const url = new URL(`${gateway}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) url.searchParams.set(key, value);
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await fetcher(url.toString(), {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error: unknown) {
      console.warn("[project-board] request failed", method, errorName(error));
      throw new ProjectBoardRequestError();
    }
    const payload = await readJson(response);
    if (!response.ok) throw mapFailure(response.status, payload);
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      console.warn("[project-board] response did not match the contract", method, response.status);
      throw new ProjectBoardRequestError();
    }
    return parsed.data;
  }

  async function readJson(response: Response): Promise<unknown> {
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > MAX_RESPONSE_BYTES) return undefined;
    try {
      const text = await response.text();
      return text.length > MAX_RESPONSE_BYTES || text === "" ? undefined : JSON.parse(text) as unknown;
    } catch (error: unknown) {
      console.warn("[project-board] response body could not be read", response.status, errorName(error));
      return undefined;
    }
  }

  function mapFailure(status: number, payload: unknown): Error {
    const parsed = ProjectTaskErrorSchema.safeParse(payload);
    const code = parsed.success ? parsed.data.error.code : undefined;
    console.warn("[project-board] request rejected", status, code ?? "unknown");
    if (code === "task_revision_conflict" && parsed.success && parsed.data.task) return new TaskConflictError(parsed.data.task);
    if (code === "task_agent_working") return new TaskAgentWorkingError();
    return new ProjectBoardRequestError((code && ERROR_COPY[code]) ?? GENERIC_BOARD_ERROR, code);
  }

  /** Follows `nextCursor` through a paged list up to `maxItems` or `maxPages`. */
  async function collect<T>(load: (cursor: string | undefined) => Promise<{ items: readonly T[]; nextCursor: string | null }>, maxPages: number, maxItems = Number.POSITIVE_INFINITY): Promise<T[]> {
    const items: T[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages && items.length < maxItems; page += 1) {
      const result = await load(cursor);
      items.push(...result.items);
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return items.slice(0, maxItems);
  }

  // -------------------------------------------------------------------------
  // Change signals.

  const listeners: Array<(event: ProjectBoardEvent) => void> = [];
  let cursor: string | undefined;
  let baselineDone = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;

  function schedule(delayMs: number): void {
    if (timer !== null || listeners.length === 0) return;
    timer = setTimeout(() => {
      timer = null;
      void poll();
    }, delayMs);
  }

  async function poll(): Promise<void> {
    if (inFlight || listeners.length === 0) return;
    inFlight = true;
    let delay = POLL_MS;
    try {
      const fresh = await readEvents(baselineDone ? MAX_CATCH_UP_PAGES : MAX_BASELINE_PAGES);
      if (baselineDone) emit(fresh);
      baselineDone = true;
    } catch (error: unknown) {
      console.warn("[project-board] change poll failed", errorName(error));
      delay = POLL_BACKOFF_MS;
    } finally {
      inFlight = false;
    }
    schedule(delay);
  }

  async function readEvents(maxPages: number): Promise<ProjectBoardEvent[]> {
    const found: ProjectBoardEvent[] = [];
    for (let page = 0; page < maxPages; page += 1) {
      const result = await request("/api/workspace/events", {
        query: { projectSlug: slug, cursor, limit: String(EVENTS_PAGE_SIZE) }, schema: WorkspaceEventsResponseSchema,
      });
      for (const event of result.events) {
        const taskId = event.scope.taskId;
        if (!BOARD_EVENT_TYPES.includes(event.type) || !taskId || !TaskIdSchema.safeParse(taskId).success) continue;
        const revision = typeof event.payload.revision === "number" && Number.isInteger(event.payload.revision) ? event.payload.revision : 0;
        found.push({ type: event.type as ProjectBoardEventType, taskId, revision });
      }
      const last = result.events.at(-1);
      if (last) cursor = last.id;
      if (!result.nextCursor || !last) break;
    }
    // One signal per task per poll: listeners refetch, so repeats only cost requests.
    return found.filter((event, index) => !found.slice(index + 1).some((later) => later.taskId === event.taskId));
  }

  function emit(events: readonly ProjectBoardEvent[]): void {
    for (const event of events) {
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch (error: unknown) {
          console.warn("[project-board] change listener failed", errorName(error));
        }
      }
    }
  }

  return {
    async listTasks(listOptions = {}) {
      return collect(async (pageCursor) => {
        const page = await request(tasks, {
          query: { limit: String(LIST_PAGE_SIZE), includeArchived: listOptions.includeArchived ? "true" : "false", cursor: pageCursor },
          schema: ListTasksResponseSchema,
        });
        return { items: page.tasks, nextCursor: page.nextCursor };
      }, Math.ceil(TASK_LIMITS.tasksPerProject / LIST_PAGE_SIZE), TASK_LIMITS.tasksPerProject);
    },

    async getTask(taskId) {
      return (await request(taskPath(tasks, taskId), { schema: TaskResponseSchema })).task;
    },

    async createTask(input) {
      return (await request(tasks, { method: "POST", body: input, schema: TaskResponseSchema })).task;
    },

    async updateTask(taskId, baseRevision, input) {
      return (await request(taskPath(tasks, taskId), { method: "PATCH", body: { baseRevision, ...input }, schema: TaskResponseSchema })).task;
    },

    async moveTask(taskId, input) {
      return (await request(taskPath(tasks, taskId, "/move"), { method: "POST", body: input, schema: TaskResponseSchema })).task;
    },

    async archiveTask(taskId, archived) {
      const suffix = archived ? "/archive" : "/unarchive";
      return (await request(taskPath(tasks, taskId, suffix), { method: "POST", body: {}, schema: TaskResponseSchema })).task;
    },

    async deleteTask(taskId) {
      await request(taskPath(tasks, taskId), { method: "DELETE", body: {}, schema: OkResponseSchema });
    },

    async listComments(taskId) {
      const path = taskPath(tasks, taskId, "/comments");
      return collect(async (pageCursor) => {
        const page = await request(path, { query: { cursor: pageCursor }, schema: ListCommentsResponseSchema });
        return { items: page.comments, nextCursor: page.nextCursor };
      }, MAX_DETAIL_PAGES);
    },

    async addComment(taskId, body) {
      return (await request(taskPath(tasks, taskId, "/comments"), { method: "POST", body: { body }, schema: CommentResponseSchema })).comment;
    },

    async listActivity(taskId) {
      const path = taskPath(tasks, taskId, "/activity");
      return collect(async (after) => {
        const page = await request(path, { query: { after }, schema: ListActivityResponseSchema });
        return { items: page.activity, nextCursor: page.nextCursor };
      }, MAX_DETAIL_PAGES);
    },

    async startSession(taskId, input) {
      return (await request(taskPath(tasks, taskId, "/start"), { method: "POST", body: input, schema: StartTaskResponseSchema })).session;
    },

    async listAttachableSessions() {
      return (await request(`${board}/attachable-sessions`, { schema: AttachableSessionsResponseSchema })).sessions;
    },

    async attachSession(taskId, session) {
      const { task } = await request(taskPath(tasks, taskId, "/sessions"), { method: "POST", body: { ref: session.ref }, schema: TaskResponseSchema });
      const attached = task.sessions.find((candidate) => candidate.ref === session.ref);
      if (!attached) throw new ProjectBoardRequestError("That chat or terminal isn't available.", "task_session_unavailable");
      return attached;
    },

    async detachSession(taskId, ref): Promise<ProjectTask> {
      if (!TaskSessionRefSchema.safeParse(ref).success) throw new ProjectBoardRequestError("That chat or terminal isn't available.", "task_session_unavailable");
      const path = taskPath(tasks, taskId, `/sessions/${encodeURIComponent(ref)}`);
      return (await request(path, { method: "DELETE", body: {}, schema: TaskResponseSchema })).task;
    },

    async getGitSummary(taskId) {
      return (await request(taskPath(tasks, taskId, "/git"), { schema: TaskGitResponseSchema })).git;
    },

    async createPullRequest(taskId) {
      return (await request(taskPath(tasks, taskId, "/pull-request"), { method: "POST", body: {}, schema: TaskResponseSchema })).task;
    },

    async listMembers() {
      return (await request(`${board}/members`, { schema: BoardMembersResponseSchema })).members;
    },

    async getSettings() {
      return (await request(`${board}/settings`, { schema: BoardSettingsResponseSchema })).settings;
    },

    async updateSettings(input) {
      return (await request(`${board}/settings`, { method: "PUT", body: input, schema: BoardSettingsResponseSchema })).settings;
    },

    subscribe(listener) {
      if (listeners.length >= MAX_LISTENERS) {
        listeners.shift();
        console.warn("[project-board] too many change listeners; dropped the oldest");
      }
      listeners.push(listener);
      if (!inFlight) schedule(baselineDone ? POLL_MS : 0);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
        if (listeners.length === 0 && timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      };
    },
  };
}
