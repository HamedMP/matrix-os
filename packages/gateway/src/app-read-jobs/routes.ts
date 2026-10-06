import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { AppReadJobRequestSchema, AppReadJobPauseRequestSchema, AppReadJobConfigureRequestSchema, type AppReadJobSettings, AppReadJobRunResponseSchema, AppReadJobStatusResponseSchema } from "@matrix-os/contracts";
import { requireRequestPrincipal, isRequestPrincipalError, mapRequestPrincipalError } from "../request-principal.js";
import { AppReadJobError } from "./runner.js";
import type { ReadJobStatus } from "./types.js";

export interface AppReadJobRouteRunner {
  status(ownerId: string, app: string, jobId: string): Promise<ReadJobStatus | null>;
  run(ownerId: string, app: string, jobId: string): Promise<{ status: "accepted" | "busy" | "disabled" }>;
  configure?(ownerId: string, app: string, jobId: string, settings: AppReadJobSettings): Promise<ReadJobStatus | null>;
  pause(ownerId: string, app: string, jobId: string, paused: boolean): Promise<ReadJobStatus | null>;
}

/** Mounted behind gateway auth. Runner revalidates app/job/config/current source grants. */
export function createAppReadJobRoutes(options: {
  ownerIds: readonly string[];
  runner: AppReadJobRouteRunner | null;
  getPrincipal?: (context: Context) => { userId: string };
}) {
  const routes = new Hono();
  for (const action of ["status", "run", "pause", "configure"] as const) {
    routes.post(`/${action}`, bodyLimit({ maxSize: 4096 }), async (c) => {
      let body: unknown;
      try { body = await c.req.json(); } catch (error) {
        if (error instanceof Error && error.name === "BodyLimitError") return c.json({ error: "Request too large" }, 413);
        if (!(error instanceof SyntaxError)) console.warn("[app-read-jobs] invalid body:", error instanceof Error ? error.name : "UnknownError");
        return c.json({ error: "Invalid app read job request" }, 400);
      }
      const parsed = (action === "configure" ? AppReadJobConfigureRequestSchema : action === "pause" ? AppReadJobPauseRequestSchema : AppReadJobRequestSchema).safeParse(body);
      if (!parsed.success) return c.json({ error: "Invalid app read job request" }, 400);
      try {
        const ownerId = (options.getPrincipal ?? requireRequestPrincipal)(c).userId;
        if (!options.ownerIds.includes(ownerId)) return c.json({ error: "App read job access denied" }, 403);
        if (!options.runner) return c.json({ error: "App read job is unavailable" }, 503);
        const { app, jobId } = parsed.data;
        if (action === "run") return c.json(AppReadJobRunResponseSchema.parse(await options.runner.run(ownerId, app, jobId)));
        if (action === "configure") {
          if (!options.runner.configure) return c.json({ error: "App read job is unavailable" }, 503);
          const state = await options.runner.configure(ownerId, app, jobId, AppReadJobConfigureRequestSchema.parse(parsed.data).settings);
          return c.json(AppReadJobStatusResponseSchema.parse({ jobId, state }));
        }
        const state = action === "pause"
          ? await options.runner.pause(ownerId, app, jobId, AppReadJobPauseRequestSchema.parse(parsed.data).paused)
          : await options.runner.status(ownerId, app, jobId);
        return c.json(AppReadJobStatusResponseSchema.parse({ jobId, state }));
      } catch (error) {
        if (isRequestPrincipalError(error)) {
          const mapped = mapRequestPrincipalError(error); return c.json(mapped.body, mapped.status);
        }
        // Runner only supplies typed, coarse error codes. Never serialize source data/errors here.
        const code = error instanceof AppReadJobError ? error.code : undefined;
        if (code === "denied") return c.json({ error: "App read job access denied" }, 403);
        if (code === "invalid") return c.json({ error: "Invalid app read job request" }, 400);
        if (code === "busy") return c.json({ error: "App read job is busy" }, 429);
        console.warn("[app-read-jobs] request failed:", error instanceof Error ? error.name : "UnknownError");
        return c.json({ error: "App read job is unavailable" }, 503);
      }
    });
  }
  return routes;
}
