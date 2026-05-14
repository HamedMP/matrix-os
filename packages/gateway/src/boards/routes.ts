import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod/v4";
import { requestHasBody } from "../http-body.js";
import { isRequestPrincipalError, mapRequestPrincipalError, requireRequestPrincipal, type RequestPrincipal } from "../request-principal.js";
import {
  AddBoardMemberSchema,
  BOARD_BODY_LIMIT,
  BoardProjectSlugSchema,
  BoardUserIdSchema,
  boardError,
} from "./contracts.js";
import { BoardMemberLimitExceededError, type BoardMembershipService } from "./membership.js";

export interface BoardMembershipRouteDeps {
  service: BoardMembershipService;
  getPrincipal?: (c: Context) => RequestPrincipal;
}

function status(code: number): ContentfulStatusCode {
  return code as ContentfulStatusCode;
}

async function withPrincipal(c: Context, deps: BoardMembershipRouteDeps, fn: (principal: RequestPrincipal) => Promise<Response>): Promise<Response> {
  try {
    const principal = deps.getPrincipal?.(c) ?? requireRequestPrincipal(c, { requireAuthContextReady: false });
    return await fn(principal);
  } catch (err: unknown) {
    if (!isRequestPrincipalError(err)) throw err;
    const mapped = mapRequestPrincipalError(err, "Board request failed");
    if (mapped.log) console.error("[boards] Principal resolution failed:", err);
    return c.json(boardError("unauthorized", mapped.body.error), status(mapped.status));
  }
}

function readProjectSlug(c: Context): { ok: true; projectSlug: string } | { ok: false; response: Response } {
  const parsed = BoardProjectSlugSchema.safeParse(c.req.param("projectSlug"));
  if (!parsed.success) return { ok: false, response: c.json(boardError("invalid_project_slug", "Project slug is invalid"), status(400)) };
  return { ok: true, projectSlug: parsed.data };
}

const OwnerScopeQuerySchema = z.object({
  ownerId: BoardUserIdSchema.optional(),
}).passthrough();

function readOwnerId(c: Context, principal: RequestPrincipal): { ok: true; ownerId: string } | { ok: false; response: Response } {
  const parsed = OwnerScopeQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return { ok: false, response: c.json(boardError("invalid_query", "Request query is invalid"), status(400)) };
  }
  return { ok: true, ownerId: parsed.data.ownerId ?? principal.userId };
}

function canManageBoardMembers(ownerId: string, principal: RequestPrincipal): boolean {
  return ownerId === principal.userId;
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
        return { ok: false, response: c.json(boardError("payload_too_large", "Request body is too large"), status(413)) };
      }
      if (!(err instanceof SyntaxError)) console.error("[boards] Failed to parse request body:", err);
      return { ok: false, response: c.json(boardError("invalid_json", "Request body must be valid JSON"), status(400)) };
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, response: c.json(boardError("invalid_request", "Request body is invalid"), status(400)) };
  return { ok: true, value: parsed.data };
}

export function createBoardMembershipRoutes(deps: BoardMembershipRouteDeps) {
  const app = new Hono();
  const limited = bodyLimit({ maxSize: BOARD_BODY_LIMIT });

  app.get("/:projectSlug/board/members", (c) => withPrincipal(c, deps, async (principal) => {
    const project = readProjectSlug(c);
    if (!project.ok) return project.response;
    const owner = readOwnerId(c, principal);
    if (!owner.ok) return owner.response;
    const canRead = await deps.service.canReadBoard(owner.ownerId, project.projectSlug, principal.userId);
    if (!canRead) return c.json(boardError("unauthorized", "Unauthorized"), status(401));
    return c.json({ members: await deps.service.listMembers(owner.ownerId, project.projectSlug) });
  }));

  app.post("/:projectSlug/board/members", limited, (c) => withPrincipal(c, deps, async (principal) => {
    const project = readProjectSlug(c);
    if (!project.ok) return project.response;
    const owner = readOwnerId(c, principal);
    if (!owner.ok) return owner.response;
    const parsed = await parseJson(c, AddBoardMemberSchema);
    if (!parsed.ok) return parsed.response;
    if (!canManageBoardMembers(owner.ownerId, principal)) {
      return c.json(boardError("unauthorized", "Unauthorized"), status(401));
    }
    let member;
    try {
      member = await deps.service.addMember(owner.ownerId, project.projectSlug, parsed.value);
    } catch (err: unknown) {
      if (err instanceof BoardMemberLimitExceededError) {
        return c.json(boardError("member_limit_exceeded", "Board member limit exceeded"), status(409));
      }
      throw err;
    }
    return c.json({ member }, status(201));
  }));

  app.delete("/:projectSlug/board/members/:userId", limited, (c) => withPrincipal(c, deps, async (principal) => {
    const project = readProjectSlug(c);
    if (!project.ok) return project.response;
    const owner = readOwnerId(c, principal);
    if (!owner.ok) return owner.response;
    const userId = BoardUserIdSchema.safeParse(c.req.param("userId"));
    if (!userId.success) return c.json(boardError("invalid_user_id", "User id is invalid"), status(400));
    if (!canManageBoardMembers(owner.ownerId, principal)) {
      return c.json(boardError("unauthorized", "Unauthorized"), status(401));
    }
    await deps.service.removeMember(owner.ownerId, project.projectSlug, userId.data);
    return c.json({ ok: true });
  }));

  return app;
}
