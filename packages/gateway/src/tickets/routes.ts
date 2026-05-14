import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import { requestHasBody } from "../http-body.js";
import { PROJECT_SLUG_REGEX } from "../project-manager.js";
import { isRequestPrincipalError, mapRequestPrincipalError, requireRequestPrincipal, type RequestPrincipal } from "../request-principal.js";
import {
  CreateInternalTicketSchema,
  LinearSyncSchema,
  TICKET_BODY_LIMIT,
  TicketIdSchema,
  TicketListQuerySchema,
  UpdateTicketSchema,
  ticketError,
} from "./contracts.js";
import type { TicketRepository } from "./internal-repository.js";
import { syncLinearTickets, type LinearTicketLike } from "./linear-sync.js";
import { createTicketStatusHub, type TicketStatusHub } from "./status-hub.js";

export interface TicketRoutesDeps {
  repository: TicketRepository;
  statusHub?: TicketStatusHub;
  getPrincipal?: (c: Context) => RequestPrincipal;
  linearSyncSource?: (input: {
    ownerId: string;
    projectSlug: string;
    sourceId: string;
    mode: "preview" | "sync";
  }) => Promise<{ tickets: LinearTicketLike[]; truncated: boolean }>;
}

const ProjectSlugSchema = z.string().regex(PROJECT_SLUG_REGEX);

function status(code: number): ContentfulStatusCode {
  return code as ContentfulStatusCode;
}

async function parseJson<T>(c: Context, schema: z.ZodType<T>): Promise<
  { ok: true; value: T } | { ok: false; response: Response }
> {
  let raw: unknown = {};
  if (requestHasBody(c)) {
    try {
      raw = await c.req.json();
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "BodyLimitError") {
        return { ok: false, response: c.json(ticketError("payload_too_large", "Request body is too large"), status(413)) };
      }
      if (!(err instanceof SyntaxError)) {
        console.error("[tickets] Failed to parse request body:", err);
      }
      return { ok: false, response: c.json(ticketError("invalid_json", "Request body must be valid JSON"), status(400)) };
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, response: c.json(ticketError("invalid_request", "Request body is invalid"), status(400)) };
  }
  return { ok: true, value: parsed.data };
}

async function withPrincipal(c: Context, deps: TicketRoutesDeps, fn: (principal: RequestPrincipal) => Promise<Response>): Promise<Response> {
  try {
    const principal = deps.getPrincipal?.(c) ?? requireRequestPrincipal(c, { requireAuthContextReady: false });
    return await fn(principal);
  } catch (err: unknown) {
    if (!isRequestPrincipalError(err)) throw err;
    const mapped = mapRequestPrincipalError(err, "Ticket request failed");
    if (mapped.log) console.error("[tickets] Principal resolution failed:", err);
    return c.json(ticketError("unauthorized", mapped.body.error), status(mapped.status));
  }
}

function readProjectSlug(c: Context): { ok: true; projectSlug: string } | { ok: false; response: Response } {
  const parsed = ProjectSlugSchema.safeParse(c.req.param("projectSlug"));
  if (!parsed.success) {
    return { ok: false, response: c.json(ticketError("invalid_project_slug", "Project slug is invalid"), status(400)) };
  }
  return { ok: true, projectSlug: parsed.data };
}

export function createTicketRoutes(deps: TicketRoutesDeps) {
  const app = new Hono();
  const limited = bodyLimit({ maxSize: TICKET_BODY_LIMIT });
  const statusHub = deps.statusHub ?? createTicketStatusHub();

  app.get("/:projectSlug/tickets", (c) => withPrincipal(c, deps, async (principal) => {
    const project = readProjectSlug(c);
    if (!project.ok) return project.response;
    const query = TicketListQuerySchema.safeParse(c.req.query());
    if (!query.success) return c.json(ticketError("invalid_query", "Request query is invalid"), status(400));
    return c.json(await deps.repository.listTickets(principal.userId, project.projectSlug, query.data));
  }));

  app.post("/:projectSlug/tickets", limited, (c) => withPrincipal(c, deps, async (principal) => {
    const project = readProjectSlug(c);
    if (!project.ok) return project.response;
    const parsed = await parseJson(c, CreateInternalTicketSchema);
    if (!parsed.ok) return parsed.response;
    const ticket = await deps.repository.createInternalTicket(principal.userId, project.projectSlug, parsed.value);
    statusHub.publish({
      id: `evt_${randomUUID()}`,
      ownerId: principal.userId,
      projectSlug: project.projectSlug,
      ticketId: ticket.id,
      type: "ticket.created",
      ticket,
      createdAt: new Date().toISOString(),
    });
    return c.json({ ticket }, status(201));
  }));

  app.patch("/:projectSlug/tickets/:ticketId", limited, (c) => withPrincipal(c, deps, async (principal) => {
    const project = readProjectSlug(c);
    if (!project.ok) return project.response;
    const ticketId = TicketIdSchema.safeParse(c.req.param("ticketId"));
    if (!ticketId.success) return c.json(ticketError("invalid_ticket_id", "Ticket id is invalid"), status(400));
    const parsed = await parseJson(c, UpdateTicketSchema);
    if (!parsed.ok) return parsed.response;
    const ticket = await deps.repository.updateTicket(principal.userId, project.projectSlug, ticketId.data, parsed.value);
    if (!ticket) return c.json(ticketError("revision_conflict", "Ticket was updated by another request"), status(409));
    statusHub.publish({
      id: `evt_${randomUUID()}`,
      ownerId: principal.userId,
      projectSlug: project.projectSlug,
      ticketId: ticket.id,
      type: "ticket.updated",
      ticket,
      createdAt: new Date().toISOString(),
    });
    return c.json({ ticket });
  }));

  app.post("/:projectSlug/tickets/sync/linear", limited, (c) => withPrincipal(c, deps, async (principal) => {
    const project = readProjectSlug(c);
    if (!project.ok) return project.response;
    const parsed = await parseJson(c, LinearSyncSchema);
    if (!parsed.ok) return parsed.response;
    if (!deps.linearSyncSource) return c.json(ticketError("linear_sync_unavailable", "Linear sync is unavailable"), status(503));
    const source = await deps.linearSyncSource({
      ownerId: principal.userId,
      projectSlug: project.projectSlug,
      sourceId: parsed.value.sourceId,
      mode: parsed.value.mode,
    });
    if (parsed.value.mode === "preview") {
      return c.json({ tickets: source.tickets, truncated: source.truncated, sourceId: parsed.value.sourceId });
    }
    const summary = await syncLinearTickets(deps.repository, {
      ownerId: principal.userId,
      projectSlug: project.projectSlug,
      sourceId: parsed.value.sourceId,
      tickets: source.tickets,
      truncated: source.truncated,
    });
    statusHub.publish({
      id: `evt_${randomUUID()}`,
      ownerId: principal.userId,
      projectSlug: project.projectSlug,
      ticketId: parsed.value.sourceId,
      type: "ticket.sync.completed",
      createdAt: new Date().toISOString(),
    });
    return c.json({ ...summary, sourceId: parsed.value.sourceId });
  }));

  app.get("/:projectSlug/tickets/events", (c) => withPrincipal(c, deps, async (principal) => {
    const project = readProjectSlug(c);
    if (!project.ok) return project.response;
    return c.json({ events: statusHub.recent(principal.userId, project.projectSlug, 100) });
  }));

  return app;
}
