import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  CanvasActionSchema,
  CanvasIdSchema,
  CreateCanvasRequestSchema,
  PatchCanvasNodeRequestSchema,
  ReplaceCanvasRequestSchema,
  type CanvasAction,
  type CanvasDocumentWrite,
  type CreateCanvasRequest,
} from "./contracts.js";
import { mapCanvasError } from "./service.js";

const CANVAS_WRITE_BODY_LIMIT = 256 * 1024;
const CANVAS_ACTION_BODY_LIMIT = 64 * 1024;

export interface CanvasRouteService {
  listCanvases(userId: string, query?: { scopeType?: string; scopeId?: string; limit?: number; cursor?: string }): Promise<unknown>;
  createCanvas(userId: string, input: CreateCanvasRequest): Promise<unknown>;
  getCanvas(userId: string, canvasId: string): Promise<unknown>;
  replaceCanvas(userId: string, canvasId: string, input: { baseRevision: number; document: CanvasDocumentWrite }): Promise<unknown>;
  patchCanvasNode?(userId: string, canvasId: string, input: { baseRevision: number; nodeId: string; updates: Record<string, unknown> }): Promise<unknown>;
  deleteCanvas(userId: string, canvasId: string): Promise<unknown>;
  exportCanvas(userId: string, canvasId: string): Promise<unknown>;
  executeAction(userId: string, canvasId: string, action: CanvasAction): Promise<unknown>;
}

export interface CanvasRouteDeps {
  service: CanvasRouteService;
  getUserId: (c: any) => string;
}

async function parseJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch (err: unknown) {
    if (err instanceof SyntaxError) {
      throw err;
    }
    throw err;
  }
}

function getUserIdOrThrow(deps: CanvasRouteDeps, c: any): string {
  try {
    const userId = deps.getUserId(c);
    if (!userId) throw new Error("missing user");
    return userId;
  } catch {
    throw new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
}

function parseCanvasId(c: any): string {
  return CanvasIdSchema.parse(c.req.param("canvasId"));
}

function bodyTooLarge(c: any) {
  return c.json({ error: "Request body too large" }, 413);
}

function validationError(c: any) {
  return c.json({ error: "Invalid request" }, 400);
}

function handleError(c: any, err: unknown) {
  if (err instanceof Response) return err;
  if (typeof err === "object" && err !== null && "issues" in err) {
    return validationError(c);
  }
  const mapped = mapCanvasError(err);
  const body: Record<string, unknown> = { error: mapped.error };
  if (mapped.latestRevision !== undefined) body.latestRevision = mapped.latestRevision;
  return c.json(body, mapped.status as 400 | 401 | 403 | 404 | 409 | 500);
}

export function createCanvasRoutes(deps: CanvasRouteDeps): Hono {
  const app = new Hono();
  const writeBodyLimit = bodyLimit({ maxSize: CANVAS_WRITE_BODY_LIMIT, onError: bodyTooLarge });
  const actionBodyLimit = bodyLimit({ maxSize: CANVAS_ACTION_BODY_LIMIT, onError: bodyTooLarge });

  app.get("/", async (c) => {
    try {
      const userId = getUserIdOrThrow(deps, c);
      const limitParam = c.req.query("limit");
      const limit = limitParam ? Number(limitParam) : undefined;
      return c.json(await deps.service.listCanvases(userId, {
        scopeType: c.req.query("scopeType"),
        scopeId: c.req.query("scopeId"),
        limit: Number.isFinite(limit) ? limit : undefined,
        cursor: c.req.query("cursor"),
      }));
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
      const parsed = ReplaceCanvasRequestSchema.safeParse(await parseJson(c));
      if (!parsed.success) return validationError(c);
      return c.json(await deps.service.replaceCanvas(userId, parseCanvasId(c), parsed.data));
    } catch (err: unknown) {
      return handleError(c, err);
    }
  });

  app.patch("/:canvasId/nodes/:nodeId", actionBodyLimit, async (c) => {
    try {
      const userId = getUserIdOrThrow(deps, c);
      const canvasId = parseCanvasId(c);
      const nodeId = c.req.param("nodeId");
      const parsed = PatchCanvasNodeRequestSchema.safeParse(await parseJson(c));
      if (!parsed.success) return validationError(c);
      if (!deps.service.patchCanvasNode) {
        return c.json({ error: "Canvas request failed" }, 500);
      }
      return c.json(await deps.service.patchCanvasNode(userId, canvasId, {
        baseRevision: parsed.data.baseRevision,
        nodeId,
        updates: parsed.data.updates,
      }));
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

  app.delete("/:canvasId", async (c) => {
    try {
      const userId = getUserIdOrThrow(deps, c);
      return c.json(await deps.service.deleteCanvas(userId, parseCanvasId(c)));
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
