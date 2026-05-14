import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod/v4";
import { requestHasBody } from "../http-body.js";
import { PROJECT_SLUG_REGEX } from "../project-manager.js";
import { isRequestPrincipalError, mapRequestPrincipalError, requireRequestPrincipal, type RequestPrincipal } from "../request-principal.js";
import { TicketAutomationRuleSchema, type TicketAutomationRule } from "./automation-contracts.js";
import { ticketError } from "./contracts.js";
import type { TicketAutomationRepository } from "./automation-repository.js";

const ProjectSlugSchema = z.string().regex(PROJECT_SLUG_REGEX);

function status(code: number): ContentfulStatusCode {
  return code as ContentfulStatusCode;
}

export function createTicketAutomationRoutes(deps: {
  repository: Pick<TicketAutomationRepository, "saveRule" | "listRules">;
  getPrincipal?: (c: Context) => RequestPrincipal;
}) {
  const app = new Hono();
  const limited = bodyLimit({ maxSize: 32 * 1024 });

  app.get("/:projectSlug/tickets/automations", async (c) => {
    const projectSlug = ProjectSlugSchema.safeParse(c.req.param("projectSlug"));
    if (!projectSlug.success) return c.json(ticketError("invalid_project_slug", "Project slug is invalid"), status(400));
    try {
      const principal = deps.getPrincipal?.(c) ?? requireRequestPrincipal(c, { requireAuthContextReady: false });
      const automations = await deps.repository.listRules(principal.userId, projectSlug.data);
      return c.json({ automations });
    } catch (err: unknown) {
      if (isRequestPrincipalError(err)) {
        const mapped = mapRequestPrincipalError(err, "Ticket automation request failed");
        if (mapped.log) console.error("[tickets] Automation principal resolution failed:", err);
        return c.json(ticketError("unauthorized", mapped.body.error), status(mapped.status));
      }
      console.error("[tickets] Automation list failed:", err);
      return c.json(ticketError("automation_list_failed", "Ticket automations could not be loaded"), status(500));
    }
  });

  app.post("/:projectSlug/tickets/automations", limited, async (c) => {
    const projectSlug = ProjectSlugSchema.safeParse(c.req.param("projectSlug"));
    if (!projectSlug.success) return c.json(ticketError("invalid_project_slug", "Project slug is invalid"), status(400));
    let raw: unknown = {};
    if (requestHasBody(c)) {
      try {
        raw = await c.req.json();
      } catch (err: unknown) {
        if (!(err instanceof SyntaxError)) {
          console.error("[tickets] Failed to parse automation body:", err);
        }
        return c.json(ticketError("invalid_json", "Request body must be valid JSON"), status(400));
      }
    }
    const parsed = TicketAutomationRuleSchema.safeParse(raw);
    if (!parsed.success) return c.json(ticketError("invalid_request", "Request body is invalid"), status(400));
    try {
      const principal = deps.getPrincipal?.(c) ?? requireRequestPrincipal(c, { requireAuthContextReady: false });
      const automation = await deps.repository.saveRule({
        ...parsed.data,
        ownerId: principal.userId,
        projectSlug: projectSlug.data,
        enabled: true,
      });
      return c.json({ automation }, status(201));
    } catch (err: unknown) {
      if (isRequestPrincipalError(err)) {
        const mapped = mapRequestPrincipalError(err, "Ticket automation request failed");
        if (mapped.log) console.error("[tickets] Automation principal resolution failed:", err);
        return c.json(ticketError("unauthorized", mapped.body.error), status(mapped.status));
      }
      console.error("[tickets] Automation save failed:", err);
      return c.json(ticketError("automation_save_failed", "Ticket automation could not be saved"), status(500));
    }
  });

  return app;
}
