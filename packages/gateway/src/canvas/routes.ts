import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import {
  CanvasActionSchema,
  CanvasIdSchema,
  CanvasNodeIdSchema,
  CanvasScopeTypeSchema,
  CreateCanvasRequestSchema,
  PatchCanvasNodeRequestSchema,
  ReplaceCanvasRequestSchema,
  type CanvasAction,
  type CanvasDocumentWrite,
  type PatchCanvasNodeUpdates,
  type CreateCanvasRequest,
} from "./contracts.js";
import { mapCanvasError } from "./service.js";
import { isRequestPrincipalError, mapRequestPrincipalError } from "../request-principal.js";

const CANVAS_WRITE_BODY_LIMIT = 256 * 1024;
const CANVAS_ACTION_BODY_LIMIT = 64 * 1024;

export interface CanvasRouteService {
  listCanvases(userId: string, query?: { scopeType?: string; scopeId?: string; limit?: number; cursor?: string; q?: string }): Promise<unknown>;
  createCanvas(userId: string, input: CreateCanvasRequest): Promise<unknown>;
  getCanvas(userId: string, canvasId: string): Promise<unknown>;
  replaceCanvas(userId: string, canvasId: string, input: { baseRevision: number; document: CanvasDocumentWrite }): Promise<unknown>;
  patchCanvasNode?(userId: string, canvasId: string, input: { baseRevision: number; nodeId: string; updates: PatchCanvasNodeUpdates }): Promise<unknown>;
  deleteCanvas(userId: string, canvasId: string): Promise<unknown>;
  exportCanvas(userId: string, canvasId: string): Promise<unknown>;
  executeAction(userId: string, canvasId: string, action: CanvasAction): Promise<unknown>;
}

export interface CanvasRouteDeps {
  service: CanvasRouteService;
  getUserId: (c: Context) => string;
  broadcastCanvasUpdate?: (canvasId: string, message: { type: "canvas:updated"; revision: number; updatedAt: string } | { type: "canvas:deleted" }) => void | Promise<void>;
}

class CanvasUnauthorizedError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "CanvasUnauthorizedError";
  }
}

async function parseJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  return c.req.json();
}

function getUserIdOrThrow(deps: CanvasRouteDeps, c: Context): string {
  try {
    const userId = deps.getUserId(c);
    if (!userId) throw new Error("missing user");
    return userId;
  } catch (err: unknown) {
    if (isRequestPrincipalError(err)) throw err;
    if (!(err instanceof Error && /missing/i.test(err.message))) {
      console.error("[canvas/routes] User resolution failed:", err);
    }
    throw new CanvasUnauthorizedError();
  }
}

function parseCanvasId(c: Context): string {
  return CanvasIdSchema.parse(c.req.param("canvasId"));
}

const CanvasListQuerySchema = z.object({
  scopeType: CanvasScopeTypeSchema.optional(),
  scopeId: z.string().trim().min(1).max(256).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().trim().min(1).max(256).optional(),
  q: z.string().trim().min(1).max(120).optional(),
});

function bodyTooLarge(c: any) {
  return c.json({ error: "Request body too large" }, 413);
}

function validationError(c: any) {
  return c.json({ error: "Invalid request" }, 400);
}

function handleError(c: any, err: unknown) {
  if (isRequestPrincipalError(err)) {
    const mapped = mapRequestPrincipalError(err, "Canvas request failed");
    if (mapped.log) console.error("[canvas/routes] Request principal misconfigured:", err.name);
    return c.json(mapped.body, mapped.status);
  }
  if (err instanceof CanvasUnauthorizedError) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  if (typeof err === "object" && err !== null && "issues" in err) {
    return validationError(c);
  }
  const mapped = mapCanvasError(err);
  const body: Record<string, unknown> = { error: mapped.error };
  if (mapped.latestRevision !== undefined) body.latestRevision = mapped.latestRevision;
  return c.json(body, mapped.status as 400 | 401 | 403 | 404 | 409 | 500);
}

async function broadcastCanvasUpdate(deps: CanvasRouteDeps, canvasId: string, result: unknown): Promise<void> {
  if (!deps.broadcastCanvasUpdate) return;
  if (
    typeof result !== "object" ||
    result === null ||
    typeof (result as { revision?: unknown }).revision !== "number" ||
    typeof (result as { updatedAt?: unknown }).updatedAt !== "string"
  ) {
    return;
  }

  try {
    await deps.broadcastCanvasUpdate(canvasId, {
      type: "canvas:updated",
      revision: (result as { revision: number }).revision,
      updatedAt: (result as { updatedAt: string }).updatedAt,
    });
  } catch (err: unknown) {
    console.error("[canvas/routes] Realtime broadcast failed:", err instanceof Error ? err.message : String(err));
  }
}

