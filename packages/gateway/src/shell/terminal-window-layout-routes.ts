import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import {
  TerminalLayoutRevisionConflictError,
  TerminalWindowLayoutIdSchema,
  TerminalWindowLayoutSchema,
  type TerminalWindowLayout,
} from "./terminal-window-layout-store.js";

interface TerminalWindowLayoutRouteStore {
  get(layoutId: string): Promise<{ layoutId: string; revision: number; layout: TerminalWindowLayout }>;
  put(
    layoutId: string,
    baseRevision: number,
    layout: TerminalWindowLayout,
  ): Promise<{ layoutId: string; revision: number; layout: TerminalWindowLayout }>;
  deleteLayout(layoutId: string): Promise<void>;
}

const PutLayoutBodySchema = z.object({
  baseRevision: z.number().int().nonnegative(),
  layout: TerminalWindowLayoutSchema,
}).strict();

export function createTerminalWindowLayoutRoutes(
  deps: { store: TerminalWindowLayoutRouteStore },
): Hono {
  const app = new Hono();
  const writeBodyLimit = bodyLimit({ maxSize: 100_000 });
  const deleteBodyLimit = bodyLimit({ maxSize: 512 });

  app.get("/:layoutId", async (c) => {
    try {
      const layoutId = TerminalWindowLayoutIdSchema.parse(c.req.param("layoutId"));
      return c.json(await deps.store.get(layoutId));
    } catch (err: unknown) {
      if (err instanceof z.ZodError) {
        return c.json({ error: { code: "invalid_layout", message: "Invalid request" } }, 400);
      }
      console.error("[terminal-layout] read failed:", err instanceof Error ? err.name : "UnknownError");
      return c.json({ error: { code: "layout_unavailable", message: "Request failed" } }, 500);
    }
  });

  app.put("/:layoutId", writeBodyLimit, async (c) => {
    try {
      const layoutId = TerminalWindowLayoutIdSchema.parse(c.req.param("layoutId"));
      const body = PutLayoutBodySchema.parse(await c.req.json());
      return c.json(await deps.store.put(layoutId, body.baseRevision, body.layout));
    } catch (err: unknown) {
      if (err instanceof TerminalLayoutRevisionConflictError) {
        return c.json({
          error: { code: "layout_revision_conflict", message: "Layout changed elsewhere" },
        }, 409);
      }
      if (err instanceof z.ZodError || err instanceof SyntaxError) {
        return c.json({ error: { code: "invalid_layout", message: "Invalid request" } }, 400);
      }
      console.error("[terminal-layout] write failed:", err instanceof Error ? err.name : "UnknownError");
      return c.json({ error: { code: "layout_unavailable", message: "Request failed" } }, 500);
    }
  });

  app.delete("/:layoutId", deleteBodyLimit, async (c) => {
    try {
      const layoutId = TerminalWindowLayoutIdSchema.parse(c.req.param("layoutId"));
      await deps.store.deleteLayout(layoutId);
      return c.json({ ok: true });
    } catch (err: unknown) {
      if (err instanceof z.ZodError) {
        return c.json({ error: { code: "invalid_layout", message: "Invalid request" } }, 400);
      }
      console.error("[terminal-layout] delete failed:", err instanceof Error ? err.name : "UnknownError");
      return c.json({ error: { code: "layout_unavailable", message: "Request failed" } }, 500);
    }
  });

  return app;
}
