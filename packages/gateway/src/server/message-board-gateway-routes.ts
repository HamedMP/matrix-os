/** Register the owner message board routes and event socket (spec 2700), or a 503 when the owner database is missing. */
import type { Context, Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import { boardErrorBody } from "../message-board/errors.js";
import { BOARD_EVENTS_WS_PATH, registerBoardEventsWebSocket } from "../message-board/events-ws.js";
import { createMessageBoardRoutes } from "../message-board/routes.js";
import type { MessageBoardRuntime } from "../message-board/runtime.js";
import type { BoardCaller } from "../message-board/service.js";
import { requireRequestPrincipal } from "../request-principal.js";

export const MESSAGE_BOARD_API_PREFIX = "/api/board";

export interface MessageBoardGatewayRouteOptions {
  app: Hono;
  upgradeWebSocket?: UpgradeWebSocket;
  runtime: MessageBoardRuntime | null;
  /** Display name for the owner's own posts. */
  ownerName?: string;
}

/** The owner principal acts as `user:<id>`; agent sessions are resolved in a later layer. */
export function ownerBoardCaller(c: Context, ownerName: string): BoardCaller {
  const principal = requireRequestPrincipal(c);
  return { ownerId: principal.userId, actor: { id: `user:${principal.userId}`, kind: "user", name: ownerName } };
}

export function registerMessageBoardGatewayRoutes(options: MessageBoardGatewayRouteOptions): void {
  const { app, runtime } = options;
  if (!runtime) {
    // Missing owner database is misconfiguration, not missing data.
    app.all(`${MESSAGE_BOARD_API_PREFIX}/*`, (c) => c.json(boardErrorBody("unavailable"), 503));
    app.get(BOARD_EVENTS_WS_PATH, (c) => c.json(boardErrorBody("unavailable"), 503));
    return;
  }
  const ownerName = options.ownerName?.trim().slice(0, 64) || "Owner";
  const resolveCaller = (c: Context) => ownerBoardCaller(c, ownerName);
  app.route(MESSAGE_BOARD_API_PREFIX, createMessageBoardRoutes({ service: runtime.service, tasks: runtime.tasks, hub: runtime.hub, resolveCaller }));
  if (options.upgradeWebSocket) {
    registerBoardEventsWebSocket({ app, upgradeWebSocket: options.upgradeWebSocket, hub: runtime.hub, service: runtime.service, resolveCaller });
  }
}
