import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, relative, join } from "node:path";
import { DEFAULT_ICON_STYLE, loadSkills } from "@matrix-os/kernel";
import type { ChannelManager } from "../channels/manager.js";
import type { ChannelConfig, ChannelId } from "../channels/types.js";
import { validateApiKeyFormat, validateApiKeyLive, storeApiKey, hasApiKey } from "../onboarding/api-key.js";
import { buildAgentProfileSummary } from "../agent-profile-summary.js";
import {
  KERNEL_DEFAULTS,
  KERNEL_EFFORTS,
  KERNEL_MODELS,
  KernelEffortSchema,
  KernelModelSchema,
  normalizeKernelEffort,
  normalizeKernelModel,
} from "../kernel-settings.js";

const DESKTOP_DEFAULTS = {
  background: { type: "wallpaper", name: "moraine-lake.jpg" },
  dock: { position: "left", size: 56, iconSize: 40, autoHide: false },
  pinnedApps: ["__workspace__", "__terminal__", "__file-browser__", "__chat__"] as string[],
  iconStyle: DEFAULT_ICON_STYLE,
};

const THEME_DEFAULTS = {};
const SETTINGS_BODY_LIMIT = 256 * 1024;

const KernelPatchSchema = z
  .object({
    model: KernelModelSchema.optional(),
    effort: KernelEffortSchema.optional(),
  })
  .strict();

const WALLPAPER_FILE_EXTENSIONS = new Set([
  ".avif",
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp",
]);
const CHANNEL_IDS = new Set<ChannelId>([
  "telegram",
  "whatsapp",
  "discord",
  "slack",
  "push",
  "voice",
]);
const CHANNEL_SECRET_KEYS = new Set([
  "token",
  "botToken",
  "appToken",
  "signingSecret",
  "webhookSecret",
  "secret",
  "apiKey",
  "password",
]);

function isValidFilename(name: string): boolean {
  return /^[a-zA-Z0-9_.-]+$/.test(name) && !name.includes("..");
}

function hasSupportedWallpaperExtension(name: string): boolean {
  return (
    !name.startsWith(".") &&
    WALLPAPER_FILE_EXTENSIONS.has(extname(name).toLowerCase())
  );
}

function isVisibleWallpaperFile(entry: { name: string; isFile(): boolean }): boolean {
  return (
    entry.isFile() &&
    hasSupportedWallpaperExtension(entry.name)
  );
}

function isValidChannelId(channelId: string): channelId is ChannelId {
  return CHANNEL_IDS.has(channelId as ChannelId);
}

function redactChannelConfig(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((child) => redactChannelConfig(child));

  const redacted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (CHANNEL_SECRET_KEYS.has(key)) {
      redacted[key] = child == null ? child : "[redacted]";
    } else if (child && typeof child === "object") {
      redacted[key] = redactChannelConfig(child);
    } else {
      redacted[key] = child;
    }
  }
  return redacted;
}

function containsChannelSecretUpdate(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((child) => containsChannelSecretUpdate(child));

  return Object.entries(value as Record<string, unknown>).some(([key, child]) => (
    CHANNEL_SECRET_KEYS.has(key) || containsChannelSecretUpdate(child)
  ));
}

