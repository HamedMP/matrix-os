/**
 * Cron + channels routes (extracted from server.ts, Phase 1-A1.3).
 *
 * Pure move: handler bodies are byte-identical to the inline versions.
 */

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { CronService } from "../cron/service.js";
import type { CronJob, CronSchedule, CronTarget } from "../cron/types.js";
import type { ChannelManager } from "../channels/manager.js";

const CRON_BODY_LIMIT = 64 * 1024; // 64 KiB

export interface CronChannelsRouteDeps {
  cronService: CronService;
  channelManager: ChannelManager;
}

export function createCronChannelsRoutes(deps: CronChannelsRouteDeps): Hono {
  const app = new Hono();
  const cronBodyLimit = bodyLimit({ maxSize: CRON_BODY_LIMIT });

  app.get("/api/cron", (c) => {
    return c.json(deps.cronService.listJobs());
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
    let schedule: CronSchedule;
    if (type === "interval" && body.schedule.intervalMs) {
      schedule = { type: "interval", intervalMs: body.schedule.intervalMs };
    } else if (type === "cron" && body.schedule.cron) {
      schedule = { type: "cron", cron: body.schedule.cron };
    } else if (type === "once" && body.schedule.at) {
      schedule = { type: "once", at: body.schedule.at };
    } else {
      return c.json({ error: "Invalid schedule" }, 400);
    }
    const job: CronJob = {
      id: crypto.randomUUID(),
      name: body.name,
      message: body.message,
      schedule,
      target: body.target as CronTarget | undefined,
      createdAt: new Date().toISOString(),
    };
    deps.cronService.addJob(job);
    return c.json(job, 201);
  });

  app.delete("/api/cron/:id", cronBodyLimit, (c) => {
    const id = c.req.param("id");
    const removed = deps.cronService.removeJob(id);
    if (!removed) return c.json({ error: "Not found" }, 404);
    return c.json({ ok: true });
  });

  app.get("/api/channels/status", (c) => {
    return c.json(deps.channelManager.status());
  });

  return app;
}
