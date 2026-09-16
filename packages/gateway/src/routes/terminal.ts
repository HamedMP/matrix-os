/**
 * Terminal layout routes (extracted from server.ts, Phase 1-A1.4).
 *
 * Pure move: handler bodies are byte-identical to the inline versions.
 * Owns `system/terminal-layout.json` reads/writes.
 */

import { join, dirname } from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

const TERMINAL_LAYOUT_BODY_LIMIT = 100_000; // 100 KiB

export interface TerminalRouteDeps {
  homePath: string;
  logBestEffortFailure: (context: string, err: unknown) => void;
  logUnexpectedJsonParseFailure: (context: string, err: unknown) => void;
}

export function createTerminalRoutes(deps: TerminalRouteDeps): Hono {
  const app = new Hono();
  const terminalLayoutBodyLimit = bodyLimit({ maxSize: TERMINAL_LAYOUT_BODY_LIMIT });

  app.get("/api/terminal/layout", async (c) => {
    const layoutPath = join(deps.homePath, "system", "terminal-layout.json");
    try {
      const { readFile } = await import("node:fs/promises");
      const data = await readFile(layoutPath, "utf-8");
      return c.json(JSON.parse(data));
    } catch (err: unknown) {
      deps.logBestEffortFailure("Failed to read terminal layout", err);
      return c.json({});
    }
  });

  app.put("/api/terminal/layout", terminalLayoutBodyLimit, async (c) => {
    const layoutPath = join(deps.homePath, "system", "terminal-layout.json");
    const raw = await c.req.text();
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch (err: unknown) {
      deps.logUnexpectedJsonParseFailure("Failed to parse terminal layout payload", err);
      return c.json({ error: "Invalid JSON" }, 400);
    }
    if (typeof body !== "object" || body === null || !Array.isArray((body as Record<string, unknown>).tabs)) {
      return c.json({ error: "Invalid layout schema" }, 400);
    }
    try {
      const { writeFile, mkdir } = await import("node:fs/promises");
      await mkdir(dirname(layoutPath), { recursive: true });
      await writeFile(layoutPath, JSON.stringify(body, null, 2));
      return c.json({ ok: true });
    } catch (err: unknown) {
      console.error("[gateway] Failed to save terminal layout:", err);
      return c.json({ error: "Failed to save layout" }, 500);
    }
  });

  return app;
}