function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (err) {
    if (!isNotFoundError(err)) {
      console.warn("[settings] Failed to check file existence:", err);
    }
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

function mergeDesktopDefaults(config: Record<string, unknown>): Record<string, unknown> {
  const dock = typeof config.dock === "object" && config.dock !== null ? config.dock : {};
  return {
    ...DESKTOP_DEFAULTS,
    ...config,
    dock: { ...DESKTOP_DEFAULTS.dock, ...dock },
  };
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
      merged[id] = {
        ...(redactChannelConfig(config) as Record<string, unknown>),
        status: status[id] ?? "not configured",
      };
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
    } catch (err) {
      if (!(err instanceof SyntaxError)) {
        console.warn("[settings] Failed to parse channel config request:", err);
      }
      return c.json({ error: "Invalid JSON" }, 400);
    }
    if (containsChannelSecretUpdate(body)) {
      return c.json({ error: "Secret fields cannot be updated here" }, 400);
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
    const kernel = (cfg.kernel ?? {}) as Record<string, unknown>;
    return c.json({
      identity: handle,
      kernel: {
        model: normalizeKernelModel(kernel.model),
        effort: normalizeKernelEffort(kernel.effort),
      },
      availableModels: KERNEL_MODELS,
      availableEfforts: KERNEL_EFFORTS,
      defaults: KERNEL_DEFAULTS,
    });
  });

  app.get("/agent/summary", async (c) => {
    try {
      return c.json(await buildAgentProfileSummary(homePath));
    } catch (err) {
      console.warn("[settings] Failed to build agent summary:", err);
      return c.json({ error: "Agent summary unavailable" }, 500);
    }
  });

  app.put("/agent", bodyLimit({ maxSize: SETTINGS_BODY_LIMIT }), async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch (err) {
      if (!(err instanceof SyntaxError)) {
        console.warn("[settings] Failed to parse agent config request:", err);
      }
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const parsed = KernelPatchSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "Invalid kernel settings" }, 400);
    }
    const cfg = await readConfig();
    const kernel = { ...((cfg.kernel ?? {}) as Record<string, unknown>) };
    if (parsed.data.model !== undefined) kernel.model = parsed.data.model;
    if (parsed.data.effort !== undefined) kernel.effort = parsed.data.effort;
    cfg.kernel = kernel;
    await writeJsonAtomic(configPath, cfg);
    return c.json({
      ok: true,
      kernel: {
        model: normalizeKernelModel(kernel.model),
        effort: normalizeKernelEffort(kernel.effort),
      },
    });
  });

  app.get("/skills", async (c) => {
    const skills = loadSkills(homePath).map((skill) => ({
      name: skill.name,
      file: relative(homePath, skill.sourcePath),
      description: skill.description,
      enabled: true,
    }));
    return c.json(skills);
  });

  // --- Desktop config ---

  const desktopPath = join(homePath, "system/desktop.json");

  app.get("/desktop", async (c) => {
    const config = await readJson<Record<string, unknown>>(desktopPath, {}, "desktop config");
    return c.json(mergeDesktopDefaults(config));
  });

  app.put("/desktop", bodyLimit({ maxSize: SETTINGS_BODY_LIMIT }), async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch (err) {
      if (!(err instanceof SyntaxError)) {
        console.warn("[settings] Failed to parse desktop config request:", err);
      }
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
    } catch (err) {
      if (!(err instanceof SyntaxError)) {
        console.warn("[settings] Failed to parse theme config request:", err);
      }
      return c.json({ error: "Invalid JSON" }, 400);
    }
    await writeJsonAtomic(themePath, body);
    return c.json({ ok: true });
  });

  // --- Wallpapers ---

  const wallpapersDir = join(homePath, "system/wallpapers");

  app.get("/wallpapers", async (c) => {
    if (!(await fileExists(wallpapersDir))) return c.json({ wallpapers: [] });
    const files = await readdir(wallpapersDir, { withFileTypes: true });
    const wallpapers = files
      .filter(isVisibleWallpaperFile)
      .map((file) => file.name)
      .sort((a, b) => a.localeCompare(b));
    return c.json({ wallpapers });
  });

  app.post("/wallpaper", bodyLimit({ maxSize: 10 * 1024 * 1024 }), async (c) => {
    let body: { name: string; data: string };
    try {
      body = await c.req.json<{ name: string; data: string }>();
    } catch (err) {
      if (!(err instanceof SyntaxError)) {
        console.warn("[settings] Failed to parse wallpaper request:", err);
      }
      return c.json({ error: "Invalid JSON" }, 400);
    }
    if (!body.name || !body.data) {
      return c.json({ error: "name and data are required" }, 400);
    }
    if (!isValidFilename(body.name)) {
      return c.json({ error: "Invalid filename" }, 400);
    }
    if (!hasSupportedWallpaperExtension(body.name)) {
      return c.json({ error: "Unsupported wallpaper file type" }, 400);
    }
    await mkdir(wallpapersDir, { recursive: true });
    const filePath = join(wallpapersDir, body.name);
    // Strip data URL prefix (e.g. "data:image/png;base64,") if present
    const raw = body.data.includes(",") ? body.data.split(",")[1] : body.data;
    await writeFile(filePath, Buffer.from(raw, "base64"));
    return c.json({ ok: true });
  });

  app.delete("/wallpaper/:name", bodyLimit({ maxSize: SETTINGS_BODY_LIMIT }), async (c) => {
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

  app.get("/onboarding-status", async (c) => {
    try {
      await access(join(homePath, "system", "onboarding-complete.json"));
      return c.json({ complete: true });
    } catch (err) {
      if (!isNotFoundError(err)) {
        console.warn("[settings] Failed to check onboarding status:", err);
      }
      return c.json({ complete: false });
    }
  });

  app.post("/onboarding-complete", bodyLimit({ maxSize: SETTINGS_BODY_LIMIT }), async (c) => {
    const completePath = join(homePath, "system", "onboarding-complete.json");
    try {
      await mkdir(dirname(completePath), { recursive: true });
    } catch (err) {
      console.warn("[settings] Failed to create onboarding directory:", err);
      return c.json({ error: "Unable to update onboarding" }, 500);
    }
    try {
      await writeFile(completePath, JSON.stringify({ completedAt: new Date().toISOString(), source: "shell" }) + "\n", { flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        console.warn("[settings] Failed to mark onboarding complete:", err);
        return c.json({ error: "Unable to update onboarding" }, 500);
      }
    }
    return c.json({ ok: true, complete: true });
  });

  app.post("/onboarding-reset", bodyLimit({ maxSize: SETTINGS_BODY_LIMIT }), async (c) => {
    const completePath = join(homePath, "system", "onboarding-complete.json");
    try {
      await unlink(completePath);
    } catch (err) {
      if (!isNotFoundError(err)) {
        console.warn("[settings] Failed to reset onboarding:", err);
        return c.json({ error: "Unable to reset onboarding" }, 500);
      }
    }
    return c.json({ ok: true, complete: false });
  });

  app.post("/api-key", bodyLimit({ maxSize: SETTINGS_BODY_LIMIT }), async (c) => {
    let body: { apiKey: string };
    try {
      body = await c.req.json<{ apiKey: string }>();
    } catch (err) {
      if (!(err instanceof SyntaxError)) {
        console.warn("[settings] Failed to parse API key request:", err);
      }
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
