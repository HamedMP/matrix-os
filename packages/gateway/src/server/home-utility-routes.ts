/** Register owner home utility routes after canonical bridge and history routes. */
import { existsSync, readFileSync } from "node:fs";
import { mkdir as mkdirAsync, writeFile as writeFileAsync } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createTask, getTask, listTasks, loadHandle } from "@matrix-os/kernel";
import type { CanvasService } from "../canvas/service.js";
import type { ChannelManager } from "../channels/manager.js";
import type { ConversationStore } from "../conversations.js";
import type { CronService } from "../cron/service.js";
import type { Dispatcher } from "../dispatcher.js";
import type { InteractionLogger } from "../logger.js";
import { isRequestPrincipalError, mapRequestPrincipalError, requireRequestPrincipal } from "../request-principal.js";
import { registerAppManagementRoutes } from "./app-management-routes.js";
import type { ServerMessage } from "./types.js";

export interface HomeUtilityRouteOptions {
  app: Hono;
  homePath: string;
  conversations: ConversationStore;
  canvasService: CanvasService | null;
  dispatcher: Dispatcher;
  cronService: CronService;
  channelManager: ChannelManager;
  interactionLogger: InteractionLogger;
  broadcast(message: ServerMessage): void;
  logBestEffortFailure(context: string, error: unknown): void;
}

