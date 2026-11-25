/** Register the owner message board routes (spec 2700), or a 503 when the owner database is missing. */
import type { Context, Hono } from "hono";
import { boardErrorBody } from "../message-board/errors.js";
import { createMessageBoardRoutes } from "../message-board/routes.js";
import type { BoardCaller, MessageBoardService } from "../message-board/service.js";
import { requireRequestPrincipal } from "../request-principal.js";

export const MESSAGE_BOARD_API_PREFIX = "/api/board";

export interface MessageBoardGatewayRouteOptions {
  app: Hono;
  service: MessageBoardService | null;
  /** Display name for the owner's own posts. */
  ownerName?: string;
}

/** The owner principal acts as `user:<id>`; agent sessions are resolved in a later layer. */
export function ownerBoardCaller(c: Context, ownerName: string): BoardCaller {
  const principal = requireRequestPrincipal(c);
  return { ownerId: principal.userId, actor: { id: `user:${principal.userId}`, kind: "user", name: ownerName } };
}

export function registerMessageBoardGatewayRoutes(options: MessageBoardGatewayRouteOptions): void {
  const { app, service } = options;
  if (!service) {
    // Missing owner database is misconfiguration, not missing data.
    app.all(`${MESSAGE_BOARD_API_PREFIX}/*`, (c) => c.json(boardErrorBody("unavailable"), 503));
    return;
  }
  const ownerName = options.ownerName?.trim().slice(0, 64) || "Owner";
  app.route(MESSAGE_BOARD_API_PREFIX, createMessageBoardRoutes({
    service,
    resolveCaller: (c) => ownerBoardCaller(c, ownerName),
  }));
}
