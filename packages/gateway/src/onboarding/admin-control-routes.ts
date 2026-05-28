import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod/v4";
import { mapActivationError } from "./activation-errors.js";
import type { AdminControlService } from "./admin-control-service.js";
import {
  requireRequestPrincipal,
  type RequestPrincipal,
} from "../request-principal.js";

const ADMIN_CONTROL_BODY_LIMIT = 4096;

const SetupSessionRequestSchema = z.union([z.object({
  target: z.string().trim().min(3).max(120).regex(/^[a-z]+:[a-z0-9_.:-]+$/),
  intent: z.enum(["connect", "configure", "resume"]),
}).strict(), z.object({
  section: z.enum(["models", "agents", "integrations", "settings", "automations", "activity", "readiness"]),
  resume: z.boolean().default(true),
}).strict()]);

function normalizeSetupSessionRequest(body: z.infer<typeof SetupSessionRequestSchema>) {
  if ("target" in body) return body;
  const targetBySection: Record<typeof body.section, string> = {
    models: "agent:claude",
    agents: "agent:claude",
    integrations: "integration:default",
    settings: "setting:general",
    automations: "setting:automations",
    activity: "setting:activity",
    readiness: "setting:readiness",
  };
  return {
    target: targetBySection[body.section],
    intent: body.resume ? "resume" as const : "configure" as const,
  };
}

export interface AdminControlRouteDeps {
  service: AdminControlService;
  getPrincipal?: (c: Context) => RequestPrincipal;
}

function jsonError(c: Context, err: unknown) {
  const mapped = mapActivationError(err);
  return c.json(mapped.body, mapped.status as ContentfulStatusCode);
}

export function createAdminControlRoutes(deps: AdminControlRouteDeps): Hono {
  const app = new Hono();
  const limited = bodyLimit({ maxSize: ADMIN_CONTROL_BODY_LIMIT });
  const principalFor = (c: Context) => deps.getPrincipal?.(c) ?? requireRequestPrincipal(c);

  app.get("/control-surface", async (c) => {
    try {
      const principal = principalFor(c);
      return c.json(await deps.service.getSurface(principal.userId));
    } catch (err) {
      return jsonError(c, err);
    }
  });

  app.post("/control-surface/setup-session", limited, async (c) => {
    try {
      const principal = principalFor(c);
      const body = normalizeSetupSessionRequest(SetupSessionRequestSchema.parse(await c.req.json()));
      const result = await deps.service.createOrResumeSetupSession(principal.userId, body);
      return c.json({
        ...result,
        sessionId: result.session.id,
        status: result.session.status,
        currentStepId: result.session.target,
      });
    } catch (err) {
      return jsonError(c, err);
    }
  });

  return app;
}
