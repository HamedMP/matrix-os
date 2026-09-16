/**
 * Tasks / apps / icons routes (extracted from server.ts, Phase 1-A1.2).
 *
 * Pure move: handler bodies are byte-identical to the inline versions.
 * Owns task CRUD, app listing/management, shell bootstrap, and icon
 * generation. Task and app helpers are imported directly (pure functions);
 * only gateway-owned runtime state arrives via deps.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createImageClient, loadIconStyle, buildIconPrompt, generateIconBatch, createTask, listTasks, getTask } from "@matrix-os/kernel";
import { resolveDefaultAppIconUrl, resolveSystemIconUrl } from "../domains/apps/default-icons.js";
import { registerIconRoutes } from "../domains/apps/icon-routes.js";
import { buildShellBootstrap } from "../domains/apps/shell-bootstrap.js";
import { listApps } from "../domains/apps/apps.js";
import { renameApp, deleteApp } from "../domains/apps/app-ops.js";
import { type Dispatcher } from "../domains/sessions/dispatcher.js";
import type { ServerMessage } from "../server/types.js";

const TASK_BODY_LIMIT = 64 * 1024; // 64 KiB
const RENAME_APP_BODY_LIMIT = 4096; // 4 KiB
const APP_ICON_BODY_LIMIT = 4096; // 4 KiB

export interface TasksAppsRouteDeps {
  dispatcher: Dispatcher;
  broadcast: (msg: ServerMessage) => void;
  homePath: string;
}

const SAFE_ICON_STEM = /^[a-zA-Z0-9_-]+$/;

function isSafeIconStem(value: unknown): value is string {
  return typeof value === "string" && SAFE_ICON_STEM.test(value);
}

export function createTasksAppsRoutes(deps: TasksAppsRouteDeps): Hono {
  const app = new Hono();
  const taskBodyLimit = bodyLimit({ maxSize: TASK_BODY_LIMIT });
  const renameAppBodyLimit = bodyLimit({ maxSize: RENAME_APP_BODY_LIMIT });
  const appIconBodyLimit = bodyLimit({ maxSize: APP_ICON_BODY_LIMIT });
  let iconRegenerationInProgress = false;

  app.get("/api/tasks", (c) => {
    const status = c.req.query("status");
    const tasks = listTasks(deps.dispatcher.db, status ? { status } : undefined);
    return c.json(tasks);
  });

  app.post("/api/tasks", taskBodyLimit, async (c) => {
    const body = await c.req.json<{ type?: string; input: string; priority?: number }>();
    if (!body.input || typeof body.input !== "string") {
      return c.json({ error: "input is required" }, 400);
    }
    const id = createTask(deps.dispatcher.db, {
      type: body.type ?? "todo",
      input: body.input,
      priority: body.priority,
    });
    const task = getTask(deps.dispatcher.db, id);
    deps.broadcast({
      type: "task:created",
      task: { id, type: body.type ?? "todo", status: "pending", input: body.input },
    });
    return c.json({ id, task }, 201);
  });

  app.get("/api/tasks/:id", (c) => {
    const task = getTask(deps.dispatcher.db, c.req.param("id"));
    if (!task) return c.json({ error: "Not found" }, 404);
    return c.json(task);
  });

  app.get("/api/apps", async (c) => {
    return c.json(await listApps(deps.homePath));
  });

  app.get("/api/shell/bootstrap", async (c) => {
    return c.json(await buildShellBootstrap(deps.homePath));
  });

  registerIconRoutes(app, deps.homePath);

  app.put("/api/apps/:slug/rename", renameAppBodyLimit, async (c) => {
    const slug = c.req.param("slug");
    const { name } = await c.req.json<{ name: string }>();
    const result = renameApp(deps.homePath, slug, name);
    if (!result.success) {
      const status = result.error?.includes("not found") ? 404 : 400;
      return c.json({ error: result.error }, status);
    }
    return c.json({ ok: true, newSlug: result.newSlug });
  });

  app.delete("/api/apps/:slug", async (c) => {
    const slug = c.req.param("slug");
    const result = deleteApp(deps.homePath, slug);
    if (!result.success) {
      const status = result.error?.includes("not found") ? 404 : 400;
      return c.json({ error: result.error }, status);
    }
    return c.json({ ok: true });
  });

  app.post("/api/apps/:slug/icon", appIconBodyLimit, async (c) => {
    const slug = c.req.param("slug");
    if (!/^[a-zA-Z0-9_-]+$/.test(slug)) {
      return c.json({ error: "Invalid slug" }, 400);
    }
    const shippedDefaultIcon = await resolveDefaultAppIconUrl(deps.homePath, slug);
    if (shippedDefaultIcon) {
      return c.json({
        iconUrl: shippedDefaultIcon,
        generated: false,
        shipped: true,
      });
    }
    const geminiKey = process.env.GEMINI_API_KEY ?? "";
    if (!geminiKey) {
      return c.json({
        iconUrl: (await resolveSystemIconUrl(deps.homePath, `${slug}.png`)) ?? "/files/system/icons/game.svg",
        generated: false,
      });
    }
    try {
      let body: { style?: string } = {};
      try {
        body = await c.req.json();
      } catch (err: unknown) {
        if (!(err instanceof SyntaxError)) {
          console.error("[gateway] Failed to parse icon generation body:", err);
          return c.json({ error: "Failed to read request body" }, 500);
        }
      }

      const iconStyle = body.style || loadIconStyle(deps.homePath);
      const client = createImageClient(geminiKey);
      const apps = await listApps(deps.homePath);
      const targetApp = apps.find((appEntry) => appEntry.slug === slug);
      const iconStem = isSafeIconStem(targetApp?.icon) ? targetApp.icon : slug;
      const prompt = buildIconPrompt(targetApp?.name ?? slug, iconStyle);
      const iconsDir = join(deps.homePath, "system/icons");
      const result = await client.generateImage(prompt, {
        aspectRatio: "1:1",
        imageDir: iconsDir,
        saveAs: `${iconStem}.png`,
      });
      const iconPath = join(iconsDir, `${iconStem}.png`);
      const stat = statSync(iconPath);
      const etag = `"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`;
      c.header("ETag", etag);
      return c.json({
        iconUrl: `/files/system/icons/${iconStem}.png`,
        etag,
        cost: result.cost,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error(`Icon generation failed for "${slug}":`, message);
      return c.json({ error: "Icon generation failed" }, 500);
    }
  });

  app.post("/api/icons/regenerate-all", appIconBodyLimit, async (c) => {
    if (iconRegenerationInProgress) {
      return c.json({ error: "Regeneration already in progress" }, 409);
    }
    iconRegenerationInProgress = true;

    const geminiKey = process.env.GEMINI_API_KEY ?? "";
    if (!geminiKey) {
      iconRegenerationInProgress = false;
      return c.json({ regenerated: 0, failed: [], generated: false });
    }

    const iconsDir = join(deps.homePath, "system/icons");
    if (!existsSync(iconsDir)) {
      iconRegenerationInProgress = false;
      return c.json({ regenerated: 0, failed: [] });
    }

    const apps = await listApps(deps.homePath);
    const iconTargets = apps.flatMap((appEntry) => appEntry.slug ? [{
        slug: appEntry.slug,
        icon: isSafeIconStem(appEntry.icon) ? appEntry.icon : appEntry.slug,
        name: appEntry.name,
      }] : []);

    generateIconBatch(geminiKey, iconTargets, loadIconStyle(deps.homePath), iconsDir)
      .then((r) => console.log(`[icons] Regeneration complete: ${r.generated}/${iconTargets.length} succeeded, ${r.failed.length} failed`))
      .catch((err) => console.error("[icons] Regeneration error:", err))
      .finally(() => { iconRegenerationInProgress = false; });
    return c.json({ accepted: true, total: iconTargets.length }, 202);
  });

  return app;
}
