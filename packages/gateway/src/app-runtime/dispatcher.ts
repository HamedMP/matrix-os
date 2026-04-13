import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { resolveWithinHome } from "../path-security.js";
import { SAFE_SLUG } from "./manifest-schema.js";
import { loadManifest } from "./manifest-loader.js";
import { serveStaticFileWithin } from "./serve-static.js";

const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 MB

/**
 * App runtime dispatcher: single Hono handler for /apps/:slug/*
 *
 * Dispatches to the correct serving branch based on manifest.runtime:
 * - static: serves files from ~/apps/{slug}/
 * - vite: serves files from ~/apps/{slug}/dist/
 * - node: (Phase 2) reverse-proxies to running child process
 *
 * Design note: the node branch will be added by the node-proc agent
 * as a new case in the switch statement below.
 */
export function createAppDispatcher(homeDir: string) {
  const app = new Hono();

  app.use("*", bodyLimit({ maxSize: MAX_BODY_SIZE }));

  app.all("*", async (c) => {
    const slug = c.req.param("slug");
    if (!slug || !SAFE_SLUG.test(slug)) {
      return c.json({ error: "invalid slug" }, 400);
    }

    // Check for WebSocket upgrade
    const upgradeHeader = c.req.header("upgrade");
    if (upgradeHeader?.toLowerCase() === "websocket") {
      // node mode will handle WebSocket upgrades in Phase 2
      // static and vite modes reject WebSocket
      return c.json({ error: "ws_not_supported" }, 400);
    }

    const appsDir = join(homeDir, "apps");
    const result = await loadManifest(appsDir, slug);
    if (!result.ok) {
      if (result.error.code === "not_found") {
        return c.json({ error: "not found" }, 404);
      }
      return c.json({ error: "manifest error" }, 500);
    }

    const manifest = result.manifest;

    // Extract the sub-path after /apps/:slug/
    const fullPath = c.req.path;
    const prefixLen = `/apps/${slug}`.length;
    const subPath = fullPath.slice(prefixLen) || "/";

    switch (manifest.runtime) {
      case "static": {
        const appDir = resolveWithinHome(appsDir, slug);
        if (!appDir) {
          return c.json({ error: "invalid path" }, 400);
        }
        return serveStaticFileWithin(appDir, subPath, c);
      }

      case "vite": {
        const appDir = resolveWithinHome(appsDir, slug);
        if (!appDir) {
          return c.json({ error: "invalid path" }, 400);
        }
        const distDir = join(appDir, "dist");
        if (!existsSync(distDir)) {
          return c.json({ error: "needs_build", status: "needs_build" }, 503);
        }
        return serveStaticFileWithin(distDir, subPath, c);
      }

      case "node": {
        // Phase 2: the node-proc agent will add reverse-proxy logic here.
        // For now, return 503 as the process manager is not yet implemented.
        return c.json(
          { error: "node runtime not yet available", status: "not_implemented" },
          503,
        );
      }

      default: {
        return c.json({ error: "unknown runtime" }, 500);
      }
    }
  });

  return app;
}
