import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod/v4";
import { mapActivationError } from "./activation-errors.js";
import type { CompanyBrainReadinessService } from "./company-brain-readiness.js";
import {
  requireRequestPrincipal,
  type RequestPrincipal,
} from "../request-principal.js";

const COMPANY_BRAIN_BODY_LIMIT = 8192;

const CompanyContextRequestSchema = z.object({
  type: z.enum(["product_decision", "customer_note", "support_thread", "growth_idea", "social_draft", "task", "project_record"]),
  title: z.string().trim().min(1).max(120),
  summary: z.string().trim().min(1).max(800),
  source: z.string().trim().min(1).max(220),
  visibility: z.enum(["owner_only", "authorized_teammates"]),
}).strict();

export interface CompanyBrainRouteDeps {
  service: CompanyBrainReadinessService;
  getPrincipal?: (c: Context) => RequestPrincipal;
}

function jsonError(c: Context, err: unknown) {
  const mapped = mapActivationError(err);
  return c.json(mapped.body, mapped.status as ContentfulStatusCode);
}

export function createCompanyBrainRoutes(deps: CompanyBrainRouteDeps): Hono {
  const app = new Hono();
  const limited = bodyLimit({ maxSize: COMPANY_BRAIN_BODY_LIMIT });
  const principalFor = (c: Context) => deps.getPrincipal?.(c) ?? requireRequestPrincipal(c);

  app.get("/readiness", async (c) => {
    try {
      const principal = principalFor(c);
      return c.json(await deps.service.getReadiness(principal.userId));
    } catch (err) {
      return jsonError(c, err);
    }
  });

  app.post("/context", limited, async (c) => {
    try {
      const principal = principalFor(c);
      const body = CompanyContextRequestSchema.parse(await c.req.json());
      return c.json(await deps.service.addContext(principal.userId, body));
    } catch (err) {
      return jsonError(c, err);
    }
  });

  return app;
}
