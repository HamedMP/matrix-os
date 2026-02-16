import { Hono } from "hono";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { ChannelManager } from "../channels/manager.js";
import type { ChannelConfig, ChannelId } from "../channels/types.js";

const DESKTOP_DEFAULTS = {
  background: { type: "pattern" },
  dock: { position: "left", size: 56, iconSize: 40, autoHide: false },
  pinnedApps: [] as string[],
  iconStyle: "3D rendered glossy icon, dark background, vibrant glowing neon accents, soft lighting, rounded square shape",
};

const THEME_DEFAULTS = {};

function isValidFilename(name: string): boolean {
  return /^[a-zA-Z0-9_.-]+$/.test(name) && !name.includes("..");
}

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
    const channelId = c.req.param("id") as ChannelId;
    const body = await c.req.json<Record<string, unknown>>();
    const cfg = readConfig();
    const channels = (cfg.channels ?? {}) as Record<string, Record<string, unknown>>;
    channels[channelId] = { ...channels[channelId], ...body };
    cfg.channels = channels;
    writeConfig(cfg);

    const channelCfg = channels[channelId] as unknown as ChannelConfig;
    try {
      await channelManager.restartChannel(channelId, channelCfg);
    } catch { /* status will show error */ }

    const status = channelManager.status();
    return c.json({ ok: true, status: status[channelId] ?? "not configured" });
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

  // --- Desktop config ---

  const desktopPath = join(homePath, "system/desktop.json");

  app.get("/desktop", (c) => {
    try {
      if (existsSync(desktopPath)) {
        return c.json(JSON.parse(readFileSync(desktopPath, "utf-8")));
      }
    } catch { /* fallback to defaults */ }
    return c.json(DESKTOP_DEFAULTS);
  });

  app.put("/desktop", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    writeFileSync(desktopPath, JSON.stringify(body, null, 2) + "\n");
    return c.json({ ok: true });
  });

  // --- Theme config ---

  const themePath = join(homePath, "system/theme.json");

  app.get("/theme", (c) => {
    try {
      if (existsSync(themePath)) {
        return c.json(JSON.parse(readFileSync(themePath, "utf-8")));
      }
    } catch { /* fallback to defaults */ }
    return c.json(THEME_DEFAULTS);
  });

  app.put("/theme", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    writeFileSync(themePath, JSON.stringify(body, null, 2) + "\n");
    return c.json({ ok: true });
  });

  // --- Wallpapers ---

  const wallpapersDir = join(homePath, "system/wallpapers");

  app.get("/wallpapers", (c) => {
    if (!existsSync(wallpapersDir)) return c.json([]);
    const files = readdirSync(wallpapersDir);
    return c.json(
      files.map((name) => ({
        name,
        url: `/files/system/wallpapers/${name}`,
      })),
    );
  });

  app.post("/wallpaper", async (c) => {
    let body: { name: string; data: string };
    try {
      body = await c.req.json<{ name: string; data: string }>();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    if (!body.name || !body.data) {
      return c.json({ error: "name and data are required" }, 400);
    }
    if (!isValidFilename(body.name)) {
      return c.json({ error: "Invalid filename" }, 400);
    }
    mkdirSync(wallpapersDir, { recursive: true });
    const filePath = join(wallpapersDir, body.name);
    writeFileSync(filePath, Buffer.from(body.data, "base64"));
    return c.json({ ok: true });
  });

  app.delete("/wallpaper/:name", (c) => {
    const name = c.req.param("name");
    if (!isValidFilename(name)) {
      return c.json({ error: "Invalid filename" }, 400);
    }
    const filePath = join(wallpapersDir, name);
    if (!existsSync(filePath)) {
      return c.json({ error: "Not found" }, 404);
    }
    unlinkSync(filePath);
    return c.json({ ok: true });
  });

  return app;
}
