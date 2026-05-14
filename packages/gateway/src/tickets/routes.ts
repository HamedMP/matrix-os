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
  authorizeProjectAccess?: (input: {
    ownerId?: string;
    principalUserId: string;
    projectSlug: string;
    action: "read" | "write";
  }) => Promise<boolean>;
}

const ProjectSlugSchema = z.string().regex(PROJECT_SLUG_REGEX);
const OwnerScopeQuerySchema = z.object({
  ownerId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_@:.=-]+$/).optional(),
}).passthrough();

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

function readOwnerId(c: Context, principal: RequestPrincipal): { ok: true; ownerId: string } | { ok: false; response: Response } {
  const parsed = OwnerScopeQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return { ok: false, response: c.json(ticketError("invalid_query", "Request query is invalid"), status(400)) };
  }
  return { ok: true, ownerId: parsed.data.ownerId ?? principal.userId };
}

async function authorizeProjectAccess(
  c: Context,
  deps: TicketRoutesDeps,
  principal: RequestPrincipal,
  ownerId: string,
  projectSlug: string,
  action: "read" | "write",
): Promise<Response | null> {
  if (!deps.authorizeProjectAccess) {
    return ownerId === principal.userId ? null : c.json(ticketError("unauthorized", "Unauthorized"), status(401));
  }
  try {
    const allowed = await deps.authorizeProjectAccess({
      ownerId,
      principalUserId: principal.userId,
      projectSlug,
      action,
    });
    return allowed ? null : c.json(ticketError("unauthorized", "Unauthorized"), status(401));
  } catch (err: unknown) {
    console.error("[tickets] Project access authorization failed:", err);
    return c.json(ticketError("authorization_failed", "Ticket request failed"), status(500));
  }
}

export function createTicketRoutes(deps: TicketRoutesDeps) {
  const app = new Hono();
  const limited = bodyLimit({ maxSize: TICKET_BODY_LIMIT });
  const statusHub = deps.statusHub ?? createTicketStatusHub();

  app.get("/:projectSlug/tickets", (c) => withPrincipal(c, deps, async (principal) => {
    const project = readProjectSlug(c);
    if (!project.ok) return project.response;
    const owner = readOwnerId(c, principal);
    if (!owner.ok) return owner.response;
    const unauthorized = await authorizeProjectAccess(c, deps, principal, owner.ownerId, project.projectSlug, "read");
    if (unauthorized) return unauthorized;
    const query = TicketListQuerySchema.safeParse(c.req.query());
    if (!query.success) return c.json(ticketError("invalid_query", "Request query is invalid"), status(400));
    return c.json(await deps.repository.listTickets(owner.ownerId, project.projectSlug, query.data));
  }));

  app.post("/:projectSlug/tickets", limited, (c) => withPrincipal(c, deps, async (principal) => {
    const project = readProjectSlug(c);
    if (!project.ok) return project.response;
    const owner = readOwnerId(c, principal);
    if (!owner.ok) return owner.response;
    const unauthorized = await authorizeProjectAccess(c, deps, principal, owner.ownerId, project.projectSlug, "write");
    if (unauthorized) return unauthorized;
    const parsed = await parseJson(c, CreateInternalTicketSchema);
    if (!parsed.ok) return parsed.response;
    const ticket = await deps.repository.createInternalTicket(owner.ownerId, project.projectSlug, parsed.value);
    statusHub.publish({
      id: `evt_${randomUUID()}`,
      ownerId: owner.ownerId,
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
    const owner = readOwnerId(c, principal);
    if (!owner.ok) return owner.response;
    const unauthorized = await authorizeProjectAccess(c, deps, principal, owner.ownerId, project.projectSlug, "write");
    if (unauthorized) return unauthorized;
    const ticketId = TicketIdSchema.safeParse(c.req.param("ticketId"));
    if (!ticketId.success) return c.json(ticketError("invalid_ticket_id", "Ticket id is invalid"), status(400));
    const parsed = await parseJson(c, UpdateTicketSchema);
    if (!parsed.ok) return parsed.response;
    const ticket = await deps.repository.updateTicket(owner.ownerId, project.projectSlug, ticketId.data, parsed.value);
    if (!ticket) return c.json(ticketError("revision_conflict", "Ticket was updated by another request"), status(409));
    statusHub.publish({
      id: `evt_${randomUUID()}`,
      ownerId: owner.ownerId,
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
    const owner = readOwnerId(c, principal);
    if (!owner.ok) return owner.response;
    const unauthorized = await authorizeProjectAccess(c, deps, principal, owner.ownerId, project.projectSlug, "write");
    if (unauthorized) return unauthorized;
    const parsed = await parseJson(c, LinearSyncSchema);
    if (!parsed.ok) return parsed.response;
    if (!deps.linearSyncSource) return c.json(ticketError("linear_sync_unavailable", "Linear sync is unavailable"), status(503));
    const source = await deps.linearSyncSource({
      ownerId: owner.ownerId,
      projectSlug: project.projectSlug,
      sourceId: parsed.value.sourceId,
      mode: parsed.value.mode,
    });
    if (parsed.value.mode === "preview") {
      return c.json({ tickets: source.tickets, truncated: source.truncated, sourceId: parsed.value.sourceId });
    }
    const summary = await syncLinearTickets(deps.repository, {
      ownerId: owner.ownerId,
      projectSlug: project.projectSlug,
      sourceId: parsed.value.sourceId,
      tickets: source.tickets,
      truncated: source.truncated,
    });
    statusHub.publish({
      id: `evt_${randomUUID()}`,
      ownerId: owner.ownerId,
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
    const owner = readOwnerId(c, principal);
    if (!owner.ok) return owner.response;
    const unauthorized = await authorizeProjectAccess(c, deps, principal, owner.ownerId, project.projectSlug, "read");
    if (unauthorized) return unauthorized;
    return c.json({ events: statusHub.recent(owner.ownerId, project.projectSlug, 100) });
  }));

  return app;
}
