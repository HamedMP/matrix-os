/**
 * Fail-closed platform collaboration composition (S20 / T098, T099).
 *
 * The platform has no collaboration release flag. When the signing key or
 * allowed-origin configuration is incomplete the composition root still
 * registers every collaboration and internal collaboration route, and each
 * one answers with a generic denial. The WebSocket authorizer is absent, so
 * the upgrade handler destroys collaboration sockets. Nothing is skipped.
 */
import { COLLABORATION_HTTP_BODY_LIMIT } from "@matrix-os/contracts";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

const DENIAL_LOG_INTERVAL_MS = 60_000;

export type PlatformCollaborationConfigurationFailure =
  | "signing_configuration_missing"
  | "origin_configuration_missing"
  | "runtime_authentication_missing";

export interface FailClosedPlatformCollaboration {
  readonly failClosed: { reason: PlatformCollaborationConfigurationFailure };
  readonly sockets?: undefined;
  /** S05: no direct transport either; the upgrade handler destroys control sockets. */
  readonly direct?: undefined;
  register(app: Hono<any>): void;
  shutdown(): Promise<void>;
}

export function createFailClosedPlatformCollaboration(input: {
  reason: PlatformCollaborationConfigurationFailure;
  now?: () => number;
}): FailClosedPlatformCollaboration {
  const now = input.now ?? (() => Date.now());
  let lastLoggedAt = Number.NEGATIVE_INFINITY;
  let registered = false;
  const logDenial = (): void => {
    const current = now();
    if (current - lastLoggedAt < DENIAL_LOG_INTERVAL_MS) return;
    lastLoggedAt = current;
    console.warn("[platform-collaboration] request denied while fail-closed", input.reason);
  };
  console.warn("[platform-collaboration] wiring fail-closed", input.reason);
  return {
    failClosed: { reason: input.reason },
    register(app) {
      if (registered) throw new Error("Platform collaboration routes are already registered");
      registered = true;
      for (const prefix of ["/api/collaboration/*", "/internal/collaboration/*"]) {
        app.on(
          ["POST", "PUT", "PATCH", "DELETE"],
          prefix,
          bodyLimit({
            maxSize: COLLABORATION_HTTP_BODY_LIMIT,
            onError: (c) => {
              c.header("Cache-Control", "no-store");
              return c.json({ error: "Request too large" }, 413);
            },
          }),
        );
        app.all(prefix, async (c) => {
          await drainBody(c);
          logDenial();
          c.header("Cache-Control", "no-store");
          return c.json({ error: "Collaboration unavailable" }, 503);
        });
      }
    },
    async shutdown() {},
  };
}

/** Drains the body so bodyLimit enforces its cap without a content-length header. */
async function drainBody(c: Context): Promise<void> {
  if (!c.req.raw.body) return;
  try {
    await c.req.raw.arrayBuffer();
  } catch (error: unknown) {
    if (error instanceof Error) c.error = error;
  }
}
