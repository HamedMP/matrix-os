import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  ApproveCapabilityRequestSchema,
  CapabilityParamsSchema,
} from "./activation-contracts.js";
import { mapActivationError } from "./activation-errors.js";
import type { IntegrationCapabilityService } from "./integration-capabilities.js";
import {
  requireRequestPrincipal,
  type RequestPrincipal,
} from "../request-principal.js";

const INTEGRATION_CAPABILITY_BODY_LIMIT = 2048;

export interface IntegrationCapabilityRouteDeps {
  service: IntegrationCapabilityService;
  getPrincipal?: (c: Context) => RequestPrincipal;
}

function jsonError(c: Context, err: unknown) {
  const mapped = mapActivationError(err);
  return c.json(mapped.body, mapped.status as ContentfulStatusCode);
}

export function createIntegrationCapabilityRoutes(deps: IntegrationCapabilityRouteDeps): Hono {
  const app = new Hono();
  const limited = bodyLimit({ maxSize: INTEGRATION_CAPABILITY_BODY_LIMIT });
  const principalFor = (c: Context) => deps.getPrincipal?.(c) ?? requireRequestPrincipal(c);

  app.get("/capabilities", async (c) => {
    try {
      const principal = principalFor(c);
      return c.json(await deps.service.listCapabilities(principal.userId));
    } catch (err) {
      return jsonError(c, err);
    }
  });

  app.post("/capabilities/:capabilityId/approval", limited, async (c) => {
    try {
      const principal = principalFor(c);
      const { capabilityId } = CapabilityParamsSchema.parse({ capabilityId: c.req.param("capabilityId") });
      const body = ApproveCapabilityRequestSchema.parse(await c.req.json());
      return c.json(await deps.service.setApproval(principal.userId, capabilityId, body.agent, body.approved));
    } catch (err) {
      return jsonError(c, err);
    }
  });

  return app;
}
