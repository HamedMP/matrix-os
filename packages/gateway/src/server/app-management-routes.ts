/** App catalog, app operations, and icon routes from gateway composition. */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createImageClient, loadIconStyle, buildIconPrompt, generateIconBatch } from "@matrix-os/kernel";
import { listApps } from "../apps.js";
import { renameApp, deleteApp } from "../app-ops.js";
import { buildShellBootstrap } from "../shell-bootstrap.js";
import { registerIconRoutes } from "../icon-routes.js";
import { resolveDefaultAppIconUrl, resolveSystemIconUrl } from "../default-icons.js";

const SAFE_ICON_STEM = /^[a-zA-Z0-9_-]+$/;
function isSafeIconStem(value: unknown): value is string {
  return typeof value === "string" && SAFE_ICON_STEM.test(value);
}

export function registerAppManagementRoutes(app: Hono, options: { homePath: string }): void {
  const { homePath } = options;
  const renameAppBodyLimit = bodyLimit({ maxSize: 4096 });
  const deleteAppBodyLimit = bodyLimit({ maxSize: 4096 });
  const appIconBodyLimit = bodyLimit({ maxSize: 4096 });
  let iconRegenerationInProgress = false;
  app.get("/api/apps", async (c) => {
    return c.json(await listApps(homePath));
  });

  app.get("/api/shell/bootstrap", async (c) => {
    return c.json(await buildShellBootstrap(homePath));
  });

  registerIconRoutes(app, homePath);

  app.put("/api/apps/:slug/rename", renameAppBodyLimit, async (c) => {
    const slug = c.req.param("slug");
    const { name } = await c.req.json<{ name: string }>();
    const result = renameApp(homePath, slug, name);
    if (!result.success) {
      const status = result.error?.includes("not found") ? 404 : 400;
      return c.json({ error: result.error }, status);
    }
    return c.json({ ok: true, newSlug: result.newSlug });
  });

  app.delete("/api/apps/:slug", deleteAppBodyLimit, async (c) => {
    const slug = c.req.param("slug");
    const result = deleteApp(homePath, slug);
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
    const shippedDefaultIcon = await resolveDefaultAppIconUrl(homePath, slug);
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
        iconUrl: (await resolveSystemIconUrl(homePath, `${slug}.png`)) ?? "/files/system/icons/game.svg",
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

      const iconStyle = body.style || loadIconStyle(homePath);
      const client = createImageClient(geminiKey);
      const apps = await listApps(homePath);
      const targetApp = apps.find((appEntry) => appEntry.slug === slug);
      const iconStem = isSafeIconStem(targetApp?.icon) ? targetApp.icon : slug;
      const prompt = buildIconPrompt(targetApp?.name ?? slug, iconStyle);
      const iconsDir = join(homePath, "system/icons");
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

    const iconsDir = join(homePath, "system/icons");
    if (!existsSync(iconsDir)) {
      iconRegenerationInProgress = false;
      return c.json({ regenerated: 0, failed: [] });
    }

    const apps = await listApps(homePath);
    const iconTargets = apps.flatMap((appEntry) => appEntry.slug ? [{
        slug: appEntry.slug,
        icon: isSafeIconStem(appEntry.icon) ? appEntry.icon : appEntry.slug,
        name: appEntry.name,
      }] : []);

    generateIconBatch(geminiKey, iconTargets, loadIconStyle(homePath), iconsDir)
      .then((r) => console.log(`[icons] Regeneration complete: ${r.generated}/${iconTargets.length} succeeded, ${r.failed.length} failed`))
      .catch((err) => console.error("[icons] Regeneration error:", err))
      .finally(() => { iconRegenerationInProgress = false; });
    return c.json({ accepted: true, total: iconTargets.length }, 202);
  });

}
