/** `GET /api/system/lifecycle`: busy state and next scheduled time for the platform idle sleeper. */
import type { Hono } from "hono";
import { RuntimeLifecycleStatusSchema, type RuntimeLifecycleStatus } from "@matrix-os/contracts/runtime-lifecycle";

export interface LifecycleRouteOptions {
  /** Mounted behind the gateway-wide authMiddleware; this route adds no auth of its own. */
  app: Hono;
  readStatus(): Promise<RuntimeLifecycleStatus>;
}

export function registerLifecycleRoutes(options: LifecycleRouteOptions): void {
  const { app, readStatus } = options;
  // GET-only with no body and no query parameters, so there is nothing to bound or validate on input.
  app.get("/api/system/lifecycle", async (c) => {
    c.header("Cache-Control", "no-store");
    try {
      return c.json(RuntimeLifecycleStatusSchema.parse(await readStatus()));
    } catch (error: unknown) {
      console.error("[lifecycle] status unavailable:", error instanceof Error ? error.name : "UnknownError");
      return c.json({ error: "lifecycle_unavailable" }, 503);
    }
  });
}
