import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  AgentCredentialParamsSchema,
} from "./activation-contracts.js";
import { ActivationRouteError, mapActivationError } from "./activation-errors.js";
import type { AgentCredentialStatusService } from "./agent-credential-status.js";
import {
  requireRequestPrincipal,
  type RequestPrincipal,
} from "../request-principal.js";

const AGENT_CREDENTIAL_BODY_LIMIT = 1024;

export interface AgentCredentialRouteDeps {
  service: AgentCredentialStatusService;
  getPrincipal?: (c: Context) => RequestPrincipal;
}

function jsonError(c: Context, err: unknown) {
  const mapped = mapActivationError(err);
  return c.json(mapped.body, mapped.status as ContentfulStatusCode);
}

export function createAgentCredentialRoutes(deps: AgentCredentialRouteDeps): Hono {
  const app = new Hono();
  const limited = bodyLimit({
    maxSize: AGENT_CREDENTIAL_BODY_LIMIT,
    onError: (c) => c.json({
      error: "payload_too_large",
      message: "Request body is too large",
      retryable: false,
    }, 413),
  });
  const principalFor = (c: Context) => deps.getPrincipal?.(c) ?? requireRequestPrincipal(c);

  app.get("/credentials/status", async (c) => {
    try {
      const principal = principalFor(c);
      return c.json(await deps.service.getStatus(principal.userId));
    } catch (err) {
      return jsonError(c, err);
    }
  });

  app.post("/credentials/:agent/verify", limited, async (c) => {
    try {
      const principal = principalFor(c);
      const { agent } = AgentCredentialParamsSchema.parse({ agent: c.req.param("agent") });
      if (c.req.raw.body) {
        await c.req.text();
      }
      if (agent === "hermes") {
        throw new ActivationRouteError("invalid_request", "Hermes is always available and does not need verification", { status: 400 });
      }
      return c.json(await deps.service.verifyAgent(principal.userId, agent));
    } catch (err) {
      return jsonError(c, err);
    }
  });

  return app;
}
