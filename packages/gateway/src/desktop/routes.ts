import { Hono } from "hono";
import type { PrincipalRuntimeConfig } from "../request-principal.js";
import {
  isRequestPrincipalError,
  mapRequestPrincipalError,
  requireRequestPrincipal,
} from "../request-principal.js";
import { DesktopRuntimePolicySchema } from "./contracts.js";
import {
  createGatewayDesktopRuntimePolicy,
  type GatewayDesktopRuntimePolicyInput,
} from "./runtime-policy.js";

export interface DesktopRouteDeps {
  auth?: Partial<PrincipalRuntimeConfig>;
  instance: GatewayDesktopRuntimePolicyInput;
}

export function createDesktopRoutes(deps: DesktopRouteDeps): Hono {
  const app = new Hono();

  app.get("/runtime", (ctx) => {
    try {
      requireRequestPrincipal(ctx, deps.auth);
      const policy = createGatewayDesktopRuntimePolicy(deps.instance);
      return ctx.json(DesktopRuntimePolicySchema.parse(policy));
    } catch (err: unknown) {
      if (isRequestPrincipalError(err)) {
        const mapped = mapRequestPrincipalError(err);
        if (mapped.log) {
          console.error("[desktop] Runtime route principal error", err.name);
        }
        return ctx.json(mapped.body, mapped.status);
      }
      console.error("[desktop] Runtime policy failed", err instanceof Error ? err.name : "UnknownError");
      return ctx.json({ error: "Request failed" }, 500);
    }
  });

  return app;
}
