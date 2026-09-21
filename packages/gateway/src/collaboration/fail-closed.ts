/**
 * Fail-closed collaboration registrar (S20 / T098, T099).
 *
 * Collaboration wiring always constructs. When the home computer cannot build
 * the real runtime (incomplete signing/platform configuration or no owner
 * Postgres) every collaboration HTTP route and WebSocket upgrade is still
 * mounted and answers with one generic denial. Nothing is skipped and no
 * release flag is consulted; only a fully configured home with fresh
 * organization membership evidence can say yes.
 */
import { COLLABORATION_HTTP_BODY_LIMIT } from "@matrix-os/contracts";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { UpgradeWebSocket } from "hono/ws";
import type { GatewayCollaborationConfigurationFailure } from "./config.js";

const DENIAL_LOG_INTERVAL_MS = 60_000;
const DENIAL_BODY = { error: "Collaboration unavailable" } as const;

export function registerFailClosedCollaborationRoutes(input: {
  app: Hono;
  upgradeWebSocket: UpgradeWebSocket;
  reason: GatewayCollaborationConfigurationFailure;
  now?: () => number;
}): { reason: GatewayCollaborationConfigurationFailure } {
  const now = input.now ?? (() => Date.now());
  let lastLoggedAt = Number.NEGATIVE_INFINITY;
  const logDenial = (): void => {
    const current = now();
    if (current - lastLoggedAt < DENIAL_LOG_INTERVAL_MS) return;
    lastLoggedAt = current;
    console.warn("[collaboration] request denied while fail-closed", input.reason);
  };
  console.warn("[collaboration] wiring fail-closed", input.reason);

  // Mutating verbs (DELETE included) never buffer more than the collaboration body limit,
  // even while every request is denied.
  input.app.on(
    ["POST", "PUT", "PATCH", "DELETE"],
    "/api/collaboration/*",
    bodyLimit({
      maxSize: COLLABORATION_HTTP_BODY_LIMIT,
      onError: (c) => {
        c.header("Cache-Control", "no-store");
        return c.json({ error: "Request too large" }, 413);
      },
    }),
  );
  input.app.all("/api/collaboration/*", async (c) => {
    await drainBody(c);
    logDenial();
    c.header("Cache-Control", "no-store");
    return c.json(DENIAL_BODY, 503);
  });
  input.app.get("/ws/collaboration/*", (c) => {
    logDenial();
    c.header("Cache-Control", "no-store");
    return c.json(DENIAL_BODY, 503);
  });
  return { reason: input.reason };
}

/**
 * Reads and discards the request body so the surrounding bodyLimit middleware
 * can enforce its cap even when no content-length header was sent; the limit
 * error is handed back to that middleware through the context.
 */
async function drainBody(c: Context): Promise<void> {
  if (!c.req.raw.body) return;
  try {
    await c.req.raw.arrayBuffer();
  } catch (error: unknown) {
    if (error instanceof Error) c.error = error;
  }
}
