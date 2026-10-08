import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { AoedeBootstrapRequestSchema, AoedeBootstrapResponseSchema } from "@matrix-os/contracts";
import { isRequestPrincipalError, mapRequestPrincipalError, type RequestPrincipal } from "../request-principal.js";
import { AoedeBootstrapError, type AoedeBootstrapService } from "./bootstrap-service.js";

const invalidRequest = { code: "session_conflict", retryable: false, recovery: "none" } as const;

export function createAoedeRoutes(deps: {
  service: Pick<AoedeBootstrapService, "bootstrap">;
  requirePrincipal(c: Context): RequestPrincipal;
}): Hono {
  const app = new Hono();
  app.post("/api/aoede/bootstrap", bodyLimit({ maxSize: 4 * 1024,
    onError: (c) => c.json({ error: invalidRequest }, 413),
  }), async (c) => {
    let requestValidated = false;
    try {
      const principal = deps.requirePrincipal(c);
      const request = AoedeBootstrapRequestSchema.parse(await c.req.json());
      requestValidated = true;
      return c.json(AoedeBootstrapResponseSchema.parse(await deps.service.bootstrap(principal, request)));
    } catch (error: unknown) {
      if (isRequestPrincipalError(error)) {
        const mapped = mapRequestPrincipalError(error);
        return c.json({ error: { code: mapped.status === 401 ? "permission_denied" : "internal_failure",
          retryable: false, recovery: "none" } }, mapped.status);
      }
      if (error instanceof AoedeBootstrapError) {
        return c.json({ error: { code: error.code, retryable: error.retryable, recovery: error.recovery } }, error.status);
      }
      if (!requestValidated && (error instanceof z.ZodError || error instanceof SyntaxError)) return c.json({ error: invalidRequest }, 400);
      if (error instanceof Error && error.name === "BodyLimitError") return c.json({ error: invalidRequest }, 413);
      console.warn("[aoede] bootstrap failed", { error: error instanceof Error ? error.name : "UnknownError" });
      return c.json({ error: { code: "internal_failure", retryable: true, recovery: "retry_connection" } }, 500);
    }
  });
  return app;
}
