/**
 * Board routes under `/api/projects/:slug` (spec 2699 section 2). Params,
 * queries and bodies are validated here with the contract's Zod schemas; every
 * mutating route, DELETE included, has a body limit; errors leave as stable
 * codes with generic messages.
 */
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import {
  ArchiveTaskBodySchema, AttachSessionBodySchema, CreateCommentBodySchema, CreatePullRequestBodySchema, StartTaskBodySchema, TaskSessionRefSchema, CreateTaskBodySchema, TaskCommentIdSchema, UpdateCommentBodySchema, ListTasksQuerySchema, MoveTaskBodySchema, TASK_LIMITS, TaskIdSchema,
  UpdateBoardSettingsBodySchema, UpdateTaskBodySchema, type ActorRef,
} from "@matrix-os/contracts/project-tasks";
import { PROJECT_SLUG_REGEX } from "../project-registry.js";
import { isRequestPrincipalError, mapRequestPrincipalError, type RequestPrincipal } from "../request-principal.js";
import type { OwnerScope } from "../state-ops.js";
import { ProjectFenceError, type LegacyProjectOperationAdmission } from "../collaboration/project-fence.js";
import { ProjectTaskError, projectTaskErrorBody } from "./errors.js";
import { ownerActor } from "./members.js";
import type { ProjectTaskService, TaskCaller } from "./service.js";
import type { ProjectTaskWork } from "./work.js";

const SlugSchema = z.string().regex(PROJECT_SLUG_REGEX);
const ActivityQuerySchema = z.object({
  after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.coerce.number().int().min(1).max(TASK_LIMITS.listMax).default(TASK_LIMITS.listDefault),
});

const CommentsQuerySchema = z.object({
  cursor: TaskCommentIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(TASK_LIMITS.listMax).default(TASK_LIMITS.listDefault),
});

export interface ProjectTaskRouteOptions {
  /** Null when the owner database is unavailable: every route answers 503. */
  service: ProjectTaskService | null;
  getOwnerScope(c: Context): OwnerScope;
  /** Agent principals act as `agent:<session ref>`; everyone else as `user:<id>`. */
  getActor?(c: Context, ownerScope: OwnerScope): ActorRef;
  projectOperationAdmission?: LegacyProjectOperationAdmission;
  /** Start work, sessions, git and pull requests; null or absent answers 503 on those routes. */
  work?: ProjectTaskWork | null;
  /** The request principal, used to admit a chat's first turn on start. */
  getPrincipal?(c: Context): RequestPrincipal;
}

class InvalidInput extends Error {}


async function readBody<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch (error: unknown) {
    if (error instanceof SyntaxError || (error instanceof Error && error.name === "BodyLimitError")) throw new InvalidInput();
    throw error;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new InvalidInput();
  return parsed.data;
}

function param<T>(schema: z.ZodType<T>, value: string | undefined): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new InvalidInput();
  return parsed.data;
}

function query<T>(c: Context, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) throw new InvalidInput();
  return parsed.data;
}

/** The shared-project fence for one write; callers outside shared projects run directly. */
export function createProjectTaskAdmission(admission: LegacyProjectOperationAdmission | undefined) {
  return async <T>(who: TaskCaller, projectId: string, run: () => Promise<T>): Promise<T> => {
    if (!admission) return run();
    return admission.withLegacyAdmission({
      ownerType: who.ownerScope.type === "org" ? "organization" : "personal",
      ownerId: who.ownerScope.id,
      projectId,
      kind: "write",
    }, run);
  };
}

