import { Hono } from "hono";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export function createApp(homePath: string) {
  const app = new Hono();

  app.get("/api/canvas", (c) => {
    const canvasPath = join(homePath, "system/canvas.json");
    if (!existsSync(canvasPath)) {
      return c.json({});
    }
    try {
      const data = JSON.parse(readFileSync(canvasPath, "utf-8"));
      return c.json(data);
    } catch {
      return c.json({});
    }
  });

  app.put("/api/canvas", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    if (!body || typeof body !== "object" || !body.transform) {
      return c.json({ error: "Invalid canvas data: requires transform object" }, 400);
    }
    const canvasPath = join(homePath, "system/canvas.json");
    writeFileSync(canvasPath, JSON.stringify(body, null, 2));
    return c.json({ ok: true });
  });

  return app;
}
