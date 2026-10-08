/**
 * Every /api/brain router in one place: the project routes (specs 553, 554) and the feature routes (search, graph,
 * sources, brief, impact, background runs). Each router answers 503 while its service is null (brain off, deferred,
 * or that feature off), except the background runs of a brain that is on: with only them off, POST .../jobs answers
 * job_kind_unavailable (BRAIN_JOBS_OFF), so clients run the work through the direct routes that still work. No router
 * here registers middleware for "*", so nothing leaks between them; each attaches bodyLimit and headers per route.
 */
import { Hono, type Context } from "hono";
import type { RequestPrincipal } from "../../request-principal.js";
import { createBrainBriefRoutes } from "../brief/index.js";
import type { BrainServices } from "../contracts.js";
import { createBrainGraphRoutes } from "../graph/index.js";
import { createBrainImpactRoutes } from "../impact/index.js";
import { BRAIN_JOBS_OFF, createBrainJobsRoutes } from "../jobs/index.js";
import { createBrainSearchRoutes } from "../search/index.js";
import { createBrainSourcesRoutes } from "../sources/core/index.js";
import { createBrainRoutes } from "./routes.js";

export function createBrainApiRoutes(
  services: BrainServices | null,
  getPrincipal: (c: Context) => RequestPrincipal,
): Hono {
  const app = new Hono();
  app.route("/", createBrainRoutes({ service: services?.project ?? null, getPrincipal }));
  app.route("/", createBrainSearchRoutes({ service: services?.search ?? null, getPrincipal }));
  app.route("/", createBrainGraphRoutes({ service: services?.graph ?? null, getPrincipal }));
  app.route("/", createBrainSourcesRoutes({ service: services?.sources ?? null, getPrincipal }));
  app.route("/", createBrainBriefRoutes({ service: services?.brief ?? null, getPrincipal }));
  app.route("/", createBrainImpactRoutes({ service: services?.impact ?? null, getPrincipal }));
  const runs = services === null ? null : services.runs ?? BRAIN_JOBS_OFF;
  app.route("/", createBrainJobsRoutes({ service: runs, getPrincipal }));
  return app;
}
