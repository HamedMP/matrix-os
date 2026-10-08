/**
 * /api/brain/projects/:projectId/jobs: queue a background run (202), read one, list recent ones, cancel one. The
 * shared route guard runs first (principal, brain on, project ref shape); job ids are checked against
 * BRAIN_JOB_ID_PATTERN (a malformed one is job_not_found); queries go through exactQuery and bodies through strict
 * zod under bodyLimit. No app.use. Clients only ever see { error: { code, message } } with a fixed message.
 */
import { Hono, type Context } from "hono";
import { z } from "zod/v4";
import { exactQuery } from "../../collaboration/route-support.js";
import { brainBodyLimit, brainProjectRoute, readBrainBody, type BrainProjectHandler } from "../api/feature-route-kit.js";
import type { BrainFeatureRoutesDeps } from "../contracts.js";
import {
  BRAIN_JOB_ERRORS, BRAIN_JOB_ID_PATTERN, BRAIN_JOB_LIMITS, BrainJobError, BrainJobRequestSchema,
  type BrainJobErrorCode, type BrainJobsService,
} from "./types.js";

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(BRAIN_JOB_LIMITS.listMax).default(BRAIN_JOB_LIMITS.listDefault),
}).strict();
const CancelBodySchema = z.object({}).strict();

function jobFail(c: Context, code: BrainJobErrorCode): Response {
  const entry = BRAIN_JOB_ERRORS[code];
  c.header("Cache-Control", "private, no-store");
  return c.json({ error: { code, message: entry.message } }, entry.status);
}

/** The job id path param, or job_not_found. */
function jobIdParam(c: Context): string {
  const jobId = String(c.req.param("jobId"));
  if (!BRAIN_JOB_ID_PATTERN.test(jobId)) throw new BrainJobError("job_not_found");
  return jobId;
}

export function createBrainJobsRoutes(deps: BrainFeatureRoutesDeps<BrainJobsService>): Hono {
  const app = new Hono();
  const guarded = brainProjectRoute(deps, "brain-jobs");
  const route = (handler: BrainProjectHandler<BrainJobsService>) => guarded(async (c, ownerId, service, ref) => {
    try {
      return await handler(c, ownerId, service, ref);
    } catch (error: unknown) {
      if (error instanceof BrainJobError) return jobFail(c, error.code);
      throw error;
    }
  });
  const limit = brainBodyLimit(BRAIN_JOB_LIMITS.bodyMaxBytes);

  app.post("/projects/:projectId/jobs", limit, route(async (c, ownerId, service, projectRef) => {
    exactQuery(c, []);
    const request = await readBrainBody(c, BrainJobRequestSchema);
    return c.json(await service.enqueue(ownerId, projectRef, request), 202);
  }));

  app.get("/projects/:projectId/jobs", route(async (c, ownerId, service, projectRef) => {
    const query = ListQuerySchema.parse(exactQuery(c, ["limit"]));
    return c.json(await service.list(ownerId, projectRef, query.limit), 200);
  }));

  app.get("/projects/:projectId/jobs/:jobId", route(async (c, ownerId, service, projectRef) => {
    exactQuery(c, []);
    return c.json(await service.get(ownerId, projectRef, jobIdParam(c)), 200);
  }));

  app.post("/projects/:projectId/jobs/:jobId/cancel", limit, route(async (c, ownerId, service, projectRef) => {
    exactQuery(c, []);
    const jobId = jobIdParam(c);
    await readBrainBody(c, CancelBodySchema);
    return c.json(await service.cancel(ownerId, projectRef, jobId), 200);
  }));

  return app;
}
