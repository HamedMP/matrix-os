import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  RetryGateParamsSchema,
  SelectGoalsRequestSchema,
} from "./activation-contracts.js";
import { mapActivationError } from "./activation-errors.js";
import type { ReadinessService } from "./readiness-service.js";
import {
  requireRequestPrincipal,
  type RequestPrincipal,
} from "../request-principal.js";

const READINESS_BODY_LIMIT = 4096;
const READINESS_EMPTY_BODY_LIMIT = 512;

export interface ReadinessRouteDeps {
  service: ReadinessService;
  getPrincipal?: (c: Context) => RequestPrincipal;
}

function jsonError(c: Context, err: unknown) {
  const mapped = mapActivationError(err);
  return c.json(mapped.body, mapped.status as ContentfulStatusCode);
}

export function createReadinessRoutes(deps: ReadinessRouteDeps): Hono {
  const app = new Hono();
  const limited = bodyLimit({ maxSize: READINESS_BODY_LIMIT });
  const emptyLimited = bodyLimit({ maxSize: READINESS_EMPTY_BODY_LIMIT });
  const principalFor = (c: Context) => deps.getPrincipal?.(c) ?? requireRequestPrincipal(c);

  app.get("/readiness", async (c) => {
    try {
      const principal = principalFor(c);
      return c.json(await deps.service.getReadiness(principal.userId));
    } catch (err) {
      return jsonError(c, err);
    }
  });

  app.post("/goals", limited, async (c) => {
    try {
      const principal = principalFor(c);
      const body = SelectGoalsRequestSchema.parse(await c.req.json());
      return c.json(await deps.service.selectGoals(principal.userId, body.goalIds));
    } catch (err) {
      return jsonError(c, err);
    }
  });

  app.post("/gates/:gateId/retry", emptyLimited, async (c) => {
    try {
      const principal = principalFor(c);
      const { gateId } = RetryGateParamsSchema.parse({ gateId: c.req.param("gateId") });
      return c.json(await deps.service.retryGate(principal.userId, gateId), 202);
    } catch (err) {
      return jsonError(c, err);
    }
  });

  return app;
}

