import { Hono } from "hono";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ChannelManager } from "../channels/manager.js";

export function createSettingsRoutes(opts: {
  homePath: string;
  channelManager: ChannelManager;
}) {
  const { homePath, channelManager } = opts;
  const app = new Hono();
  const configPath = join(homePath, "system/config.json");

  function readConfig(): Record<string, unknown> {
    try {
      if (existsSync(configPath)) {
        return JSON.parse(readFileSync(configPath, "utf-8"));
      }
    } catch { /* invalid */ }
    return {};
  }

  function writeConfig(cfg: Record<string, unknown>) {
    writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n");
  }

  app.get("/channels", (c) => {
    const cfg = readConfig();
    const channels = (cfg.channels ?? {}) as Record<string, unknown>;
    const status = channelManager.status();
    const merged: Record<string, unknown> = {};
    for (const [id, config] of Object.entries(channels)) {
      merged[id] = { ...(config as Record<string, unknown>), status: status[id] ?? "not configured" };
    }
    return c.json(merged);
  });

  app.put("/channels/:id", async (c) => {
    const channelId = c.req.param("id");
    const body = await c.req.json<Record<string, unknown>>();
    const cfg = readConfig();
    const channels = (cfg.channels ?? {}) as Record<string, Record<string, unknown>>;
    channels[channelId] = { ...channels[channelId], ...body };
    cfg.channels = channels;
    writeConfig(cfg);
    return c.json({ ok: true });
  });

  app.get("/agent", (c) => {
    const cfg = readConfig();
    const handlePath = join(homePath, "system/handle.json");
    let handle = {};
    try {
      if (existsSync(handlePath)) {
        handle = JSON.parse(readFileSync(handlePath, "utf-8"));
      }
    } catch { /* skip */ }
    return c.json({ identity: handle, kernel: cfg.kernel ?? {} });
  });

  app.get("/skills", (c) => {
    const skillsDir = join(homePath, "agents/skills");
    if (!existsSync(skillsDir)) return c.json([]);
    const { readdirSync } = require("node:fs");
    const files = readdirSync(skillsDir).filter((f: string) => f.endsWith(".md"));
    const skills = files.map((f: string) => {
      const content = readFileSync(join(skillsDir, f), "utf-8");
      const name = f.replace(".md", "");
      const descMatch = content.match(/description:\s*(.+)/);
      return {
        name,
        file: f,
        description: descMatch?.[1]?.trim(),
        enabled: true,
      };
    });
    return c.json(skills);
  });

  return app;
}
