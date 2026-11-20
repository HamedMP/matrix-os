import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import {
  BoardMessageIdSchema, BoardQuerySchema, CreateBoardRequestSchema, CreateChannelRequestSchema, DeleteMessageRequestSchema,
  EditMessageRequestSchema, LabelPatchRequestSchema, MessagesQuerySchema, PostMessageRequestSchema, ReactionRequestSchema,
  ThreadsQuerySchema, type BoardActor,
} from "@matrix-os/contracts/message-board";
import { isRequestPrincipalError, mapRequestPrincipalError } from "../request-principal.js";
import { boardErrorBody, boardErrorStatus, MessageBoardServiceError } from "./errors.js";
import type { BoardCaller, MessageBoardService } from "./service.js";
import { EventsQuerySchema } from "@matrix-os/contracts/message-board";
import { pollBoardEvents, type BoardEventHub } from "./events.js";
import { mountTaskRoutes } from "./task-routes.js";
import { permissionForRoute, requireBoardPermission } from "./caller.js";
import type { BoardTaskService } from "./tasks.js";

/** Text is capped at 10,000 characters; 64 KiB leaves room for labels and JSON escaping. */
export const MESSAGE_BOARD_BODY_LIMIT = 64 * 1024;

export interface MessageBoardRouteDeps {
  service: MessageBoardService;
  tasks?: BoardTaskService;
  hub?: BoardEventHub;
  /** Resolves who is calling: the owner, or an agent session acting for the owner. */
  resolveCaller(c: Context): BoardCaller | Promise<BoardCaller>;
}

export function boardErrorResponse(c: Context, error: unknown) {
  if (error instanceof MessageBoardServiceError) return c.json(boardErrorBody(error.reason), boardErrorStatus(error.reason));
  if (error instanceof z.ZodError) return c.json(boardErrorBody("invalid_input"), 400);
  if (error instanceof SyntaxError) return c.json(boardErrorBody("invalid_input"), 400);
  if (isRequestPrincipalError(error)) {
    const mapped = mapRequestPrincipalError(error, "Message board request failed");
    if (mapped.log) console.error("[message-board] request principal misconfigured:", error.name);
    return c.json(mapped.body, mapped.status);
  }
  console.error("[message-board] request failed:", error instanceof Error ? error.name : "UnknownError");
  return c.json(boardErrorBody("unavailable"), 503);
}

/** An agent may post under a profile name; a profile never grants anything. */
export function withProfile(caller: BoardCaller, profile: string | undefined): BoardCaller {
  if (!profile || caller.actor.kind !== "agent") return caller;
  const actor: BoardActor = { ...caller.actor, profile };
  return { ...caller, actor };
}

function queryObject(c: Context): Record<string, string> {
  return Object.fromEntries(new URL(c.req.url).searchParams.entries());
}

const limit = bodyLimit({ maxSize: MESSAGE_BOARD_BODY_LIMIT, onError: (c) => c.json(boardErrorBody("invalid_input"), 413) });

async function readBody(c: Context): Promise<unknown> {
  const text = await c.req.text();
  return text.trim().length === 0 ? {} : JSON.parse(text);
}

export function createMessageBoardRoutes(deps: MessageBoardRouteDeps): Hono {
  const app = new Hono();
  const { service } = deps;
  const board = (c: Context) => BoardQuerySchema.parse({ board: c.req.query("board") }).board;
  const messageId = (c: Context) => BoardMessageIdSchema.parse(c.req.param("id"));

  const handle = (fn: (c: Context, caller: BoardCaller) => Promise<Response>) => async (c: Context) => {
    try {
      const caller = await deps.resolveCaller(c);
      requireBoardPermission(caller, permissionForRoute(c.req.method, c.req.path));
      return await fn(c, caller);
    } catch (error: unknown) {
      return boardErrorResponse(c, error);
    }
  };

  app.get("/whoami", handle(async (c, caller) => c.json({ actor: caller.actor })));

  app.get("/boards", handle(async (c, caller) => c.json({ boards: await service.listBoards(caller.ownerId) })));
  app.post("/boards", limit, handle(async (c, caller) => {
    const body = CreateBoardRequestSchema.parse(await readBody(c));
    return c.json({ board: await service.createBoard(caller.ownerId, body.name) }, 201);
  }));

  app.get("/channels", handle(async (c, caller) => c.json({ channels: await service.listChannels(caller, board(c)) })));
  app.post("/channels", limit, handle(async (c, caller) => {
    const body = CreateChannelRequestSchema.parse(await readBody(c));
    await service.createChannel(caller, board(c), body.path);
    return c.json({ channel: { path: body.path } }, 201);
  }));

  app.get("/actors", handle(async (c, caller) => c.json({ actors: await service.listActors(caller, board(c)) })));

  app.get("/threads", handle(async (c, caller) => {
    const { board: name, kind, ...query } = ThreadsQuerySchema.parse(queryObject(c));
    return c.json({ threads: await service.listThreads(caller, name, { ...query, ...(kind === "tasks" ? { tasksOnly: true } : {}) }) });
  }));
  app.get("/threads/:id", handle(async (c, caller) => c.json({ thread: await service.getThread(caller, board(c), messageId(c)) })));
  app.post("/threads/:id/read", limit, handle(async (c, caller) => {
    await service.markRead(caller, board(c), messageId(c));
    return c.json({ ok: true });
  }));

  app.get("/messages", handle(async (c, caller) => {
    const { board: name, ...query } = MessagesQuerySchema.parse(queryObject(c));
    return c.json({ messages: await service.listMessages(caller, name, query) });
  }));
  app.post("/messages", limit, handle(async (c, caller) => {
    const body = PostMessageRequestSchema.parse(await readBody(c));
    const message = await service.post(withProfile(caller, body.profile), board(c), body);
    return c.json({ message }, 201);
  }));
  app.patch("/messages/:id", limit, handle(async (c, caller) => {
    const body = EditMessageRequestSchema.parse(await readBody(c));
    return c.json({ message: await service.edit(caller, board(c), messageId(c), body) });
  }));
  app.delete("/messages/:id", limit, handle(async (c, caller) => {
    const body = DeleteMessageRequestSchema.parse(await readBody(c));
    await service.remove(caller, board(c), messageId(c), body);
    return c.json({ ok: true });
  }));
  app.post("/messages/:id/reactions", limit, handle(async (c, caller) => {
    const body = ReactionRequestSchema.parse(await readBody(c));
    await service.react(caller, board(c), messageId(c), body);
    return c.json({ ok: true });
  }));
  app.patch("/messages/:id/labels", limit, handle(async (c, caller) => {
    const body = LabelPatchRequestSchema.parse(await readBody(c));
    await service.label(caller, board(c), messageId(c), body);
    return c.json({ ok: true });
  }));

  if (deps.tasks) mountTaskRoutes(app, { tasks: deps.tasks, handle, limit, readBody, withProfile });

  app.get("/events", handle(async (c, caller) => {
    const { board: name, wait, after, limit: pageSize, channel, thread } = EventsQuerySchema.parse(queryObject(c));
    return c.json(await pollBoardEvents({ service, hub: deps.hub }, caller.ownerId, { board: name, after, waitSeconds: wait, limit: pageSize, channel, thread }));
  }));

  return app;
}
