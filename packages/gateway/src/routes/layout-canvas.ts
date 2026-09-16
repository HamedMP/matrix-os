/**
 * Layout / canvas / theme / module-proxy routes (extracted from server.ts, Phase 1-A1.2).
 *
 * Pure move: handler bodies are byte-identical to the inline versions.
 * Owns the file-backed UI-state surface (`system/layout.json`,
 * `system/theme.json`) plus the legacy canvas endpoints and the local
 * module proxy.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdir as mkdirAsync, writeFile as writeFileAsync } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { CanvasService } from "../canvas/service.js";
import {
  isRequestPrincipalError,
  mapRequestPrincipalError,
  requireRequestPrincipal,
} from "../domains/identity/request-principal.js";

const LAYOUT_BODY_LIMIT = 100_000; // 100 KiB
const CANVAS_BODY_LIMIT = 100_000; // 100 KiB

export interface LayoutCanvasRouteDeps {
  homePath: string;
  /** Request-time reader: nulled on DB shutdown, so a closure preserves the
   *  original read-timing instead of a mount-time snapshot. */
  getCanvasService: () => CanvasService | null;
  logBestEffortFailure: (context: string, err: unknown) => void;
}

export function createLayoutCanvasRoutes(deps: LayoutCanvasRouteDeps): Hono {
  const app = new Hono();
  const layoutBodyLimit = bodyLimit({ maxSize: LAYOUT_BODY_LIMIT });
  const canvasBodyLimit = bodyLimit({ maxSize: CANVAS_BODY_LIMIT });

  app.get("/api/layout", (c) => {
    const layoutPath = join(deps.homePath, "system/layout.json");
    if (!existsSync(layoutPath)) {
      return c.json({});
    }
    try {
      const data = JSON.parse(readFileSync(layoutPath, "utf-8"));
      return c.json(data);
    } catch (err: unknown) {
      deps.logBestEffortFailure("Failed to read layout", err);
      return c.json({});
    }
  });

  app.put("/api/layout", layoutBodyLimit, async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    if (!body || typeof body !== "object" || !Array.isArray(body.windows)) {
      return c.json({ error: "Invalid layout: requires windows array" }, 400);
    }
    const layoutPath = join(deps.homePath, "system/layout.json");
    await mkdirAsync(dirname(layoutPath), { recursive: true });
    await writeFileAsync(layoutPath, JSON.stringify(body, null, 2));
    return c.json({ ok: true });
  });

  app.get("/api/canvas", async (c) => {
    const canvasService = deps.getCanvasService();
    if (!canvasService) {
      return c.json({ error: "Database not configured (no DATABASE_URL)" }, 503);
    }
    try {
      const userId = requireRequestPrincipal(c).userId;
      const result = await canvasService.listCanvases(userId);
      return c.json({
        legacy: true,
        canvasesEndpoint: "/api/canvases",
        canvases: result.canvases,
      });
    } catch (err: unknown) {
      if (isRequestPrincipalError(err)) {
        const mapped = mapRequestPrincipalError(err, "Canvas request failed");
        if (mapped.log) {
          console.error("[canvas] Legacy canvas route request principal misconfigured:", err.name);
        }
        return c.json(mapped.body, mapped.status);
      }
      deps.logBestEffortFailure("Failed to read Postgres-backed canvas summaries", err);
      return c.json({ error: "Canvas request failed" }, 500);
    }
  });

  app.put("/api/canvas", canvasBodyLimit, (c) => {
    if (!deps.getCanvasService()) {
      return c.json({ error: "Database not configured (no DATABASE_URL)" }, 503);
    }
    return c.json({
      error: "Legacy canvas writes moved to /api/canvases",
      canvasesEndpoint: "/api/canvases",
    }, 410);
  });

  app.get("/api/theme", (c) => {
    const themePath = join(deps.homePath, "system/theme.json");
    if (!existsSync(themePath)) {
      return c.json({ error: "No theme" }, 404);
    }
    const theme = JSON.parse(readFileSync(themePath, "utf-8"));
    return c.json(theme);
  });

  app.all("/modules/:name/*", async (c) => {
    const moduleName = c.req.param("name");
    const modulesPath = join(deps.homePath, "system/modules.json");

    if (!existsSync(modulesPath)) {
      return c.text("No modules registered", 404);
    }

    const modules = JSON.parse(readFileSync(modulesPath, "utf-8")) as Array<{
      name: string;
      port: number;
      status: string;
    }>;

    const mod = modules.find((m) => m.name === moduleName);
    if (!mod) {
      return c.text(`Module "${moduleName}" not found`, 404);
    }

    const subPath = c.req.path.replace(`/modules/${moduleName}`, "") || "/";
    const targetUrl = `http://localhost:${mod.port}${subPath}`;

    const res = await fetch(targetUrl, {
      method: c.req.method,
      headers: c.req.raw.headers,
      signal: AbortSignal.timeout(30_000),
      body: c.req.method !== "GET" && c.req.method !== "HEAD"
        ? c.req.raw.body
        : undefined,
    });

    return new Response(res.body, {
      status: res.status,
      headers: res.headers,
    });
  });

  return app;
}