export function registerHomeUtilityRoutes(options: HomeUtilityRouteOptions): void {
  const { app, homePath, conversations, canvasService, dispatcher, cronService,
    channelManager, interactionLogger, broadcast, logBestEffortFailure } = options;
  const conversationBodyLimit = bodyLimit({ maxSize: 4096 });
  const layoutBodyLimit = bodyLimit({ maxSize: 100_000 });
  const canvasBodyLimit = bodyLimit({ maxSize: 100_000 });
  const taskBodyLimit = bodyLimit({ maxSize: 64 * 1024 });
  const cronBodyLimit = bodyLimit({ maxSize: 64 * 1024 });
  app.post("/api/conversations", conversationBodyLimit, async (c) => {
    let body: { channel?: string } = {};
    try {
      body = await c.req.json<{ channel?: string }>();
    } catch (err: unknown) {
      if (!(err instanceof SyntaxError)) {
        console.error("[gateway] Failed to read conversation create body:", err);
      }
    }
    const id = conversations.create(body.channel);
    return c.json({ id }, 201);
  });

  app.get("/api/conversations/:id/search", (c) => {
    const query = c.req.query("q");
    if (!query) return c.json({ error: "q parameter required" }, 400);
    const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;
    const results = conversations.search(query, { limit });
    return c.json(results);
  });

  app.get("/api/layout", (c) => {
    const layoutPath = join(homePath, "system/layout.json");
    if (!existsSync(layoutPath)) {
      return c.json({});
    }
    try {
      const data = JSON.parse(readFileSync(layoutPath, "utf-8"));
      return c.json(data);
    } catch (err: unknown) {
      logBestEffortFailure("Failed to read layout", err);
      return c.json({});
    }
  });

  app.put("/api/layout", layoutBodyLimit, async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    if (!body || typeof body !== "object" || !Array.isArray(body.windows)) {
      return c.json({ error: "Invalid layout: requires windows array" }, 400);
    }
    const layoutPath = join(homePath, "system/layout.json");
    await mkdirAsync(dirname(layoutPath), { recursive: true });
    await writeFileAsync(layoutPath, JSON.stringify(body, null, 2));
    return c.json({ ok: true });
  });

  app.get("/api/canvas", async (c) => {
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
      logBestEffortFailure("Failed to read Postgres-backed canvas summaries", err);
      return c.json({ error: "Canvas request failed" }, 500);
    }
  });

  app.put("/api/canvas", canvasBodyLimit, (c) => {
    if (!canvasService) {
      return c.json({ error: "Database not configured (no DATABASE_URL)" }, 503);
    }
    return c.json({
      error: "Legacy canvas writes moved to /api/canvases",
      canvasesEndpoint: "/api/canvases",
    }, 410);
  });

  app.get("/api/theme", (c) => {
    const themePath = join(homePath, "system/theme.json");
    if (!existsSync(themePath)) {
      return c.json({ error: "No theme" }, 404);
    }
    const theme = JSON.parse(readFileSync(themePath, "utf-8"));
    return c.json(theme);
  });

  app.all("/modules/:name/*", async (c) => {
    const moduleName = c.req.param("name");
    const modulesPath = join(homePath, "system/modules.json");

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

  app.get("/api/tasks", (c) => {
    const status = c.req.query("status");
    const tasks = listTasks(dispatcher.db, status ? { status } : undefined);
    return c.json(tasks);
  });

  app.post("/api/tasks", taskBodyLimit, async (c) => {
    const body = await c.req.json<{ type?: string; input: string; priority?: number }>();
    if (!body.input || typeof body.input !== "string") {
      return c.json({ error: "input is required" }, 400);
    }
    const id = createTask(dispatcher.db, {
      type: body.type ?? "todo",
      input: body.input,
      priority: body.priority,
    });
    const task = getTask(dispatcher.db, id);
    broadcast({
      type: "task:created",
      task: { id, type: body.type ?? "todo", status: "pending", input: body.input },
    });
    return c.json({ id, task }, 201);
  });

  app.get("/api/tasks/:id", (c) => {
    const task = getTask(dispatcher.db, c.req.param("id"));
    if (!task) return c.json({ error: "Not found" }, 404);
    return c.json(task);
  });

  registerAppManagementRoutes(app, { homePath });

  app.get("/api/cron", (c) => {
    return c.json(cronService.listJobs());
  });

  app.post("/api/cron", cronBodyLimit, async (c) => {
    const body = await c.req.json<{
      name: string;
      message: string;
      schedule: { type: string; intervalMs?: number; cron?: string; at?: string };
      target?: { channel: string; chatId: string };
    }>();
    if (!body.name || !body.message || !body.schedule?.type) {
      return c.json({ error: "name, message, and schedule.type are required" }, 400);
    }
    const { type } = body.schedule;
    let schedule: import("../cron/types.js").CronSchedule;
    if (type === "interval" && body.schedule.intervalMs) {
      schedule = { type: "interval", intervalMs: body.schedule.intervalMs };
    } else if (type === "cron" && body.schedule.cron) {
      schedule = { type: "cron", cron: body.schedule.cron };
    } else if (type === "once" && body.schedule.at) {
      schedule = { type: "once", at: body.schedule.at };
    } else {
      return c.json({ error: "Invalid schedule" }, 400);
    }
    const job: import("../cron/types.js").CronJob = {
      id: crypto.randomUUID(),
      name: body.name,
      message: body.message,
      schedule,
      target: body.target as import("../cron/types.js").CronTarget | undefined,
      createdAt: new Date().toISOString(),
    };
    cronService.addJob(job);
    return c.json(job, 201);
  });

  app.delete("/api/cron/:id", (c) => {
    const id = c.req.param("id");
    const removed = cronService.removeJob(id);
    if (!removed) return c.json({ error: "Not found" }, 404);
    return c.json({ ok: true });
  });

  app.get("/api/channels/status", (c) => {
    return c.json(channelManager.status());
  });

  app.get("/api/identity", (c) => {
    return c.json(loadHandle(homePath));
  });

  app.get("/api/profile", (c) => {
    const profilePath = join(homePath, "system", "profile.md");
    if (!existsSync(profilePath)) return c.text("No profile", 404);
    return c.text(readFileSync(profilePath, "utf-8"));
  });

  app.get("/api/ai-profile", (c) => {
    const aiProfilePath = join(homePath, "system", "ai-profile.md");
    if (!existsSync(aiProfilePath)) return c.text("No AI profile", 404);
    return c.text(readFileSync(aiProfilePath, "utf-8"));
  });

  app.get("/api/logs", (c) => {
    const date = c.req.query("date") ?? new Date().toISOString().slice(0, 10);
    const source = c.req.query("source");
    const entries = interactionLogger.query({ date, source });
    return c.json({ entries, totalCost: interactionLogger.totalCost(date) });
  });

  app.get("/api/security/audit", async (c) => {
    const { runSecurityAudit } = await import("@matrix-os/kernel/security/audit");
    const report = await runSecurityAudit(homePath);
    return c.json(report);
  });

}
