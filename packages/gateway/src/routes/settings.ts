import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import type { ChannelManager } from "../channels/manager.js";
import type { ChannelConfig, ChannelId } from "../channels/types.js";
import { validateApiKeyFormat, validateApiKeyLive, storeApiKey, hasApiKey } from "../onboarding/api-key.js";

const DESKTOP_DEFAULTS = {
  background: { type: "wallpaper", name: "moraine-lake.jpg" },
  dock: { position: "left", size: 56, iconSize: 40, autoHide: false },
  pinnedApps: [] as string[],
  iconStyle: "Realistic 3D rendered app icon, soft gradient background, subtle drop shadow, rounded square shape, Apple macOS style",
};

const THEME_DEFAULTS = {};
const SETTINGS_BODY_LIMIT = 256 * 1024;
const CHANNEL_IDS = new Set<ChannelId>([
  "telegram",
  "whatsapp",
  "discord",
  "slack",
  "push",
  "voice",
]);

function isValidFilename(name: string): boolean {
  return /^[a-zA-Z0-9_.-]+$/.test(name) && !name.includes("..");
}

function isValidChannelId(channelId: string): channelId is ChannelId {
  return CHANNEL_IDS.has(channelId as ChannelId);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(path: string, fallback: T, label: string): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[settings] Failed to read ${label}:`, err);
    }
    return fallback;
  }
}

async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, JSON.stringify(data, null, 2) + "\n");
  await rename(tempPath, path);
}

export function createSettingsRoutes(opts: {
  homePath: string;
  channelManager: ChannelManager;
}) {
  const { homePath, channelManager } = opts;
  const app = new Hono();
  const configPath = join(homePath, "system/config.json");

  async function readConfig(): Promise<Record<string, unknown>> {
    return readJson(configPath, {}, "config");
  }

  app.get("/channels", async (c) => {
    const cfg = await readConfig();
    const channels = (cfg.channels ?? {}) as Record<string, unknown>;
    const status = channelManager.status();
    const merged: Record<string, unknown> = {};
    for (const [id, config] of Object.entries(channels)) {
      merged[id] = { ...(config as Record<string, unknown>), status: status[id] ?? "not configured" };
    }
    return c.json(merged);
  });

  app.put("/channels/:id", bodyLimit({ maxSize: SETTINGS_BODY_LIMIT }), async (c) => {
    const channelId = c.req.param("id");
    if (!isValidChannelId(channelId)) {
      return c.json({ error: "Invalid channel id" }, 400);
    }

    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const cfg = await readConfig();
    const channels = (cfg.channels ?? {}) as Record<string, Record<string, unknown>>;
    channels[channelId] = { ...channels[channelId], ...body };
    cfg.channels = channels;
    await writeJsonAtomic(configPath, cfg);

    const channelCfg = channels[channelId] as unknown as ChannelConfig;
    try {
      await channelManager.restartChannel(channelId, channelCfg);
    } catch (err) {
      console.warn(`[settings] Failed to restart channel ${channelId}:`, err);
      return c.json({ error: "Failed to restart channel" }, 500);
    }

    const status = channelManager.status();
    return c.json({ ok: true, status: status[channelId] ?? "not configured" });
  });

  app.get("/agent", async (c) => {
    const cfg = await readConfig();
    const handlePath = join(homePath, "system/handle.json");
    const handle = await readJson(handlePath, {}, "handle");
    return c.json({ identity: handle, kernel: cfg.kernel ?? {} });
  });

  app.get("/skills", async (c) => {
    const skillsDir = join(homePath, "agents/skills");
    if (!(await fileExists(skillsDir))) return c.json([]);
    const files = (await readdir(skillsDir)).filter((f: string) => f.endsWith(".md"));
    const skills = await Promise.all(files.map(async (f: string) => {
      const content = await readFile(join(skillsDir, f), "utf-8");
      const name = f.replace(".md", "");
      const descMatch = content.match(/description:\s*(.+)/);
      return {
        name,
        file: f,
        description: descMatch?.[1]?.trim(),
        enabled: true,
      };
    }));
    return c.json(skills);
  });

  // --- Desktop config ---

  const desktopPath = join(homePath, "system/desktop.json");

  app.get("/desktop", async (c) => {
    return c.json(await readJson(desktopPath, DESKTOP_DEFAULTS, "desktop config"));
  });

  app.put("/desktop", bodyLimit({ maxSize: SETTINGS_BODY_LIMIT }), async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    await writeJsonAtomic(desktopPath, body);
    return c.json({ ok: true });
  });

  // --- Theme config ---

  const themePath = join(homePath, "system/theme.json");

  app.get("/theme", async (c) => {
    return c.json(await readJson(themePath, THEME_DEFAULTS, "theme config"));
  });

  app.put("/theme", bodyLimit({ maxSize: SETTINGS_BODY_LIMIT }), async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    await writeJsonAtomic(themePath, body);
    return c.json({ ok: true });
  });

  // --- Wallpapers ---

  const wallpapersDir = join(homePath, "system/wallpapers");

  app.get("/wallpapers", async (c) => {
    if (!(await fileExists(wallpapersDir))) return c.json({ wallpapers: [] });
    const files = await readdir(wallpapersDir);
    return c.json({ wallpapers: files });
  });

  app.post("/wallpaper", bodyLimit({ maxSize: 10 * 1024 * 1024 }), async (c) => {
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
    await mkdir(wallpapersDir, { recursive: true });
    const filePath = join(wallpapersDir, body.name);
    // Strip data URL prefix (e.g. "data:image/png;base64,") if present
    const raw = body.data.includes(",") ? body.data.split(",")[1] : body.data;
    await writeFile(filePath, Buffer.from(raw, "base64"));
    return c.json({ ok: true });
  });

  app.delete("/wallpaper/:name", async (c) => {
    const name = c.req.param("name");
    if (!isValidFilename(name)) {
      return c.json({ error: "Invalid filename" }, 400);
    }
    const filePath = join(wallpapersDir, name);
    if (!(await fileExists(filePath))) {
      return c.json({ error: "Not found" }, 404);
    }
    await unlink(filePath);
    return c.json({ ok: true });
  });

  // --- API Key ---

  app.get("/api-key/status", async (c) => {
    const hasKey = await hasApiKey(homePath);
    return c.json({ hasKey });
  });

  app.post("/api-key", bodyLimit({ maxSize: SETTINGS_BODY_LIMIT }), async (c) => {
    let body: { apiKey: string };
    try {
      body = await c.req.json<{ apiKey: string }>();
    } catch {
      return c.json({ valid: false, error: "Invalid request" }, 400);
    }

    if (!body.apiKey) {
      return c.json({ valid: false, error: "API key is required" }, 400);
    }

    const formatResult = validateApiKeyFormat(body.apiKey);
    if (!formatResult.valid) {
      return c.json(formatResult, 400);
    }

    const liveResult = await validateApiKeyLive(body.apiKey);
    if (!liveResult.valid) {
      return c.json(liveResult, 400);
    }

    await storeApiKey(homePath, body.apiKey);
    return c.json({ valid: true });
  });

  return app;
}
