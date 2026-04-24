import { mkdtemp, cp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import {
  createAppDispatcher,
  appSessionMiddleware,
  deriveAppSessionKey,
  signAppSession,
  buildSetCookie,
  loadManifest,
  computeDistributionStatus,
  sandboxCapabilities,
  computeRuntimeState,
  AckStore,
  SAFE_SLUG,
  installApp,
} from "../../packages/gateway/src/app-runtime/index.js";
import { authMiddleware } from "../../packages/gateway/src/auth.js";

const TEST_TOKEN = "test-gateway-token-for-integration";

export interface TestGateway {
  app: Hono;
  home: string;
  token: string;
  url: string;
  installAppFromFixture(slug: string): Promise<void>;
  openAppSession(slug: string, opts?: { ack?: string }): Promise<string>;
  requestAckToken(slug: string): Promise<string>;
  stop(): Promise<void>;
}

export async function buildTestGateway(opts?: { home?: string }): Promise<TestGateway> {
  const home = opts?.home ?? (await mkdtemp(join(tmpdir(), "matrix-os-test-gw-")));
  await mkdir(join(home, "apps"), { recursive: true });

  const app = new Hono();
  const ackStore = new AckStore();

  // Auth middleware
  app.use("*", authMiddleware(TEST_TOKEN));

  // Manifest API
  app.get("/api/apps/:slug/manifest", async (c) => {
    const slug = c.req.param("slug");
    if (!SAFE_SLUG.test(slug)) return c.json({ error: "invalid slug" }, 400);
    const appsDir = join(home, "apps");
    const result = await loadManifest(appsDir, slug);
    if (!result.ok) {
      if (result.error.code === "not_found") return c.json({ error: "not found" }, 404);
      return c.json({ error: "internal" }, 500);
    }
    const appDir = join(appsDir, slug);
    const runtimeState = await computeRuntimeState(result.manifest, appDir);
    const distributionStatus = computeDistributionStatus(
      result.manifest.listingTrust,
      sandboxCapabilities(),
    );
    return c.json({ manifest: result.manifest, runtimeState, distributionStatus });
  });

  // Ack route
  app.post("/api/apps/:slug/ack", async (c) => {
    const slug = c.req.param("slug");
    if (!SAFE_SLUG.test(slug)) return c.json({ error: "invalid slug" }, 400);
    const appsDir = join(home, "apps");
    const result = await loadManifest(appsDir, slug);
    if (!result.ok) return c.json({ error: "not found" }, 404);
    const manifest = result.manifest;
    const distributionStatus = computeDistributionStatus(manifest.listingTrust, sandboxCapabilities());
    if (distributionStatus === "blocked") return c.json({ error: "install_blocked_by_policy" }, 403);
    if (distributionStatus === "installable") return c.json({ error: "ack_not_applicable" }, 400);
    const { ack, expiresAt } = ackStore.mint(slug, "gateway-owner");
    return c.json({ ack, expiresAt });
  });

  // Session route
  app.post("/api/apps/:slug/session", async (c) => {
    const slug = c.req.param("slug");
    if (!SAFE_SLUG.test(slug)) return c.json({ error: "invalid slug" }, 400);
    const appsDir = join(home, "apps");
    const result = await loadManifest(appsDir, slug);
    if (!result.ok) return c.json({ error: "not found" }, 404);
    const manifest = result.manifest;
    if (manifest.scope !== "personal") return c.json({ error: "scope_mismatch" }, 409);
    const distributionStatus = computeDistributionStatus(manifest.listingTrust, sandboxCapabilities());
    if (distributionStatus === "blocked") return c.json({ error: "install_blocked_by_policy" }, 403);
    if (distributionStatus === "gated") {
      let body: { ack?: string } = {};
      try { body = await c.req.json(); } catch {}
      if (!body.ack || !ackStore.peekAck(slug, "gateway-owner", body.ack)) {
        return c.json({ error: "install_gated" }, 409);
      }
    }
    const key = deriveAppSessionKey(TEST_TOKEN, slug);
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
    const cookie = buildSetCookie(slug, token, { maxAge, secure: false });
    return c.json({ expiresAt: payload.exp * 1000 }, 200, { "Set-Cookie": cookie });
  });

  // App session middleware for /apps/*
  app.use(
    "/apps/:slug/*",
    appSessionMiddleware((slug) => deriveAppSessionKey(TEST_TOKEN, slug)),
  );

  // App dispatcher
  const dispatcher = createAppDispatcher(home);
  app.route("/apps/:slug", dispatcher);

  async function installAppFromFixture(slug: string): Promise<void> {
    const fixtureDir = join(process.cwd(), "tests/fixtures/apps", slug);
    await installApp({ sourceDir: fixtureDir, homeDir: home });
  }

  async function openSession(slug: string, opts?: { ack?: string }): Promise<string> {
    const body = opts?.ack ? JSON.stringify({ ack: opts.ack }) : undefined;
    const res = await app.request(`/api/apps/${slug}/session`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body,
    });
    if (!res.ok) {
      throw new Error(`Failed to open session: ${res.status}`);
    }
    const cookieHeader = res.headers.get("set-cookie") ?? "";
    return cookieHeader.split(";")[0] ?? "";
  }

  async function requestAck(slug: string): Promise<string> {
    const res = await app.request(`/api/apps/${slug}/ack`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    if (!res.ok) throw new Error(`Failed to request ack: ${res.status}`);
    const { ack } = (await res.json()) as { ack: string };
    return ack;
  }

  return {
    app,
    home,
    token: TEST_TOKEN,
    url: "http://localhost:4000", // Only for reference, tests use app.request()
    installAppFromFixture: installAppFromFixture,
    openAppSession: openSession,
    requestAckToken: requestAck,
    stop: async () => {},
  };
}
