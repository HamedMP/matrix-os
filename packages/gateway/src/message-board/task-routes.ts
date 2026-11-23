import type { Context, Hono, MiddlewareHandler } from "hono";
import {
  AssignTaskRequestSchema, BlockTaskRequestSchema, BoardMessageIdSchema, BoardQuerySchema, CancelTaskRequestSchema,
  ClaimTaskRequestSchema, CompleteTaskRequestSchema, CreateTaskPlanRequestSchema, CreateTaskRequestSchema, FailTaskRequestSchema,
  ReleaseTaskRequestSchema, RenewTaskRequestSchema, ReopenTaskRequestSchema, SetTaskNeedsRequestSchema, TasksQuerySchema,
  UnblockTaskRequestSchema,
} from "@matrix-os/contracts/message-board";
import { bodyLimit } from "hono/body-limit";
import { boardErrorBody } from "./errors.js";
import type { BoardCaller } from "./service.js";

/** 15 tasks × 10,000 characters, JSON-escaped, plus labels and keys. */
export const TASK_PLAN_BODY_LIMIT = 15 * 10_000 * 2 + 64 * 1024;
import type { BoardTaskService } from "./tasks.js";

type Handle = (fn: (c: Context, caller: BoardCaller) => Promise<Response>) => (c: Context) => Promise<Response>;

/** `/tasks…` routes, mounted inside the board routes so they share auth, body limits and error mapping. */
export function mountTaskRoutes(app: Hono, deps: {
  tasks: BoardTaskService;
  handle: Handle;
  limit: MiddlewareHandler;
  readBody(c: Context): Promise<unknown>;
  withProfile(caller: BoardCaller, profile: string | undefined): BoardCaller;
}): void {
  const { tasks, handle, limit, readBody, withProfile } = deps;
  // A plan carries up to 15 tasks of up to 10,000 characters each.
  const planLimit = bodyLimit({ maxSize: TASK_PLAN_BODY_LIMIT, onError: (c) => c.json(boardErrorBody("invalid_input"), 413) });
  const board = (c: Context) => BoardQuerySchema.parse({ board: c.req.query("board") }).board;
  const taskId = (c: Context) => BoardMessageIdSchema.parse(c.req.param("id"));

  app.get("/tasks", handle(async (c, caller) => {
    const { board: name, state, ...query } = TasksQuerySchema.parse(Object.fromEntries(new URL(c.req.url).searchParams.entries()));
    const threads = await tasks.board.listThreads(caller, name, { ...query, ...(state ? { taskState: state } : { tasksOnly: true }) });
    return c.json({ tasks: threads });
  }));

  app.post("/tasks", planLimit, handle(async (c, caller) => {
    const raw = await readBody(c);
    if (typeof raw === "object" && raw !== null && "tasks" in raw) {
      const plan = CreateTaskPlanRequestSchema.parse(raw);
      return c.json({ tasks: await tasks.createPlan(withProfile(caller, plan.profile), board(c), plan) }, 201);
    }
    const body = CreateTaskRequestSchema.parse(raw);
    if ("rootId" in body) return c.json(await tasks.createFromThread(caller, board(c), body.rootId, body), 201);
    return c.json(await tasks.create(withProfile(caller, body.profile), board(c), body), 201);
  }));

  app.post("/tasks/claim", limit, handle(async (c, caller) => {
    const body = ClaimTaskRequestSchema.parse(await readBody(c));
    return c.json({ claim: await tasks.claim(withProfile(caller, body.profile), board(c), body) });
  }));

  const settle = <S extends { parse(value: unknown): unknown }>(verb: string, schema: S, run: (caller: BoardCaller, name: string | undefined, id: string, body: ReturnType<S["parse"]>) => Promise<unknown>) => {
    app.post(`/tasks/:id/${verb}`, limit, handle(async (c, caller) => {
      const body = schema.parse(await readBody(c)) as ReturnType<S["parse"]>;
      const result = await run(caller, board(c), taskId(c), body);
      return c.json(result && typeof result === "object" ? { task: result } : { ok: true });
    }));
  };
  settle("renew", RenewTaskRequestSchema, (caller, name, id, body) => tasks.renew(caller, name, id, body));
  settle("release", ReleaseTaskRequestSchema, (caller, name, id, body) => tasks.release(caller, name, id, body));
  settle("complete", CompleteTaskRequestSchema, (caller, name, id, body) => tasks.complete(caller, name, id, body));
  settle("fail", FailTaskRequestSchema, (caller, name, id, body) => tasks.fail(caller, name, id, body));
  settle("block", BlockTaskRequestSchema, (caller, name, id, body) => tasks.block(caller, name, id, body));
  settle("unblock", UnblockTaskRequestSchema, (caller, name, id) => tasks.unblock(caller, name, id));
  settle("reopen", ReopenTaskRequestSchema, (caller, name, id) => tasks.reopen(caller, name, id));
  settle("assign", AssignTaskRequestSchema, (caller, name, id, body) => tasks.assign(caller, name, id, body));
  settle("needs", SetTaskNeedsRequestSchema, (caller, name, id, body) => tasks.setNeeds(caller, name, id, body));
  settle("cancel", CancelTaskRequestSchema, (caller, name, id, body) => tasks.cancel(caller, name, id, body));
}
