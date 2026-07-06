import { join } from "node:path";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  createAppDispatcher,
  appSessionMiddleware,
  resolveAppBySlug,
  loadManifest,
  computeDistributionStatus,
  sandboxCapabilities,
  computeRuntimeState,
  deriveAppSessionKey,
  signAppSession,
  buildSetCookie,
  AckStore,
  MobileAppSessionTokenStore,
  SAFE_SLUG,
  ProcessManager,
  PortPool,
} from "../app-runtime/index.js";

const APP_SESSION_BODY_LIMIT_BYTES = 4096;
const HANDLE_PATTERN = /^[a-z][a-z0-9-]{2,30}$/;

export interface AppRuntimeRouteDeps {
  homePath: string;
  appSessionMasterSecret: string;
  devAppAuthBypass: boolean;
  publicHost: string;
  onAppError: (event: { errorKind: string; appSlug?: string }) => void;
}

export function registerAppRuntimeRoutes(app: Hono, deps: AppRuntimeRouteDeps): ProcessManager {
  const {
    homePath,
    appSessionMasterSecret,
    devAppAuthBypass,
    publicHost,
    onAppError,
  } = deps;
  const ackStore = new AckStore();
  const mobileSessionTokens = new MobileAppSessionTokenStore({
    ttlMs: 60_000,
    maxEntries: 256,
  });
  const appSessionBodyLimit = bodyLimit({ maxSize: APP_SESSION_BODY_LIMIT_BYTES });

  app.get("/api/apps/:slug/manifest", async (c) => {
    const slug = c.req.param("slug");
    if (!SAFE_SLUG.test(slug)) {
      return c.json({ error: "invalid slug" }, 400);
    }
    const appsDir = join(homePath, "apps");
    const result = await loadManifest(appsDir, slug);
    if (!result.ok) {
      if (result.error.code === "not_found") return c.json({ error: "not found" }, 404);
      return c.json({ error: "internal" }, 500);
    }
    const resolved = await resolveAppBySlug(appsDir, slug);
    if (!resolved.ok) return c.json({ error: "internal" }, 500);
    const appDir = resolved.entry.appDir;
    const runtimeState = await computeRuntimeState(result.manifest, appDir);
    const distributionStatus = computeDistributionStatus(
      result.manifest.listingTrust,
      sandboxCapabilities(),
    );
    return c.json({ manifest: result.manifest, runtimeState, distributionStatus });
  });

  app.post("/api/apps/:slug/ack", appSessionBodyLimit, async (c) => {
    const slug = c.req.param("slug");
    if (!SAFE_SLUG.test(slug)) {
      return c.json({ error: "invalid slug" }, 400);
    }
    const appsDir = join(homePath, "apps");
    const result = await loadManifest(appsDir, slug);
    if (!result.ok) {
      if (result.error.code === "not_found") return c.json({ error: "not found" }, 404);
      return c.json({ error: "internal" }, 500);
    }
    const manifest = result.manifest;
    if (manifest.scope !== "personal") {
      return c.json({ error: "scope_mismatch" }, 409);
    }
    const distributionStatus = computeDistributionStatus(
      manifest.listingTrust,
      sandboxCapabilities(),
    );
    if (distributionStatus === "blocked") {
      return c.json({ error: "install_blocked_by_policy" }, 403);
    }
    if (distributionStatus === "installable") {
      return c.json({ error: "ack_not_applicable" }, 400);
    }
    const { ack, expiresAt } = ackStore.mint(slug, "gateway-owner");
    return c.json({ ack, expiresAt });
  });

  app.post("/api/apps/:slug/session", appSessionBodyLimit, async (c) => {
    const slug = c.req.param("slug");
    if (!SAFE_SLUG.test(slug)) {
      return c.json({ error: "invalid slug" }, 400);
    }
    const appsDir = join(homePath, "apps");
    const result = await loadManifest(appsDir, slug);
    if (!result.ok) {
      if (result.error.code === "not_found") return c.json({ error: "not found" }, 404);
      return c.json({ error: "internal" }, 500);
    }
    const manifest = result.manifest;
    if (manifest.scope !== "personal") {
      return c.json({ error: "scope_mismatch" }, 409);
    }
    const distributionStatus = computeDistributionStatus(
      manifest.listingTrust,
      sandboxCapabilities(),
    );
    if (distributionStatus === "blocked") {
      return c.json({ error: "install_blocked_by_policy" }, 403);
    }
    if (distributionStatus === "gated") {
      let body: { ack?: string } = {};
      try {
        body = await c.req.json();
      } catch (err) {
        if (!(err instanceof SyntaxError) && (err as { name?: string }).name !== "BodyLimitError") {
          throw err;
        }
      }
      if (!body.ack || !ackStore.peekAck(slug, "gateway-owner", body.ack)) {
        return c.json({ error: "install_gated" }, 409);
      }
    }
    const key = deriveAppSessionKey(appSessionMasterSecret, slug);
    const nowSec = Math.floor(Date.now() / 1000);
    const maxAge = 600;
    const payload = {
      v: 1 as const,
      slug,
      principal: "gateway-owner" as const,
      scope: "personal" as const,
      iat: nowSec,
      exp: nowSec + maxAge,
    };
    const token = signAppSession(key, payload);
    const cookie = buildSetCookie(slug, token, {
      maxAge,
      secure: c.req.url.startsWith("https"),
    });
    return c.json({ expiresAt: payload.exp * 1000 }, 200, {
      "Set-Cookie": cookie,
    });
  });

  app.post("/api/apps/:slug/session-token", appSessionBodyLimit, async (c) => {
    const slug = c.req.param("slug");
    if (!SAFE_SLUG.test(slug)) {
      return c.json({ error: "invalid slug" }, 400);
    }
    const appsDir = join(homePath, "apps");
    const result = await loadManifest(appsDir, slug);
    if (!result.ok) {
      if (result.error.code === "not_found") return c.json({ error: "not found" }, 404);
      return c.json({ error: "internal" }, 500);
    }
    const manifest = result.manifest;
    if (manifest.scope !== "personal") {
      return c.json({ error: "scope_mismatch" }, 409);
    }
    const distributionStatus = computeDistributionStatus(
      manifest.listingTrust,
      sandboxCapabilities(),
    );
    if (distributionStatus === "blocked") {
      return c.json({ error: "install_blocked_by_policy" }, 403);
    }
    if (distributionStatus === "gated") {
      let body: { ack?: string } = {};
      try {
        body = await c.req.json();
      } catch (err) {
        if (!(err instanceof SyntaxError) && (err as { name?: string }).name !== "BodyLimitError") {
          throw err;
        }
      }
      if (!body.ack || !ackStore.peekAck(slug, "gateway-owner", body.ack)) {
        return c.json({ error: "install_gated" }, 409);
      }
    }
    const routingHandle = process.env.MATRIX_HANDLE;
    const { token, expiresAt } = mobileSessionTokens.mint(slug, Date.now(), {
      routingKey: routingHandle && HANDLE_PATTERN.test(routingHandle) ? routingHandle : undefined,
    });
    return c.json({
      token,
      expiresAt,
      launchUrl: `/apps/${slug}/?session=${encodeURIComponent(token)}`,
    });
  });

  app.use("/apps/:slug/*", async (c, next) => {
    const slug = c.req.param("slug");
    if (!slug || !SAFE_SLUG.test(slug)) {
      return c.json({ error: "invalid slug" }, 400);
    }
    const url = new URL(c.req.url);
    const token = url.searchParams.get("session");
    if (!token) {
      await next();
      return;
    }
    if (!mobileSessionTokens.consume(slug, token)) {
      return c.html("<!doctype html><title>Session expired</title><p>Session expired.</p>", 401, {
        "Cache-Control": "no-store",
        "Content-Type": "text/html; charset=utf-8",
      });
    }

    const key = deriveAppSessionKey(appSessionMasterSecret, slug);
    const nowSec = Math.floor(Date.now() / 1000);
    const maxAge = 600;
    const payload = {
      v: 1 as const,
      slug,
      principal: "gateway-owner" as const,
      scope: "personal" as const,
      iat: nowSec,
      exp: nowSec + maxAge,
    };
    const cookie = buildSetCookie(slug, signAppSession(key, payload), {
      maxAge,
      secure: c.req.url.startsWith("https"),
    });
    url.searchParams.delete("session");
    const nextSearch = url.searchParams.toString();
    const location = `${url.pathname}${nextSearch ? `?${nextSearch}` : ""}${url.hash}`;
    return new Response(null, {
      status: 302,
      headers: {
        "Cache-Control": "no-store",
        "Location": location,
        "Set-Cookie": cookie,
      },
    });
  });

  if (!devAppAuthBypass) {
    app.use(
      "/apps/:slug/*",
      appSessionMiddleware((slug) =>
        deriveAppSessionKey(appSessionMasterSecret, slug),
      ),
    );
  }

  const portPool = new PortPool({ min: 40000, max: 49999, cap: 100 });
  const processManager = new ProcessManager({
    homeDir: homePath,
    portPool,
    maxProcesses: 10,
    reaperIntervalMs: 30_000,
  });

  app.route("/apps/:slug", createAppDispatcher(homePath, {
    processManager,
    publicHost,
    onAppError,
  }));

  return processManager;
}
