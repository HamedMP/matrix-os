import { Hono, type Context } from "hono";
import { z } from "zod/v4";
import { scanUsageRoots, usageRoots } from "@matrix-os/contracts/ai-usage/node";
/** Browsers report legacy aliases (Asia/Calcutta) that canonical zone lists omit; ask the runtime itself. */
function knownTimeZone(zone: string) {
  if (!/^[A-Za-z0-9_+/-]+$/.test(zone)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch (error: unknown) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}
/** The only request input: the viewer's reporting timezone. Owner and folders are never selectable. */
const querySchema = z.strictObject({
  timeZone: z.string().min(1).max(80).refine(knownTimeZone).optional(),
});
/** Only the configured computer owner may inspect its local coding history. */
export function createAiUsageRoutes(options: {
  homePath: string;
  runtimeOwnerId?: string;
  getOwnerId(c: Context): string | null;
  scan?: typeof scanUsageRoots;
  history?: { read(timeZone?: string): Promise<unknown> };
  /** False while collection is not rolled out here; clients then use the owner export, as on older computers. */
  enabled?: boolean;
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
      if (options.enabled === false)
        return c.json({ error: "Usage history is not enabled" }, 404);
      const raw = Object.entries(c.req.queries());
      const query = querySchema.safeParse(
        Object.fromEntries(raw.map(([key, values]) => [key, values[0]])),
      );
      if (!query.success || raw.some(([, values]) => values.length !== 1))
        return c.json({ error: "Invalid usage request" }, 400);
      if (options.history)
        return c.json(await options.history.read(query.data.timeZone));
      if(!options.scan) return c.json({error:"Usage unavailable"},503);
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
