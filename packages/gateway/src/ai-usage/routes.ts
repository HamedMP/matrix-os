import { Hono, type Context } from "hono";
import { scanUsageRoots, usageRoots } from "@matrix-os/contracts/ai-usage/node";
/** Only the configured computer owner may inspect its local coding history. */
export function createAiUsageRoutes(options: {
  homePath: string;
  runtimeOwnerId?: string;
  getOwnerId(c: Context): string | null;
  scan?: typeof scanUsageRoots;
}) {
  const routes = new Hono();
  let pending: ReturnType<typeof scanUsageRoots> | null = null;
  const scan = options.scan ?? scanUsageRoots;
  routes.get("/api/ai-usage", async (c) => {
    c.header("Cache-Control", "no-store");
    try {
      const owner = options.getOwnerId(c);
      if (!owner) return c.json({ error: "Sign in to view usage" }, 401);
      if (!options.runtimeOwnerId || !options.homePath)
        return c.json({ error: "Usage unavailable" }, 503);
      if (owner !== options.runtimeOwnerId)
        return c.json({ error: "Usage unavailable" }, 403);
      if (Object.keys(c.req.query()).length)
        return c.json({ error: "Invalid usage request" }, 400);
      // One bounded scan per computer; simultaneous authenticated requests coalesce.
      const task =
        pending ??
        scan(usageRoots(options.homePath), AbortSignal.timeout(60_000));
      pending = task;
      try {
        return c.json(await task);
      } finally {
        if (pending === task) pending = null;
      }
    } catch (error: unknown) {
      console.warn(
        "[ai-usage] scan unavailable",
        error instanceof Error ? error.name : "UnknownError",
      );
      return c.json({ error: "Usage unavailable" }, 503);
    }
  });
  return routes;
}