export function createProjectTaskRoutes(options: ProjectTaskRouteOptions): Hono {
  const app = new Hono();
  const admitWrite = createProjectTaskAdmission(options.projectOperationAdmission);
  const limited = bodyLimit({
    maxSize: TASK_LIMITS.bodyBytes,
    onError: (c) => c.json(projectTaskErrorBody("invalid_request"), 413),
  });

  function respond(c: Context, error: unknown) {
    if (error instanceof InvalidInput) return c.json(projectTaskErrorBody("invalid_request"), 400);
    if (error instanceof ProjectTaskError) return c.json(error.body(), error.status);
    if (isRequestPrincipalError(error)) {
      const mapped = mapRequestPrincipalError(error, "Board request failed");
      if (mapped.log) console.error("[project-tasks] request principal misconfigured", error.name);
      return c.json({ error: { code: mapped.status === 401 ? "unauthorized" : "board_unavailable", message: mapped.body.error } }, mapped.status);
    }
    if (error instanceof ProjectFenceError) {
      if (error.code === "not_found") return c.json(projectTaskErrorBody("project_not_found"), 404);
      if (error.code === "capacity" || error.code === "unavailable") return c.json(projectTaskErrorBody("board_unavailable"), 503);
      return c.json(projectTaskErrorBody("task_forbidden"), 409);
    }
    console.error("[project-tasks] request failed", error instanceof Error ? error.name : typeof error);
    return c.json(projectTaskErrorBody("board_unavailable"), 503);
  }

  function caller(c: Context): TaskCaller {
    const ownerScope = options.getOwnerScope(c);
    return { ownerScope, actor: options.getActor?.(c, ownerScope) ?? ownerActor(ownerScope) };
  }

  function service(): ProjectTaskService {
    if (!options.service) throw new ProjectTaskError("board_unavailable");
    return options.service;
  }

  /** Writes go through the shared-project fence, as the legacy task routes did. */
  async function write<T>(who: TaskCaller, slug: string, run: () => Promise<T>): Promise<T> {
    if (!options.projectOperationAdmission) return run();
    const { project } = await service().resolve(who, slug);
    return admitWrite(who, project.id, run);
  }

  function work(): ProjectTaskWork {
    if (!options.work) throw new ProjectTaskError("board_unavailable");
    return options.work;
  }

  const base = "/api/projects/:slug/tasks";

  app.get(base, async (c) => {
    try {
      const slug = param(SlugSchema, c.req.param("slug"));
      return c.json(await service().listTasks(caller(c), slug, query(c, ListTasksQuerySchema)));
    } catch (error: unknown) { return respond(c, error); }
  });

  app.post(base, limited, async (c) => {
    try {
      const slug = param(SlugSchema, c.req.param("slug"));
      const who = caller(c);
      const body = await readBody(c, CreateTaskBodySchema);
      const { task, created } = await write(who, slug, () => service().createTask(who, slug, body));
      return c.json({ task }, created ? 201 : 200);
    } catch (error: unknown) { return respond(c, error); }
  });

  app.get(`${base}/:taskId`, async (c) => {
    try {
      const slug = param(SlugSchema, c.req.param("slug"));
      return c.json({ task: await service().getTask(caller(c), slug, param(TaskIdSchema, c.req.param("taskId"))) });
    } catch (error: unknown) { return respond(c, error); }
  });

  app.patch(`${base}/:taskId`, limited, async (c) => {
    try {
      const slug = param(SlugSchema, c.req.param("slug"));
      const taskId = param(TaskIdSchema, c.req.param("taskId"));
      const who = caller(c);
      const body = await readBody(c, UpdateTaskBodySchema);
      return c.json({ task: await write(who, slug, () => service().updateTask(who, slug, taskId, body)) });
    } catch (error: unknown) { return respond(c, error); }
  });

  app.post(`${base}/:taskId/move`, limited, async (c) => {
    try {
      const slug = param(SlugSchema, c.req.param("slug"));
      const taskId = param(TaskIdSchema, c.req.param("taskId"));
      const who = caller(c);
      const body = await readBody(c, MoveTaskBodySchema);
      return c.json({ task: await write(who, slug, () => service().moveTask(who, slug, taskId, body)) });
    } catch (error: unknown) { return respond(c, error); }
  });

  for (const [action, archived] of [["archive", true], ["unarchive", false]] as const) {
    app.post(`${base}/:taskId/${action}`, limited, async (c) => {
      try {
        const slug = param(SlugSchema, c.req.param("slug"));
        const taskId = param(TaskIdSchema, c.req.param("taskId"));
        const who = caller(c);
        await readBody(c, ArchiveTaskBodySchema);
        return c.json({ task: await write(who, slug, () => service().setArchived(who, slug, taskId, archived)) });
      } catch (error: unknown) { return respond(c, error); }
    });
  }

  app.delete(`${base}/:taskId`, limited, async (c) => {
    try {
      const slug = param(SlugSchema, c.req.param("slug"));
      const taskId = param(TaskIdSchema, c.req.param("taskId"));
      const who = caller(c);
      if (c.req.header("content-length") !== "0" && c.req.header("content-type")?.includes("json")) await readBody(c, ArchiveTaskBodySchema);
      await write(who, slug, () => service().deleteTask(who, slug, taskId));
      return c.json({ ok: true });
    } catch (error: unknown) { return respond(c, error); }
  });

  app.get(`${base}/:taskId/activity`, async (c) => {
    try {
      const slug = param(SlugSchema, c.req.param("slug"));
      const taskId = param(TaskIdSchema, c.req.param("taskId"));
      const { after, limit } = query(c, ActivityQuerySchema);
      return c.json(await service().listActivity(caller(c), slug, taskId, after, limit));
    } catch (error: unknown) { return respond(c, error); }
  });

  app.get(`${base}/:taskId/comments`, async (c) => {
    try {
      const slug = param(SlugSchema, c.req.param("slug"));
      const taskId = param(TaskIdSchema, c.req.param("taskId"));
      const { cursor, limit } = query(c, CommentsQuerySchema);
      return c.json(await service().listComments(caller(c), slug, taskId, cursor, limit));
    } catch (error: unknown) { return respond(c, error); }
  });

  app.post(`${base}/:taskId/comments`, limited, async (c) => {
    try {
      const slug = param(SlugSchema, c.req.param("slug"));
      const taskId = param(TaskIdSchema, c.req.param("taskId"));
      const who = caller(c);
      const { body } = await readBody(c, CreateCommentBodySchema);
      return c.json({ comment: await write(who, slug, () => service().addComment(who, slug, taskId, body)) }, 201);
    } catch (error: unknown) { return respond(c, error); }
  });

  app.patch(`${base}/:taskId/comments/:commentId`, limited, async (c) => {
    try {
      const slug = param(SlugSchema, c.req.param("slug"));
      const taskId = param(TaskIdSchema, c.req.param("taskId"));
      const commentId = param(TaskCommentIdSchema, c.req.param("commentId"));
      const who = caller(c);
      const { body } = await readBody(c, UpdateCommentBodySchema);
      return c.json({ comment: await write(who, slug, () => service().editComment(who, slug, taskId, commentId, body)) });
    } catch (error: unknown) { return respond(c, error); }
  });

  app.delete(`${base}/:taskId/comments/:commentId`, limited, async (c) => {
    try {
      const slug = param(SlugSchema, c.req.param("slug"));
      const taskId = param(TaskIdSchema, c.req.param("taskId"));
      const commentId = param(TaskCommentIdSchema, c.req.param("commentId"));
      const who = caller(c);
      await write(who, slug, () => service().deleteComment(who, slug, taskId, commentId));
      return c.json({ ok: true });
    } catch (error: unknown) { return respond(c, error); }
  });

  app.post(`${base}/:taskId/start`, limited, async (c) => {
    try {
      const slug = param(SlugSchema, c.req.param("slug"));
      const taskId = param(TaskIdSchema, c.req.param("taskId"));
      const who = caller(c);
      const body = await readBody(c, StartTaskBodySchema);
      const principal = body.selection ? options.getPrincipal?.(c) : undefined;
      return c.json(await write(who, slug, () => work().start(who, slug, taskId, body, principal)), 201);
    } catch (error: unknown) { return respond(c, error); }
  });

  app.post(`${base}/:taskId/sessions`, limited, async (c) => {
    try {
      const slug = param(SlugSchema, c.req.param("slug"));
      const taskId = param(TaskIdSchema, c.req.param("taskId"));
      const who = caller(c);
      const { ref } = await readBody(c, AttachSessionBodySchema);
      return c.json({ task: await write(who, slug, () => work().attach(who, slug, taskId, ref)) });
    } catch (error: unknown) { return respond(c, error); }
  });

  app.delete(`${base}/:taskId/sessions/:ref`, limited, async (c) => {
    try {
      const slug = param(SlugSchema, c.req.param("slug"));
      const taskId = param(TaskIdSchema, c.req.param("taskId"));
      const ref = param(TaskSessionRefSchema, c.req.param("ref"));
      const who = caller(c);
      return c.json({ task: await write(who, slug, () => work().detach(who, slug, taskId, ref)) });
    } catch (error: unknown) { return respond(c, error); }
  });

  app.get(`${base}/:taskId/git`, async (c) => {
    try {
      const slug = param(SlugSchema, c.req.param("slug"));
      const taskId = param(TaskIdSchema, c.req.param("taskId"));
      const who = caller(c);
      // The read is open to the caller; storing the refreshed summary goes behind the write fence.
      const { git } = await work().git(who, slug, taskId, (run) => write(who, slug, run));
      return c.json({ git });
    } catch (error: unknown) { return respond(c, error); }
  });

  app.post(`${base}/:taskId/pull-request`, limited, async (c) => {
    try {
      const slug = param(SlugSchema, c.req.param("slug"));
      const taskId = param(TaskIdSchema, c.req.param("taskId"));
      const who = caller(c);
      const { draft } = await readBody(c, CreatePullRequestBodySchema);
      return c.json(await write(who, slug, () => work().openPullRequest(who, slug, taskId, draft === true)));
    } catch (error: unknown) { return respond(c, error); }
  });

  app.get("/api/projects/:slug/board/attachable-sessions", async (c) => {
    try {
      const slug = param(SlugSchema, c.req.param("slug"));
      return c.json({ sessions: await work().attachable(caller(c), slug) });
    } catch (error: unknown) { return respond(c, error); }
  });

  app.get("/api/projects/:slug/board/members", async (c) => {
    try {
      const slug = param(SlugSchema, c.req.param("slug"));
      return c.json({ members: await service().listMembers(caller(c), slug) });
    } catch (error: unknown) { return respond(c, error); }
  });

  app.get("/api/projects/:slug/board/settings", async (c) => {
    try {
      const slug = param(SlugSchema, c.req.param("slug"));
      return c.json({ settings: await service().getSettings(caller(c), slug) });
    } catch (error: unknown) { return respond(c, error); }
  });

  app.put("/api/projects/:slug/board/settings", limited, async (c) => {
    try {
      const slug = param(SlugSchema, c.req.param("slug"));
      const who = caller(c);
      const body = await readBody(c, UpdateBoardSettingsBodySchema);
      return c.json({ settings: await write(who, slug, () => service().updateSettings(who, slug, body)) });
    } catch (error: unknown) { return respond(c, error); }
  });

  return app;
}
