import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { SitePublicDataCapabilitySchema } from "@matrix-os/contracts";
import { SitePublicDataError, type SitePublicDataRepository } from "./public-data-repository.js";
import { verifySiteSignature } from "./submission-validation.js";

const UNAVAILABLE = "Shared data is unavailable";
const RATE_WINDOW_MS = 60_000;
const MAX_TRACKED_SITES = 1_000;
// Visitor requests share the owner's gateway; keep enough headroom for Chat and the shell.
const MAX_IN_FLIGHT = 8;

/** Bounded per-site admission; the oldest site window is evicted at the cap. */
export function createSitePublicDataLimiter(maxPerMinute: number, maxKeys = MAX_TRACKED_SITES) {
  const windows = new Map<string, { count: number; resetAt: number }>();
  return {
    check(key: string, now = Date.now()): boolean {
      const existing = windows.get(key);
      const window = !existing || existing.resetAt <= now ? { count: 0, resetAt: now + RATE_WINDOW_MS } : existing;
      windows.delete(key);
      windows.set(key, window);
      while (windows.size > maxKeys) windows.delete(windows.keys().next().value!);
      if (window.count >= maxPerMinute) return false;
      window.count += 1;
      return true;
    },
    get size() { return windows.size; },
  };
}

/** Platform-signed visitor data for exactly one published app (2694). */
export function createSitePublicDataRoutes(options: {
  serviceSecret?: string;
  repository: SitePublicDataRepository | null;
  env?: NodeJS.ProcessEnv;
  onChange?(change: { app: string; key: string }): void;
  perSiteLimit?: number;
  maxInFlight?: number;
}): Hono {
  const app = new Hono();
  const limiter = createSitePublicDataLimiter(options.perSiteLimit ?? 3_000);
  const maxInFlight = options.maxInFlight ?? MAX_IN_FLIGHT;
  let flights = 0;
  app.post("/api/internal/sites/:siteId/data", bodyLimit({ maxSize: 96 * 1024, onError: (c) => c.json({ error: "Invalid change" }, 413) }), async (c) => {
    const siteId = z.uuid().safeParse(c.req.param("siteId"));
    if (!siteId.success) return c.json({ error: "Invalid change" }, 400);
    const raw = await c.req.text();
    if (!verifySiteSignature(raw, c.req.header("x-matrix-site-timestamp"), c.req.header("x-matrix-site-signature"), options.serviceSecret)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    // Operator kill switch, read per request so an env change needs no code deploy.
    if ((options.env ?? process.env).MATRIX_SITES_PUBLIC_DATA === "off") return c.json({ error: UNAVAILABLE }, 503);
    let parsed: ReturnType<typeof SitePublicDataCapabilitySchema.safeParse>;
    try { parsed = SitePublicDataCapabilitySchema.safeParse(JSON.parse(raw)); }
    catch (error: unknown) {
      if (error instanceof SyntaxError) return c.json({ error: "Invalid change" }, 400);
      throw error;
    }
    if (!parsed.success || parsed.data.siteId !== siteId.data) return c.json({ error: "Invalid change" }, 400);
    if (!limiter.check(siteId.data)) return c.json({ error: "Try again later" }, 429);
    if (!options.repository) return c.json({ error: UNAVAILABLE }, 503);
    if (flights >= maxInFlight) return c.json({ error: "Try again later" }, 429);
    flights++;
    try {
      const outcome = await options.repository.execute(parsed.data);
      if (outcome.changed) {
        try { options.onChange?.(outcome.changed); }
        catch (error: unknown) { console.warn("[sites] Public data change notification failed", error instanceof Error ? error.name : "UnknownError"); }
      }
      return c.json({ result: outcome.result ?? null });
    } catch (error: unknown) {
      if (error instanceof SitePublicDataError && error.code === "invalid") return c.json({ error: "Invalid change" }, 400);
      if (!(error instanceof SitePublicDataError)) console.warn("[sites] Public data route failed", error instanceof Error ? error.name : "UnknownError");
      return c.json({ error: UNAVAILABLE }, 503);
    } finally {
      flights--;
    }
  });
  return app;
}
