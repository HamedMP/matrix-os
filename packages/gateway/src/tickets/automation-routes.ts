import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod/v4";
import { requestHasBody } from "../http-body.js";
import { PROJECT_SLUG_REGEX } from "../project-manager.js";
import { requireRequestPrincipal, type RequestPrincipal } from "../request-principal.js";
import { TicketAutomationRuleSchema, type TicketAutomationRule } from "./automation-contracts.js";
import { ticketError } from "./contracts.js";

const ProjectSlugSchema = z.string().regex(PROJECT_SLUG_REGEX);

function status(code: number): ContentfulStatusCode {
  return code as ContentfulStatusCode;
}

export function createTicketAutomationRoutes(deps: {
  saveRule: (rule: Omit<TicketAutomationRule, "id" | "enabled"> & { enabled?: boolean }) => Promise<TicketAutomationRule>;
  getPrincipal?: (c: Context) => RequestPrincipal;
}) {
  const app = new Hono();
  const limited = bodyLimit({ maxSize: 32 * 1024 });

  app.post("/:projectSlug/tickets/automations", limited, async (c) => {
    const projectSlug = ProjectSlugSchema.safeParse(c.req.param("projectSlug"));
    if (!projectSlug.success) return c.json(ticketError("invalid_project_slug", "Project slug is invalid"), status(400));
    let raw: unknown = {};
    if (requestHasBody(c)) {
      try {
        raw = await c.req.json();
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "BodyLimitError") return c.json(ticketError("payload_too_large", "Request body is too large"), status(413));
        return c.json(ticketError("invalid_json", "Request body must be valid JSON"), status(400));
      }
    }
    const parsed = TicketAutomationRuleSchema.safeParse(raw);
    if (!parsed.success) return c.json(ticketError("invalid_request", "Request body is invalid"), status(400));
    const principal = deps.getPrincipal?.(c) ?? requireRequestPrincipal(c, { requireAuthContextReady: false });
    const automation = await deps.saveRule({
      ...parsed.data,
      ownerId: principal.userId,
      projectSlug: projectSlug.data,
      enabled: true,
    });
    return c.json({ automation }, status(201));
  });

  return app;
}