export function createCanvasRoutes(deps: CanvasRouteDeps): Hono {
  const app = new Hono();
  const writeBodyLimit = bodyLimit({ maxSize: CANVAS_WRITE_BODY_LIMIT, onError: bodyTooLarge });
  const actionBodyLimit = bodyLimit({ maxSize: CANVAS_ACTION_BODY_LIMIT, onError: bodyTooLarge });
  const deleteBodyLimit = bodyLimit({ maxSize: 1024, onError: bodyTooLarge });

  app.get("/", async (c) => {
    try {
      const userId = getUserIdOrThrow(deps, c);
      const parsed = CanvasListQuerySchema.safeParse({
        scopeType: c.req.query("scopeType"),
        scopeId: c.req.query("scopeId"),
        limit: c.req.query("limit"),
        cursor: c.req.query("cursor"),
        q: c.req.query("q"),
      });
      if (!parsed.success) return validationError(c);
      return c.json(await deps.service.listCanvases(userId, parsed.data));
    } catch (err: unknown) {
      return handleError(c, err);
    }
  });

  app.post("/", writeBodyLimit, async (c) => {
    try {
      const userId = getUserIdOrThrow(deps, c);
      const parsed = CreateCanvasRequestSchema.safeParse(await parseJson(c));
      if (!parsed.success) return validationError(c);
      return c.json(await deps.service.createCanvas(userId, parsed.data), 201);
    } catch (err: unknown) {
      return handleError(c, err);
    }
  });

  app.get("/:canvasId", async (c) => {
    try {
      const userId = getUserIdOrThrow(deps, c);
      return c.json(await deps.service.getCanvas(userId, parseCanvasId(c)));
    } catch (err: unknown) {
      return handleError(c, err);
    }
  });

  app.put("/:canvasId", writeBodyLimit, async (c) => {
    try {
      const userId = getUserIdOrThrow(deps, c);
      const canvasId = parseCanvasId(c);
      const parsed = ReplaceCanvasRequestSchema.safeParse(await parseJson(c));
      if (!parsed.success) return validationError(c);
      const result = await deps.service.replaceCanvas(userId, canvasId, parsed.data);
      await broadcastCanvasUpdate(deps, canvasId, result);
      return c.json(result);
    } catch (err: unknown) {
      return handleError(c, err);
    }
  });

  app.patch("/:canvasId/nodes/:nodeId", actionBodyLimit, async (c) => {
    try {
      const userId = getUserIdOrThrow(deps, c);
      const canvasId = parseCanvasId(c);
      const nodeId = CanvasNodeIdSchema.parse(c.req.param("nodeId"));
      const parsed = PatchCanvasNodeRequestSchema.safeParse(await parseJson(c));
      if (!parsed.success) return validationError(c);
      if (!deps.service.patchCanvasNode) {
        return c.json({ error: "Canvas request failed" }, 500);
      }
      const result = await deps.service.patchCanvasNode(userId, canvasId, {
        baseRevision: parsed.data.baseRevision,
        nodeId,
        updates: parsed.data.updates,
      });
      await broadcastCanvasUpdate(deps, canvasId, result);
      return c.json(result);
    } catch (err: unknown) {
      return handleError(c, err);
    }
  });

  app.post("/:canvasId/actions", actionBodyLimit, async (c) => {
    try {
      const userId = getUserIdOrThrow(deps, c);
      const parsed = CanvasActionSchema.safeParse(await parseJson(c));
      if (!parsed.success) return validationError(c);
      return c.json(await deps.service.executeAction(userId, parseCanvasId(c), parsed.data));
    } catch (err: unknown) {
      return handleError(c, err);
    }
  });

  app.delete("/:canvasId", deleteBodyLimit, async (c) => {
    try {
      const userId = getUserIdOrThrow(deps, c);
      const canvasId = parseCanvasId(c);
      const result = await deps.service.deleteCanvas(userId, canvasId);
      if (deps.broadcastCanvasUpdate) {
        await deps.broadcastCanvasUpdate(canvasId, { type: "canvas:deleted" });
      }
      return c.json(result);
    } catch (err: unknown) {
      return handleError(c, err);
    }
  });

  app.get("/:canvasId/export", async (c) => {
    try {
      const userId = getUserIdOrThrow(deps, c);
      return c.json(await deps.service.exportCanvas(userId, parseCanvasId(c)));
    } catch (err: unknown) {
      return handleError(c, err);
    }
  });

  return app;
}
