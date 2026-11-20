import type { Context, Hono, MiddlewareHandler } from "hono";
import {
  BOARD_GRANT_PERMISSIONS, BoardGrantIdSchema, BoardQuerySchema, BoardScheduleIdSchema, BoardWatcherIdSchema,
  CreateGrantRequestSchema, CreateScheduleRequestSchema, CreateWatcherRequestSchema, ExplainGrantsQuerySchema,
  PatchGrantRequestSchema, PatchWatcherRequestSchema,
} from "@matrix-os/contracts/message-board";
import type { BoardGrantService } from "./grants.js";
import type { BoardScheduleService } from "./schedules.js";
import type { BoardCaller } from "./service.js";
import type { BoardWatcherService } from "./watchers.js";

type Handle = (fn: (c: Context, caller: BoardCaller) => Promise<Response>) => (c: Context) => Promise<Response>;

/**
 * `/watchers`, `/schedules` and `/grants` (spec 2700 sections 6 to 8). Watchers
 * and grants need `manage` (owner only); agents may schedule their own posts.
 */
export function mountAutomationRoutes(app: Hono, deps: {
  watchers: BoardWatcherService;
  schedules: BoardScheduleService;
  grants: BoardGrantService;
  handle: Handle;
  limit: MiddlewareHandler;
  readBody(c: Context): Promise<unknown>;
}): void {
  const { watchers, schedules, grants, handle, limit, readBody } = deps;
  const board = (c: Context) => BoardQuerySchema.parse({ board: c.req.query("board") }).board;

  app.get("/watchers", handle(async (c, caller) => c.json({ watchers: await watchers.list(caller, board(c)) })));
  app.post("/watchers", limit, handle(async (c, caller) => c.json({ watcher: await watchers.create(caller, board(c), CreateWatcherRequestSchema.parse(await readBody(c))) }, 201)));
  app.patch("/watchers/:id", limit, handle(async (c, caller) => c.json({
    watcher: await watchers.patch(caller, board(c), BoardWatcherIdSchema.parse(c.req.param("id")), PatchWatcherRequestSchema.parse(await readBody(c))),
  })));
  app.delete("/watchers/:id", limit, handle(async (c, caller) => {
    await watchers.remove(caller, board(c), BoardWatcherIdSchema.parse(c.req.param("id")));
    return c.json({ ok: true });
  }));

  app.get("/schedules", handle(async (c, caller) => c.json({ schedules: await schedules.list(caller, board(c)) })));
  app.post("/schedules", limit, handle(async (c, caller) => c.json({ schedule: await schedules.create(caller, board(c), CreateScheduleRequestSchema.parse(await readBody(c))) }, 201)));
  app.delete("/schedules/:id", limit, handle(async (c, caller) => {
    await schedules.cancel(caller, board(c), BoardScheduleIdSchema.parse(c.req.param("id")));
    return c.json({ ok: true });
  }));

  app.get("/grants", handle(async (c, caller) => c.json({ grants: await grants.list(caller, board(c)) })));
  app.get("/grants/explain", handle(async (c, caller) => {
    const query = ExplainGrantsQuerySchema.parse(Object.fromEntries(new URL(c.req.url).searchParams.entries()));
    return c.json({ explanation: await grants.explain(caller, query.board, query.channel, query.principal) });
  }));
  app.post("/grants", limit, handle(async (c, caller) => c.json({ grants: await grants.create(caller, board(c), CreateGrantRequestSchema.parse(await readBody(c))) }, 201)));
  app.patch("/grants/:id", limit, handle(async (c, caller) => c.json({
    grant: await grants.patch(caller, board(c), BoardGrantIdSchema.parse(c.req.param("id")), PatchGrantRequestSchema.parse(await readBody(c)).permissions),
  })));
  app.delete("/grants/:id", limit, handle(async (c, caller) => {
    await grants.remove(caller, board(c), BoardGrantIdSchema.parse(c.req.param("id")));
    return c.json({ ok: true });
  }));
}

export { BOARD_GRANT_PERMISSIONS };
