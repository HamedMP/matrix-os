/** Register legacy terminal layout and direct message endpoints. */
import { dirname, join } from "node:path";
import { bodyLimit } from "hono/body-limit";
import type { Hono } from "hono";
import { z } from "zod/v4";
import type { Dispatcher, DispatchContext } from "../dispatcher.js";
import type { KernelEvent } from "@matrix-os/kernel";

const ApiMessageBodySchema = z.object({
  text: z.string().refine((value) => value.trim().length > 0),
  sessionId: z.string().optional(),
  from: z.object({
    handle: z.string(),
    displayName: z.string().optional(),
  }).optional(),
});

export interface MessageLayoutRouteOptions {
  app: Hono;
  homePath: string;
  dispatcher: Dispatcher;
  logBestEffortFailure(context: string, error: unknown): void;
  logUnexpectedJsonParseFailure(context: string, error: unknown): void;
}

export function registerMessageLayoutRoutes(options: MessageLayoutRouteOptions): void {
  const { app, homePath, dispatcher, logBestEffortFailure,
    logUnexpectedJsonParseFailure } = options;
  app.get("/api/terminal/layout", async (c) => {
    const layoutPath = join(homePath, "system", "terminal-layout.json");
    try {
      const { readFile } = await import("node:fs/promises");
      const data = await readFile(layoutPath, "utf-8");
      return c.json(JSON.parse(data));
    } catch (err: unknown) {
      logBestEffortFailure("Failed to read terminal layout", err);
      return c.json({});
    }
  });

  const terminalLayoutBodyLimit = bodyLimit({ maxSize: 100_000 });
  app.put("/api/terminal/layout", terminalLayoutBodyLimit, async (c) => {
    const layoutPath = join(homePath, "system", "terminal-layout.json");
    const raw = await c.req.text();
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch (err: unknown) {
      logUnexpectedJsonParseFailure("Failed to parse terminal layout payload", err);
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

  app.post("/api/message", bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch (err: unknown) {
      console.warn("[gateway] Invalid /api/message JSON:", err instanceof Error ? err.message : String(err));
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const parsedBody = ApiMessageBodySchema.safeParse(rawBody);
    if (!parsedBody.success) {
      return c.json({ error: "Invalid message body" }, 400);
    }
    const body = parsedBody.data;
    const events: KernelEvent[] = [];

    const context: DispatchContext | undefined = body.from
      ? { senderId: body.from.handle, senderName: body.from.displayName ?? body.from.handle }
      : undefined;

    try {
      await dispatcher.dispatch(body.text, body.sessionId, (event) => {
        events.push(event);
      }, context);
    } catch (err: unknown) {
      console.error("[gateway] Message dispatch failed:", err);
      return c.json({ error: "Message dispatch failed" }, 500);
    }

    return c.json({ events });
  });

}
