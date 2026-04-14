import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolveWithinHome } from "../path-security.js";
import { SAFE_SLUG } from "./manifest-schema.js";
import { loadManifest } from "./manifest-loader.js";
import { serveStaticFileWithin } from "./serve-static.js";
import type { ProcessManager } from "./process-manager.js";

const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 MB
const BACKEND_TIMEOUT_MS = 30_000;

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailers", "transfer-encoding", "upgrade",
]);

// Client-controlled forwarded headers MUST NOT be trusted. We strip every
// inbound occurrence and rewrite canonical values from gateway config before
// forwarding upstream.
const CLIENT_CONTROLLED_FORWARDED = new Set([
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-real-ip",
  "x-matrix-app-slug",
]);

const STRIPPED_RESPONSE = new Set(["server", "x-powered-by"]);

export interface DispatcherConfig {
  publicHost?: string;
  processManager?: ProcessManager;
}

/**
 * App runtime dispatcher: single Hono handler for /apps/:slug/*
 *
 * Dispatches to the correct serving branch based on manifest.runtime:
 * - static: serves files from ~/apps/{slug}/
 * - vite: serves files from ~/apps/{slug}/dist/
 * - node: reverse-proxies HTTP to running child process
 */
export function createAppDispatcher(homeDir: string, config?: DispatcherConfig) {
  const app = new Hono();
  const pm = config?.processManager;
  const publicHost = config?.publicHost ?? "localhost";

  app.use("*", bodyLimit({ maxSize: MAX_BODY_SIZE }));

  app.all("*", async (c) => {
    const slug = c.req.param("slug");
    if (!slug || !SAFE_SLUG.test(slug)) {
      return c.json({ error: "invalid slug" }, 400);
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

    // Check for WebSocket upgrade
    const upgradeHeader = c.req.header("upgrade");
    if (upgradeHeader?.toLowerCase() === "websocket") {
      // Only node mode handles WebSocket upgrades
      if (manifest.runtime !== "node") {
        return c.json({ error: "ws_not_supported" }, 400);
      }
      // WebSocket upgrade for node mode would go here (T065)
      // For now, the actual WS piping requires @hono/node-ws runtime
      return c.json({ error: "ws_not_supported" }, 400);
    }

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
        return dispatchNode(c, slug, subPath, pm, publicHost);
      }

      default: {
        return c.json({ error: "unknown runtime" }, 500);
      }
    }
  });

  return app;
}

async function dispatchNode(
  c: import("hono").Context,
  slug: string,
  subPath: string,
  pm: ProcessManager | undefined,
  publicHost: string,
): Promise<Response> {
  const correlationId = randomUUID();

  if (!pm) {
    return c.json(
      { error: "node runtime not available", correlationId },
      503,
    );
  }

  let record;
  try {
    record = await pm.ensureRunning(slug);
  } catch (err: unknown) {
    return c.json(
      { error: "app failed to start", correlationId },
      503,
    );
  }

  // Build the upstream URL, including query string
  const reqUrl = new URL(c.req.url);
  const search = reqUrl.search;
  const upstreamUrl = `http://127.0.0.1:${record.port}${subPath}${search}`;

  // Sanitize request headers
  const reqHeaders = new Headers(c.req.raw.headers);
  for (const h of HOP_BY_HOP) reqHeaders.delete(h);
  for (const h of CLIENT_CONTROLLED_FORWARDED) reqHeaders.delete(h);

  // Set canonical forwarded headers
  reqHeaders.set("X-Forwarded-Host", publicHost);
  reqHeaders.set("X-Forwarded-Proto", "https");
  reqHeaders.set("X-Forwarded-Prefix", `/apps/${slug}`);
  reqHeaders.set("X-Matrix-App-Slug", slug);

  try {
    const upstream = await fetch(upstreamUrl, {
      method: c.req.method,
      headers: reqHeaders,
      body: c.req.method !== "GET" && c.req.method !== "HEAD" ? c.req.raw.body : undefined,
      signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
      // @ts-expect-error duplex for streaming body
      duplex: "half",
    });

    pm.markUsed(slug);

    // Sanitize response headers
    const resHeaders = new Headers(upstream.headers);
    for (const h of HOP_BY_HOP) resHeaders.delete(h);
    for (const h of STRIPPED_RESPONSE) resHeaders.delete(h);

    return new Response(upstream.body, {
      status: upstream.status,
      headers: resHeaders,
    });
  } catch (err: unknown) {
    const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
    return c.json(
      { error: "upstream error", correlationId },
      isTimeout ? 504 : 502,
    );
  }
}
