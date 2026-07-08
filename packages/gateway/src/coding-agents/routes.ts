import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { SafeClientErrorSchema } from "@matrix-os/contracts";
import {
  isRequestPrincipalError,
  mapRequestPrincipalError,
  requireRequestPrincipal,
  type RequestPrincipal,
} from "../request-principal.js";
import type { CodingAgentRuntimeSummaryService } from "./runtime-summary.js";

export interface CodingAgentRouteDeps {
  service: CodingAgentRuntimeSummaryService;
  getPrincipal?: (c: Context) => RequestPrincipal;
}

function summaryUnavailable() {
  return SafeClientErrorSchema.parse({
    code: "summary_unavailable",
    safeMessage: "Runtime summary is temporarily unavailable. Try again.",
    retryable: true,
    recoveryActions: ["retry"],
  });
}

export function createCodingAgentRoutes(deps: CodingAgentRouteDeps): Hono {
  const app = new Hono();
  const principalFor = (c: Context) => deps.getPrincipal?.(c) ?? requireRequestPrincipal(c);

  app.get("/summary", async (c) => {
    try {
      const principal = principalFor(c);
      return c.json(await deps.service.getSummary(principal));
    } catch (err: unknown) {
      if (isRequestPrincipalError(err)) {
        const mapped = mapRequestPrincipalError(err);
        return c.json(mapped.body, mapped.status as ContentfulStatusCode);
      }
      console.warn("[coding-agents] summary route failed:", err instanceof Error ? err.message : String(err));
      return c.json({ error: summaryUnavailable() }, 503);
    }
  });

  return app;
}
