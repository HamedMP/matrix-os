import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import {
  type PlatformDB,
  deleteContainer,
  getContainer,
  insertContainer,
  insertUserMachine,
  updateContainerStatus,
  upsertBillingEntitlement,
} from "../../packages/platform/src/db.js";
import {
  buildPlatformWebSocketUpgradeHeaders,
  buildPostAuthRedirectPath,
  classifySessionRoutedHost,
  classifyWebSocketPath,
  createApp,
  escapeInlineScriptJson,
} from "../../packages/platform/src/main.js";
import type { Orchestrator } from "../../packages/platform/src/orchestrator.js";
import { createClerkAuth } from "../../packages/platform/src/clerk-auth.js";
import { issueSyncJwt } from "../../packages/platform/src/sync-jwt.js";
import * as syncJwt from "../../packages/platform/src/sync-jwt.js";
import { buildPlatformVerificationToken } from "../../packages/platform/src/platform-token.js";
import type { CustomerVpsService } from "../../packages/platform/src/customer-vps.js";
import type Dockerode from "dockerode";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";

const JWT_SECRET = "test-secret-at-least-32-characters-long";

function stubOrchestrator(): Orchestrator {
  return {
    provision: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    destroy: vi.fn(),
    upgrade: vi.fn(),
    rollingRestart: vi.fn(),
    getInfo: vi.fn(async (handle: string) => ({
      handle,
      clerkUserId: "user_alice",
      containerId: "ctr-1",
      port: 5001,
      shellPort: 6001,
      status: "running",
    })),
    getImage: vi.fn(),
    listAll: vi.fn().mockResolvedValue([]),
    syncStates: vi.fn(),
  };
}

function stubDocker(inspectInfo: { id?: string; ipAddress?: string; running?: boolean } = {}): Dockerode {
  const {
    id = "docker-ctr-1",
    ipAddress = "172.18.0.14",
    running = true,
  } = inspectInfo;
  return {
    getContainer: vi.fn(() => ({
      inspect: vi.fn().mockResolvedValue({
        Id: id,
        State: { Running: running },
        NetworkSettings: {
          Networks: {
            "matrixos-net": {
              IPAddress: ipAddress,
            },
          },
        },
      }),
    })),
  } as unknown as Dockerode;
}

describe("platform proxy routing", () => {
  let db: PlatformDB;

  beforeEach(async () => {
    process.env.MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED = "true";
    ({ db } = await createTestPlatformDb());
    await insertContainer(db, {
      handle: "alice",
      clerkUserId: "user_alice",
      port: 5001,
      shellPort: 6001,
      status: "running",
    });
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
    vi.restoreAllMocks();
    delete process.env.PLATFORM_JWT_SECRET;
    delete process.env.MATRIX_PAID_BETA_ENTITLEMENT_STATUS;
    delete process.env.MATRIX_STRIPE_BILLING_ENABLED;
    delete process.env.HETZNER_SERVER_TYPE;
    delete process.env.MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED;
  });

  it("escapes JSON embedded in auth page inline scripts", () => {
    expect(escapeInlineScriptJson('/?next=</script><script src=/x.js>&runtime=staging')).toBe(
      '"/?next=\\u003c/script\\u003e\\u003cscript src=/x.js\\u003e\\u0026runtime=staging"',
    );
  });

  it("keeps post-auth redirects same-origin when the request path starts with double slashes", () => {
    expect(buildPostAuthRedirectPath("https://app.matrix-os.com//evil.example/?runtime=staging")).toBe(
      "/evil.example/?runtime=staging",
    );
  });

  it("only preserves the runtime selector after auth", () => {
    expect(buildPostAuthRedirectPath("https://app.matrix-os.com/sign-in/?runtime=staging&session=secret")).toBe(
      "/?runtime=staging",
    );
    expect(buildPostAuthRedirectPath("https://app.matrix-os.com/sign-up/?session=secret")).toBe("/");
  });

  it("adds a timeout and a derived platform verification token on app-domain proxy fetches", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/api/ping", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
        cookie: "__session=clerk-cookie; other=session",
      },
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.redirect).toBe("manual");
    expect(init?.headers).toBeInstanceOf(Headers);
    const headers = init?.headers as Headers;
    expect(headers.get("authorization")).toBeTruthy();
    expect(headers.get("authorization")).not.toBe("Bearer platform-secret-123");
    expect(headers.get("x-platform-user-id")).toBe("user_alice");
    expect(headers.get("cookie")).toBeNull();
  });

  it("serves authenticated integration routes on the platform before VPS proxying", async () => {
    await insertUserMachine(db, {
      machineId: "machine-alice",
      clerkUserId: "user_alice",
      handle: "alice",
      hetznerServerId: 123,
      publicIPv4: "203.0.113.11",
      status: "running",
      imageVersion: "matrix-os-host-dev",
      provisionedAt: "2026-05-06T00:00:00.000Z",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("wrong target", { status: 200 }),
    );
    const integrationRoutes = new Hono();
    integrationRoutes.get("/", (c) =>
      c.json({
        platformUserId: c.get("platformUserId"),
        platformHandle: c.get("platformHandle"),
      }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
      integrationRoutes,
    });

    const res = await app.request("/api/integrations", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      platformUserId: "user_alice",
      platformHandle: "alice",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("issues websocket tokens for Clerk-authenticated customer VPS users before proxying", async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    await insertUserMachine(db, {
      machineId: "machine-alice-ws",
      clerkUserId: "user_alice",
      handle: "alice",
      hetznerServerId: 124,
      publicIPv4: "203.0.113.12",
      status: "running",
      imageVersion: "matrix-os-host-dev",
      provisionedAt: "2026-05-06T00:00:00.000Z",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("wrong target", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/api/auth/ws-token", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      token: expect.any(String),
      expiresAt: expect.any(Number),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("issues websocket tokens that resolve back to the selected customer VPS runtime", async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    await deleteContainer(db, "alice");
    await insertUserMachine(db, {
      machineId: "machine-alice-ws-runtime",
      clerkUserId: "user_alice",
      handle: "alice",
      hetznerServerId: 124,
      publicIPv4: "203.0.113.12",
      status: "running",
      imageVersion: "matrix-os-host-dev",
      provisionedAt: "2026-05-06T00:00:00.000Z",
    });
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/api/auth/ws-token", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { token: string };
    const claims = await syncJwt.verifySyncJwt(body.token, { secret: JWT_SECRET });
    expect(claims).toMatchObject({
      sub: "user_alice",
      handle: "alice",
      runtime_slot: "primary",
      aud: "matrix-os-sync",
      iss: "matrix-os-platform",
    });
  });

  it("serves platform billing routes before app-domain VPS proxying", async () => {
    await upsertBillingEntitlement(db, {
      clerkUserId: "user_alice",
      source: "stripe",
      planSlug: "matrix_builder",
      status: "active",
      maxRuntimeSlots: 1,
      includedRuntimeSlots: 1,
      addonRuntimeSlots: 0,
      defaultServerType: "cpx32",
      allowedServerTypes: ["cpx22", "cpx32"],
      stripeSubscriptionId: "sub_123",
      stripePriceId: "price_builder_monthly",
      gracePeriodEndsAt: "2026-06-02T00:00:00.000Z",
      effectiveFrom: "2026-05-30T00:00:00.000Z",
      effectiveUntil: null,
      updatedAt: "2026-05-30T00:00:00.000Z",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("wrong target", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/billing/status", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      entitlement: { planSlug: "matrix_builder" },
      access: { runtimeProxyAllowed: true },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns unauthorized instead of leaking Clerk verification failures on billing routes", async () => {
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockRejectedValue(new Error("jwks timeout")),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/billing/status", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("returns a generic billing-unavailable error when Stripe checkout is not configured", async () => {
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
      env: {
        STRIPE_PRICE_MATRIX_BUILDER_MONTHLY: "price_builder_monthly",
      } as NodeJS.ProcessEnv,
    });

    const res = await app.request("/billing/checkout", {
      method: "POST",
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({ planSlug: "matrix_builder", interval: "monthly" }),
    });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Billing unavailable" });
  });

  it("builds customer VPS websocket upgrade headers without leaking browser credentials or query JWTs", async () => {
    const issued = await issueSyncJwt({
      secret: JWT_SECRET,
      clerkUserId: "user_alice",
      handle: "alice",
      gatewayUrl: "https://app.matrix-os.com",
      runtimeSlot: "primary",
    });
    const headers = buildPlatformWebSocketUpgradeHeaders({
      incomingHeaders: {
        host: "app.matrix-os.com",
        authorization: `Bearer ${issued.token}`,
        cookie: "__session=secret; matrix_shell_route=alice",
        "x-forwarded-host": "app.matrix-os.com",
        "x-forwarded-proto": "https",
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-key": "client-key",
      },
      externalHost: "app.matrix-os.com",
      handle: "alice",
      userId: "user_alice",
      platformSecret: "platform-secret-123",
      includePlatformProof: true,
      isCodeDomain: false,
    });

    const platformToken = buildPlatformVerificationToken("alice", "platform-secret-123");
    expect(headers).toContain(`authorization: Bearer ${platformToken}`);
    expect(headers).toContain("x-platform-user-id: user_alice");
    expect(headers).toContain("x-platform-verified:");
    expect(headers).toContain("x-forwarded-host: app.matrix-os.com");
    expect(headers).toContain("sec-websocket-key: client-key");
    expect(headers).not.toContain(issued.token);
    expect(headers).not.toContain("__session");
    expect(headers).not.toContain("matrix_shell_route");
  });

  it("classifies websocket paths without preserving secrets", () => {
    expect(classifyWebSocketPath("/ws?token=secret")).toBe("/ws");
    expect(classifyWebSocketPath("/ws/terminal/session?token=secret&session=main")).toBe("/ws/terminal");
    expect(classifyWebSocketPath("/ws/other?token=secret")).toBe("/ws/*");
    expect(classifyWebSocketPath("/api/ping")).toBe("other");
  });

  it("classifies websocket hosts without preserving user-specific hostnames", () => {
    expect(classifySessionRoutedHost("app.matrix-os.com")).toBe("app");
    expect(classifySessionRoutedHost("code.matrix-os.com")).toBe("code");
    expect(classifySessionRoutedHost("alice.matrix-os.com")).toBe("other");
  });

  it("shows a boot page for Clerk-authenticated users while their first VPS is provisioning", async () => {
    await deleteContainer(db, "alice");
    await insertUserMachine(db, {
      machineId: "machine-alice-provisioning",
      clerkUserId: "user_alice",
      handle: "alice",
      hetznerServerId: 123,
      publicIPv4: "203.0.113.11",
      status: "provisioning",
      imageVersion: "matrix-os-host-dev",
      provisionedAt: "2026-05-06T00:00:00.000Z",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("wrong target", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.get("cdn-cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain("Booting Matrix OS");
    expect(html).toContain("Instance status:");
    expect(html).toContain("<strong>provisioning</strong>");
    expect(html).not.toContain("alice.matrix-os.com");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the provisioning page instead of raw billing JSON when paid-beta entitlement denies shell access", async () => {
    await deleteContainer(db, "alice");
    await insertUserMachine(db, {
      machineId: "machine-alice-provisioning-expired",
      clerkUserId: "user_alice",
      handle: "alice",
      hetznerServerId: 123,
      publicIPv4: "203.0.113.11",
      status: "provisioning",
      imageVersion: "matrix-os-host-dev",
      provisionedAt: "2026-05-06T00:00:00.000Z",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("wrong target", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
      env: {
        MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED: "true",
        MATRIX_PAID_BETA_ENTITLEMENT_STATUS: "expired",
      } as NodeJS.ProcessEnv,
    });

    const res = await app.request("/", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.get("set-cookie")).toBeNull();
    const html = await res.text();
    expect(html).toContain("Booting Matrix OS");
    expect(html).toContain("Instance status:");
    expect(html).toContain("<strong>provisioning</strong>");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the provisioning page instead of raw billing JSON when Stripe billing is inactive", async () => {
    await deleteContainer(db, "alice");
    await insertUserMachine(db, {
      machineId: "machine-alice-provisioning-stripe-expired",
      clerkUserId: "user_alice",
      handle: "alice",
      hetznerServerId: 123,
      publicIPv4: "203.0.113.11",
      status: "provisioning",
      imageVersion: "matrix-os-host-dev",
      provisionedAt: "2026-05-06T00:00:00.000Z",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("wrong target", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
      env: { MATRIX_STRIPE_BILLING_ENABLED: "true" } as NodeJS.ProcessEnv,
    });

    const res = await app.request("/", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toContain("Booting Matrix OS");
    expect(html).toContain("Instance status:");
    expect(html).toContain("<strong>provisioning</strong>");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps provisioning runtime API paths blocked when Stripe billing is inactive", async () => {
    await deleteContainer(db, "alice");
    await insertUserMachine(db, {
      machineId: "machine-alice-provisioning-stripe-api-expired",
      clerkUserId: "user_alice",
      handle: "alice",
      hetznerServerId: 123,
      publicIPv4: "203.0.113.11",
      status: "provisioning",
      imageVersion: "matrix-os-host-dev",
      provisionedAt: "2026-05-06T00:00:00.000Z",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("wrong target", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
      env: { MATRIX_STRIPE_BILLING_ENABLED: "true" } as NodeJS.ProcessEnv,
    });

    const res = await app.request("/api/theme", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: "Paid beta access required" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("routes sync JWT bearer requests through app.matrix-os.com to the matching container", async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      platformSecret: "platform-secret-123",
    });
    const issued = await issueSyncJwt({
      secret: JWT_SECRET,
      clerkUserId: "user_alice",
      handle: "alice",
      gatewayUrl: "https://app.matrix-os.com",
    });

    const res = await app.request("/api/sync/manifest", {
      headers: {
        host: "app.matrix-os.com",
        authorization: `Bearer ${issued.token}`,
      },
    });

    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://matrixos-alice:4000/api/sync/manifest");
    const headers = init?.headers as Headers;
    expect(headers.get("authorization")).toBeTruthy();
    expect(headers.get("x-platform-user-id")).toBe("user_alice");
  });

  it("reports recovering VPS status for sync JWT gateway health instead of returning unauthorized", async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    await deleteContainer(db, "alice");
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff201",
      clerkUserId: "user_alice",
      handle: "alice",
      status: "recovering",
      hetznerServerId: 123501,
      publicIPv4: "203.0.113.41",
      imageVersion: "matrix-os-host-dev",
      provisionedAt: "2026-05-06T00:00:00.000Z",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("wrong target", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      platformSecret: "platform-secret-123",
    });
    const issued = await issueSyncJwt({
      secret: JWT_SECRET,
      clerkUserId: "user_alice",
      handle: "alice",
      gatewayUrl: "https://app.matrix-os.com",
    });

    const res = await app.request("/api/health", {
      headers: {
        host: "app.matrix-os.com",
        authorization: `Bearer ${issued.token}`,
      },
    });

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: "VPS provisioning",
      status: "recovering",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("routes mobile app session-token launches to the hinted customer VPS without Clerk cookies", async () => {
    await insertUserMachine(db, {
      machineId: "machine-alice-mobile-app",
      clerkUserId: "user_alice",
      handle: "alice",
      hetznerServerId: 125,
      publicIPv4: "203.0.113.13",
      status: "running",
      imageVersion: "matrix-os-host-dev",
      provisionedAt: "2026-05-06T00:00:00.000Z",
    });
    await insertUserMachine(db, {
      machineId: "machine-alice-mobile-app-staging",
      clerkUserId: "user_alice",
      handle: "alice-staging",
      runtimeSlot: "staging",
      hetznerServerId: 126,
      publicIPv4: "203.0.113.14",
      status: "running",
      imageVersion: "matrix-os-host-dev",
      provisionedAt: "2026-05-06T00:00:00.000Z",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("<html>app</html>", {
        status: 302,
        headers: { location: "/apps/calculator/" },
      }))
      .mockResolvedValueOnce(new Response("asset", {
        status: 200,
        headers: {
          "content-encoding": "gzip",
          "content-length": "999",
          "connection": "close",
          "transfer-encoding": "chunked",
        },
      }));
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/apps/calculator/?session=alice.opaque-token", {
      headers: { host: "app.matrix-os.com" },
      redirect: "manual",
    });

    expect(res.status).toBe(302);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://203.0.113.13:443/apps/calculator/?session=alice.opaque-token");
    const headers = init?.headers as Headers;
    expect(headers.get("authorization")).toBeTruthy();
    expect(headers.get("x-platform-user-id")).toBeNull();
    expect(headers.get("x-platform-verified")).toBeNull();
    expect(res.headers.get("set-cookie")).toContain("matrix_app_route=alice");
    expect(res.headers.get("set-cookie")).toContain("Path=/apps/calculator/");

    const assetRes = await app.request("/apps/calculator/assets/index.js", {
      headers: {
        host: "app.matrix-os.com",
        cookie: "matrix_app_route=alice; matrix_app_session__calculator=session-cookie",
      },
    });

    expect(assetRes.status).toBe(200);
    const [assetUrl, assetInit] = fetchMock.mock.calls[1]!;
    expect(assetUrl).toBe("https://203.0.113.13:443/apps/calculator/assets/index.js");
    const assetHeaders = assetInit?.headers as Headers;
    expect(assetHeaders.get("cookie")).toBe("matrix_app_session__calculator=session-cookie");
    expect(assetHeaders.get("accept-encoding")).toBe("identity");
    expect(assetHeaders.get("x-platform-user-id")).toBeNull();
    expect(assetRes.headers.get("content-encoding")).toBeNull();
    expect(assetRes.headers.get("content-length")).toBeNull();
    expect(assetRes.headers.get("connection")).toBeNull();
    expect(assetRes.headers.get("transfer-encoding")).toBeNull();
  });

  it("routes code.matrix-os.com to the authenticated user's VPS gateway first", async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff112",
      clerkUserId: "user_alice",
      handle: "alice",
      status: "running",
      hetznerServerId: 123456,
      publicIPv4: "203.0.113.10",
      imageVersion: "matrix-os-host-2026.04.26-1",
      provisionedAt: "2026-04-26T12:00:00.000Z",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response("editor", { status: 200 }),
    );
    const docker = stubDocker();
    const app = createApp({
      db,
      docker,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/?folder=/home/matrixos/home", {
      headers: {
        host: "code.matrix-os.com",
        authorization: "Bearer clerk-session",
        cookie: "__session=clerk-cookie; code-server=session",
      },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("editor");
    expect(docker.getContainer).not.toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://203.0.113.10:443/?folder=/home/matrixos/home");
    expect(init?.dispatcher).toBeDefined();
    const headers = init?.headers as Headers;
    expect(headers.get("host")).toBe("code.matrix-os.com");
    expect(headers.get("x-forwarded-host")).toBe("code.matrix-os.com");
    expect(headers.get("authorization")).toBeTruthy();
    expect(headers.get("authorization")).not.toBe("Bearer clerk-session");
    expect(headers.get("x-platform-user-id")).toBe("user_alice");
    expect(headers.get("cookie")).toBeNull();
    expect(res.headers.get("set-cookie")).toContain("matrix_code_session=");
    expect(res.headers.get("set-cookie")).toContain("SameSite=Lax");
  });

  it("does not send an unverified platform user header to a VPS without a platform secret", async () => {
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff115",
      clerkUserId: "user_alice",
      handle: "alice",
      status: "running",
      hetznerServerId: 123459,
      publicIPv4: "203.0.113.13",
      imageVersion: "matrix-os-host-2026.04.26-1",
      provisionedAt: "2026-04-26T12:00:00.000Z",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response("editor", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "",
    });

    const res = await app.request("/", {
      headers: {
        host: "code.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(res.status).toBe(200);
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-platform-verified")).toBeNull();
    expect(headers.get("x-platform-user-id")).toBeNull();
  });

  it("routes new VPS-only users on code.matrix-os.com without a legacy container", async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    await deleteContainer(db, "alice");
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff114",
      clerkUserId: "user_alice",
      handle: "alice",
      status: "running",
      hetznerServerId: 123458,
      publicIPv4: "203.0.113.12",
      imageVersion: "matrix-os-host-2026.04.26-1",
      provisionedAt: "2026-04-26T12:00:00.000Z",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("editor", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/", {
      headers: {
        host: "code.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://203.0.113.12:443/");
    expect(fetchMock.mock.calls[0]?.[1]?.dispatcher).toBeDefined();
  });

  it("ignores stale legacy containers on app.matrix-os.com when VPS-native routing is configured", async () => {
    await updateContainerStatus(db, "alice", "stopped", "stale-container-id");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("wrong target", { status: 200 }),
    );
    const orchestrator = stubOrchestrator();
    const app = createApp({
      db,
      orchestrator,
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
      customerVpsService: {} as CustomerVpsService,
      env: {
        MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED: "true",
      } as NodeJS.ProcessEnv,
    });

    const res = await app.request("/", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Preparing Matrix OS");
    expect(html).not.toContain("Failed to wake container");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(orchestrator.start).not.toHaveBeenCalled();
  });

  it("routes Clerk sessions to the selected staging VPS slot", async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    await deleteContainer(db, "alice");
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff123",
      clerkUserId: "user_alice",
      handle: "alice",
      runtimeSlot: "primary",
      status: "running",
      hetznerServerId: 123467,
      publicIPv4: "203.0.113.21",
      imageVersion: "matrix-os-host-2026.04.26-1",
      provisionedAt: "2026-04-26T11:00:00.000Z",
    });
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff124",
      clerkUserId: "user_alice",
      handle: "alice",
      runtimeSlot: "staging",
      status: "running",
      hetznerServerId: 123468,
      publicIPv4: "203.0.113.22",
      imageVersion: "matrix-os-host-2026.04.26-1",
      provisionedAt: "2026-04-26T12:00:00.000Z",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response("editor", { status: 200 }),
    );
    const docker = stubDocker();
    const app = createApp({
      db,
      docker,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/?runtime=staging&folder=/home/matrixos/home", {
      headers: {
        host: "code.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("editor");
    expect(docker.getContainer).not.toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://203.0.113.22:443/?folder=/home/matrixos/home");
    expect(init?.dispatcher).toBeDefined();
    const headers = init?.headers as Headers;
    expect(headers.get("host")).toBe("code.matrix-os.com");
    expect(headers.get("authorization")).toBeTruthy();
    expect(headers.get("authorization")).not.toBe("Bearer clerk-session");
    expect(headers.get("x-platform-user-id")).toBe("user_alice");
    const sessionCookie = res.headers.get("set-cookie");
    expect(sessionCookie).toContain("matrix_code_session=");

    const codeSession = /matrix_code_session=([^;,]+)/.exec(sessionCookie ?? "")?.[1];
    expect(codeSession).toBeTruthy();

    const followUp = await app.request("/stable/static/out/vs/code/browser/workbench/workbench.js", {
      headers: {
        host: "code.matrix-os.com",
        cookie: `matrix_code_session=${codeSession}`,
      },
    });

    expect(followUp.status).toBe(200);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://203.0.113.22:443/stable/static/out/vs/code/browser/workbench/workbench.js",
    );
  });

  it("routes staging-only Clerk users to their active VPS on unqualified requests", async () => {
    await deleteContainer(db, "alice");
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff136",
      clerkUserId: "user_alice",
      handle: "alice-staging",
      runtimeSlot: "staging",
      status: "running",
      hetznerServerId: 123480,
      publicIPv4: "203.0.113.31",
      imageVersion: "matrix-os-host-2026.04.26-1",
      provisionedAt: "2026-04-26T12:00:00.000Z",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("shell", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("shell");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://203.0.113.31:443/");
    expect(res.headers.get("set-cookie")).toContain("matrix_shell_route=alice-staging");
  });

  it("does not persist a selected runtime slot through the Clerk sign-in handoff", async () => {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_matrix";
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue(null),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/?runtime=staging", {
      headers: {
        host: "app.matrix-os.com",
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie") ?? "").not.toContain("matrix_runtime_slot=");
    const html = await res.text();
    expect(html).toContain('afterSignInUrl: redirectTarget');
    expect(html).toContain('var redirectTarget = "/?runtime=staging";');
  });

  it("shows a switch-computer picker with explicit VM links", async () => {
    await deleteContainer(db, "alice");
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff128",
      clerkUserId: "user_alice",
      handle: "alice",
      runtimeSlot: "primary",
      status: "running",
      hetznerServerId: 123472,
      publicIPv4: "203.0.113.25",
      imageVersion: "matrix-os-host-2026.04.26-1",
      serverType: "cpx22",
      provisionedAt: "2026-04-26T12:00:00.000Z",
    });
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff129",
      clerkUserId: "user_alice",
      handle: "alice-staging",
      runtimeSlot: "staging",
      status: "running",
      hetznerServerId: 123473,
      publicIPv4: "203.0.113.26",
      imageVersion: "stale-db-staging-version",
      serverType: "cpx22",
      provisionedAt: "2026-05-25T11:23:51.076Z",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const version = String(url).includes("203.0.113.26")
        ? "v082-login-shell-8935a7cd"
        : "matrix-os-host-2026.04.26-1";
      return Response.json({ release: { version }, startedAt: "2026-05-25T11:25:00.000Z" });
    });
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/runtime", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://203.0.113.25:443/api/system/info",
      "https://203.0.113.26:443/api/system/info",
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect((init?.headers as Headers).get("host")).toBe("app.matrix-os.com");
      expect((init?.headers as Headers).get("x-forwarded-host")).toBe("app.matrix-os.com");
    }
    expect(timeoutSpy).toHaveBeenCalledWith(2500);
    const html = await res.text();
    expect(html).toContain("Choose your Matrix OS computer");
    expect(html).toContain("href=\"/vm/alice\"");
    expect(html).toContain("href=\"/vm/alice-staging\"");
    expect(html).toContain("v082-login-shell-8935a7cd");
    expect(html).not.toContain("stale-db-staging-version");
    expect(html).toContain("2 vCPU");
    expect(html).toContain("4 GB RAM");
    expect(html).toContain("background: linear-gradient(90deg, #2f392c");
  });

  it("does not show the runtime picker for unauthenticated root visits", async () => {
    await deleteContainer(db, "alice");
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff136",
      clerkUserId: "user_alice",
      handle: "alice",
      runtimeSlot: "primary",
      status: "running",
      hetznerServerId: 123480,
      publicIPv4: "203.0.113.31",
      imageVersion: "matrix-os-host-2026.04.26-1",
      serverType: "cpx22",
      provisionedAt: "2026-04-26T12:00:00.000Z",
    });
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff137",
      clerkUserId: "user_alice",
      handle: "alice-staging",
      runtimeSlot: "staging",
      status: "running",
      hetznerServerId: 123481,
      publicIPv4: "203.0.113.32",
      imageVersion: "v082-login-shell-8935a7cd",
      serverType: "cpx22",
      provisionedAt: "2026-05-25T11:23:51.076Z",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("wrong target", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue(null),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/", {
      headers: { host: "app.matrix-os.com" },
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("afterSignInUrl: redirectTarget");
    expect(html).not.toContain("Choose a Matrix OS machine");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sets the current computer route on cold root visits without a runtime cookie", async () => {
    await deleteContainer(db, "alice");
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff132",
      clerkUserId: "user_alice",
      handle: "alice-staging",
      runtimeSlot: "staging",
      status: "running",
      hetznerServerId: 123476,
      publicIPv4: "203.0.113.29",
      imageVersion: "v082-login-shell-8935a7cd",
      serverType: "cpx22",
      provisionedAt: "2026-05-25T11:23:51.076Z",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("shell", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("shell");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://203.0.113.29:443/");
    expect(res.headers.get("set-cookie")).toContain("matrix_shell_route=alice-staging");
    expect(res.headers.get("set-cookie") ?? "").not.toContain("matrix_runtime_slot=");
  });

  it("shows the switch-computer route even when a stale runtime cookie exists", async () => {
    await deleteContainer(db, "alice");
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff130",
      clerkUserId: "user_alice",
      handle: "alice",
      runtimeSlot: "primary",
      status: "running",
      hetznerServerId: 123474,
      publicIPv4: "203.0.113.27",
      imageVersion: "matrix-os-host-2026.04.26-1",
      serverType: "cpx22",
      provisionedAt: "2026-04-26T12:00:00.000Z",
    });
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff131",
      clerkUserId: "user_alice",
      handle: "alice-staging",
      runtimeSlot: "staging",
      status: "running",
      hetznerServerId: 123475,
      publicIPv4: "203.0.113.28",
      imageVersion: "v082-login-shell-8935a7cd",
      serverType: "cpx22",
      provisionedAt: "2026-05-25T11:23:51.076Z",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const version = String(url).includes("203.0.113.28")
        ? "v082-login-shell-8935a7cd"
        : "matrix-os-host-2026.04.26-1";
      return Response.json({ release: { version }, startedAt: "2026-05-25T11:25:00.000Z" });
    });
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/runtime", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
        cookie: "matrix_runtime_slot=primary",
      },
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const html = await res.text();
    expect(html).toContain("Choose your Matrix OS computer");
    expect(html).toContain("href=\"/vm/alice-staging\"");
  });

  it("routes explicit VM URLs to the named computer and keeps API calls on that computer", async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    await deleteContainer(db, "alice");
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff137",
      clerkUserId: "user_alice",
      handle: "alice",
      runtimeSlot: "primary",
      status: "running",
      hetznerServerId: 123481,
      publicIPv4: "203.0.113.32",
      imageVersion: "matrix-os-host-2026.04.26-1",
      provisionedAt: "2026-04-26T12:00:00.000Z",
    });
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff138",
      clerkUserId: "user_alice",
      handle: "alice-staging",
      runtimeSlot: "staging",
      status: "running",
      hetznerServerId: 123482,
      publicIPv4: "203.0.113.33",
      imageVersion: "v082-login-shell-8935a7cd",
      provisionedAt: "2026-05-25T11:23:51.076Z",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("staging", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const explicit = await app.request("/vm/alice-staging/projects?view=home", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(explicit.status).toBe(200);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://203.0.113.33:443/projects?view=home");
    expect(explicit.headers.get("set-cookie")).toContain("matrix_shell_route=alice-staging");

    const api = await app.request("/api/auth/ws-token", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
        cookie: "matrix_shell_route=alice-staging",
      },
    });

    expect(api.status).toBe(200);
    const body = await api.json() as { token: string };
    const claims = await syncJwt.verifySyncJwt(body.token, { secret: JWT_SECRET });
    expect(claims.handle).toBe("alice-staging");
    expect(claims.runtime_slot).toBe("staging");
  });

  it("routes authenticated shell static assets through the selected VM handle cookie", async () => {
    await deleteContainer(db, "alice");
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff141",
      clerkUserId: "user_alice",
      handle: "alice",
      runtimeSlot: "primary",
      status: "running",
      hetznerServerId: 123485,
      publicIPv4: "203.0.113.35",
      imageVersion: "v082-login-shell-primary",
      provisionedAt: "2026-05-25T11:23:51.076Z",
    });
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff142",
      clerkUserId: "user_alice",
      handle: "alice-staging",
      runtimeSlot: "staging",
      status: "running",
      hetznerServerId: 123486,
      publicIPv4: "203.0.113.33",
      imageVersion: "v082-login-shell-staging",
      provisionedAt: "2026-05-25T11:23:51.076Z",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("asset", {
        status: 200,
        headers: { "content-type": "text/javascript" },
      }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/_next/static/chunks/app.js", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
        cookie: "matrix_shell_route=alice-staging",
      },
    });

    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://203.0.113.33:443/_next/static/chunks/app.js");
    const headers = init?.headers as Headers;
    expect(headers.get("x-platform-user-id")).toBe("user_alice");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("set-cookie")).toContain("matrix_shell_route=alice-staging");
  });

  it("falls back to an available machine when the shell route cookie points to a removed VM", async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    await deleteContainer(db, "alice");
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff140",
      clerkUserId: "user_alice",
      handle: "alice",
      runtimeSlot: "primary",
      status: "running",
      hetznerServerId: 123484,
      publicIPv4: "203.0.113.35",
      imageVersion: "v082-login-shell-8935a7cd",
      provisionedAt: "2026-05-25T11:23:51.076Z",
    });
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/api/auth/ws-token", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
        cookie: "matrix_shell_route=alice-deleted-staging",
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { token: string };
    const claims = await syncJwt.verifySyncJwt(body.token, { secret: JWT_SECRET });
    expect(claims.handle).toBe("alice");
    expect(claims.runtime_slot).toBe("primary");
  });

  it("returns a machine-unavailable error when a stale route cookie has no fallback machine", async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    await deleteContainer(db, "alice");
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/api/auth/ws-token", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
        cookie: "matrix_shell_route=alice-deleted-staging",
      },
    });

    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({
      error: "Matrix computer unavailable",
      code: "machine_unavailable",
    });
  });

  it("falls back to Clerk routing when the shell route cookie belongs to another user", async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    await deleteContainer(db, "alice");
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff143",
      clerkUserId: "user_alice",
      handle: "alice",
      runtimeSlot: "primary",
      status: "running",
      hetznerServerId: 123487,
      publicIPv4: "203.0.113.35",
      imageVersion: "v082-login-shell-8935a7cd",
      provisionedAt: "2026-05-25T11:23:51.076Z",
    });
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff144",
      clerkUserId: "user_bob",
      handle: "bob-staging",
      runtimeSlot: "staging",
      status: "running",
      hetznerServerId: 123488,
      publicIPv4: "203.0.113.36",
      imageVersion: "v082-login-shell-8935a7cd",
      provisionedAt: "2026-05-25T11:23:51.076Z",
    });
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/api/auth/ws-token", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
        cookie: "matrix_shell_route=bob-staging",
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { token: string };
    const claims = await syncJwt.verifySyncJwt(body.token, { secret: JWT_SECRET });
    expect(claims.handle).toBe("alice");
    expect(claims.runtime_slot).toBe("primary");
  });

  it("does not route explicit VM URLs across Clerk users", async () => {
    await deleteContainer(db, "alice");
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff139",
      clerkUserId: "user_bob",
      handle: "bob-staging",
      runtimeSlot: "staging",
      status: "running",
      hetznerServerId: 123483,
      publicIPv4: "203.0.113.34",
      imageVersion: "v082-login-shell-8935a7cd",
      provisionedAt: "2026-05-25T11:23:51.076Z",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("wrong owner", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/vm/bob-staging", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows unknown CPU and RAM for legacy machines without stored server type", async () => {
    process.env.HETZNER_SERVER_TYPE = "cpx22";
    await deleteContainer(db, "alice");
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff134",
      clerkUserId: "user_alice",
      handle: "alice",
      runtimeSlot: "primary",
      status: "running",
      hetznerServerId: 123478,
      publicIPv4: "203.0.113.30",
      imageVersion: "matrix-os-host-2026.04.26-1",
      provisionedAt: "2026-04-26T12:00:00.000Z",
    });
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ release: { version: "matrix-os-host-2026.04.26-1" } }),
    );

    const res = await app.request("/runtime", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("CPU/RAM unavailable");
    expect(html).toContain("Unknown plan");
    expect(html).not.toContain("2 vCPU");
  });

  it("redirects the runtime picker when the user has no active VPS machines", async () => {
    await deleteContainer(db, "alice");
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff135",
      clerkUserId: "user_alice",
      handle: "alice",
      runtimeSlot: "primary",
      status: "failed",
      hetznerServerId: 123479,
      publicIPv4: null,
      imageVersion: "v082-login-shell-8935a7cd",
      serverType: "cpx22",
      provisionedAt: "2026-05-25T11:23:51.076Z",
    });
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/runtime", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
      redirect: "manual",
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
  });

  it("does not show the runtime picker for a failed secondary VPS on cold root visits", async () => {
    await deleteContainer(db, "alice");
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff132",
      clerkUserId: "user_alice",
      handle: "alice",
      runtimeSlot: "primary",
      status: "running",
      hetznerServerId: 123476,
      publicIPv4: "203.0.113.29",
      imageVersion: "matrix-os-host-2026.04.26-1",
      serverType: "cpx22",
      provisionedAt: "2026-04-26T12:00:00.000Z",
    });
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff133",
      clerkUserId: "user_alice",
      handle: "alice-staging",
      runtimeSlot: "staging",
      status: "failed",
      hetznerServerId: 123477,
      publicIPv4: null,
      imageVersion: "v082-login-shell-8935a7cd",
      serverType: "cpx22",
      provisionedAt: "2026-05-25T11:23:51.076Z",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("shell", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("shell");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://203.0.113.29:443/");
  });

  it("keeps staging selection request-scoped while a staging VPS is booting", async () => {
    await deleteContainer(db, "alice");
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff129",
      clerkUserId: "user_alice",
      handle: "alice",
      runtimeSlot: "primary",
      status: "running",
      hetznerServerId: 123470,
      publicIPv4: "203.0.113.23",
      imageVersion: "matrix-os-host-2026.04.26-1",
      provisionedAt: "2026-04-26T11:00:00.000Z",
    });
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff125",
      clerkUserId: "user_alice",
      handle: "alice",
      runtimeSlot: "staging",
      status: "provisioning",
      hetznerServerId: 123469,
      publicIPv4: null,
      imageVersion: "matrix-os-host-2026.04.26-1",
      provisionedAt: "2026-04-26T12:00:00.000Z",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("primary", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/?runtime=staging", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(res.status).toBe(503);
    expect(res.headers.get("set-cookie") ?? "").not.toContain("matrix_runtime_slot=");
    expect(fetchMock).not.toHaveBeenCalled();

    const followUp = await app.request("/", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
        cookie: "matrix_runtime_slot=staging",
      },
    });

    expect(followUp.status).toBe(200);
    expect(await followUp.text()).toBe("primary");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://203.0.113.23:443/");
    expect(followUp.headers.get("set-cookie") ?? "").not.toContain("matrix_runtime_slot=");
  });

  it("falls back to primary when a stale staging runtime cookie has no machine", async () => {
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff127",
      clerkUserId: "user_alice",
      handle: "alice",
      runtimeSlot: "primary",
      status: "running",
      hetznerServerId: 123471,
      publicIPv4: "203.0.113.24",
      imageVersion: "matrix-os-host-2026.04.26-1",
      provisionedAt: "2026-04-26T12:00:00.000Z",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response("shell", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/?runtime=staging&view=home", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
        cookie: "matrix_runtime_slot=staging",
      },
    });

    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://203.0.113.24:443/?view=home");
    expect(res.headers.get("set-cookie")).toContain("matrix_shell_route=alice");
    expect(res.headers.get("set-cookie") ?? "").not.toContain("matrix_runtime_slot=");
  });

  it("does not use handle fallback across different Clerk users", async () => {
    await deleteContainer(db, "alice");
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff131",
      clerkUserId: "user_alice",
      handle: "alice",
      runtimeSlot: "staging",
      status: "provisioning",
      hetznerServerId: 123475,
      publicIPv4: null,
      imageVersion: "matrix-os-host-2026.04.26-1",
      provisionedAt: "2026-04-26T12:00:00.000Z",
    });
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff130",
      clerkUserId: "user_bob",
      handle: "alice",
      runtimeSlot: "primary",
      status: "running",
      hetznerServerId: 123474,
      publicIPv4: "203.0.113.30",
      imageVersion: "matrix-os-host-2026.04.26-1",
      provisionedAt: "2026-04-26T11:00:00.000Z",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("wrong owner", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/?runtime=staging", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
        cookie: "matrix_runtime_slot=staging",
      },
    });

    expect(res.status).toBe(503);
    expect(await res.text()).toContain("Booting Matrix OS");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.headers.get("set-cookie") ?? "").not.toContain("matrix_runtime_slot=primary");
  });

  it("strips runtime with URLSearchParams while preserving encoded values", async () => {
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff129",
      clerkUserId: "user_alice",
      handle: "alice",
      status: "running",
      hetznerServerId: 123473,
      publicIPv4: "203.0.113.29",
      imageVersion: "matrix-os-host-2026.04.26-1",
      provisionedAt: "2026-04-26T12:00:00.000Z",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("shell", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/?%72untime=staging&next=a%23b&view=home", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://203.0.113.29:443/?next=a%23b&view=home");
  });

  it("blocks runtime proxying when paid-beta entitlement denies access", async () => {
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff126",
      clerkUserId: "user_alice",
      handle: "alice",
      status: "running",
      hetznerServerId: 123470,
      publicIPv4: "203.0.113.23",
      imageVersion: "matrix-os-host-2026.04.26-1",
      provisionedAt: "2026-04-26T12:00:00.000Z",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response("editor", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
      env: { MATRIX_PAID_BETA_ENTITLEMENT_STATUS: "missing" } as NodeJS.ProcessEnv,
    });

    const res = await app.request("/", {
      headers: {
        host: "code.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: "Paid beta access required" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await getContainer(db, "alice")).toMatchObject({
      handle: "alice",
      clerkUserId: "user_alice",
    });
  });

  it("still serves the shell for the billing gate when Stripe billing is enabled without an active entitlement", async () => {
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff127",
      clerkUserId: "user_alice",
      handle: "alice",
      status: "running",
      hetznerServerId: 123471,
      publicIPv4: "203.0.113.24",
      imageVersion: "matrix-os-host-2026.04.26-1",
      provisionedAt: "2026-04-26T12:00:00.000Z",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response("shell html", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
      env: { MATRIX_STRIPE_BILLING_ENABLED: "true" } as NodeJS.ProcessEnv,
    });

    const res = await app.request("/", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("shell html");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://203.0.113.24:443/");
    expect(res.headers.get("set-cookie")).toContain("matrix_shell_route=alice");
  });

  it("keeps runtime API paths blocked while the unpaid billing shell is visible", async () => {
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff12a",
      clerkUserId: "user_alice",
      handle: "alice",
      status: "running",
      hetznerServerId: 123474,
      publicIPv4: "203.0.113.26",
      imageVersion: "matrix-os-host-2026.04.26-1",
      provisionedAt: "2026-04-26T12:00:00.000Z",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response("wrong target", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
      env: { MATRIX_STRIPE_BILLING_ENABLED: "true" } as NodeJS.ProcessEnv,
    });

    const res = await app.request("/api/theme", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: "Paid beta access required" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serves shell static assets routed by cookie for unpaid users", async () => {
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff12b",
      clerkUserId: "user_alice",
      handle: "alice",
      status: "running",
      hetznerServerId: 123475,
      publicIPv4: "203.0.113.27",
      imageVersion: "matrix-os-host-2026.04.26-1",
      provisionedAt: "2026-04-26T12:00:00.000Z",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response("icon", {
        status: 200,
        headers: { "content-type": "image/x-icon" },
      }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
      env: { MATRIX_STRIPE_BILLING_ENABLED: "true" } as NodeJS.ProcessEnv,
    });

    const res = await app.request("/favicon.ico", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
        cookie: "matrix_shell_route=alice",
      },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("icon");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://203.0.113.27:443/favicon.ico");
    expect(res.headers.get("content-type")).toBe("image/x-icon");
  });

  it("serves the billing shell for explicit VM routes when Stripe access is inactive", async () => {
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff12c",
      clerkUserId: "user_alice",
      handle: "alice",
      status: "running",
      hetznerServerId: 123476,
      publicIPv4: "203.0.113.28",
      imageVersion: "matrix-os-host-2026.04.26-1",
      provisionedAt: "2026-04-26T12:00:00.000Z",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response("explicit shell", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
      env: { MATRIX_STRIPE_BILLING_ENABLED: "true" } as NodeJS.ProcessEnv,
    });

    const res = await app.request("/vm/alice", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("explicit shell");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://203.0.113.28:443/");
    expect(res.headers.get("set-cookie")).toContain("matrix_shell_route=alice");
  });

  it("blocks explicit VM runtime API routes when Stripe access is inactive", async () => {
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff12d",
      clerkUserId: "user_alice",
      handle: "alice",
      status: "running",
      hetznerServerId: 123477,
      publicIPv4: "203.0.113.29",
      imageVersion: "matrix-os-host-2026.04.26-1",
      provisionedAt: "2026-04-26T12:00:00.000Z",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response("wrong target", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
      env: { MATRIX_STRIPE_BILLING_ENABLED: "true" } as NodeJS.ProcessEnv,
    });

    const res = await app.request("/vm/alice/api/theme", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: "Paid beta access required" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows runtime proxying from Stripe entitlements even if the old beta env gate is expired", async () => {
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff128",
      clerkUserId: "user_alice",
      handle: "alice",
      status: "running",
      hetznerServerId: 123472,
      publicIPv4: "203.0.113.25",
      imageVersion: "matrix-os-host-2026.04.26-1",
      provisionedAt: "2026-04-26T12:00:00.000Z",
    });
    await upsertBillingEntitlement(db, {
      clerkUserId: "user_alice",
      source: "stripe",
      planSlug: "matrix_builder",
      status: "active",
      maxRuntimeSlots: 1,
      includedRuntimeSlots: 1,
      addonRuntimeSlots: 0,
      defaultServerType: "cpx32",
      allowedServerTypes: ["cpx22", "cpx32"],
      stripeSubscriptionId: "sub_123",
      stripePriceId: "price_builder_monthly",
      gracePeriodEndsAt: "2026-06-02T00:00:00.000Z",
      effectiveFrom: "2026-05-30T00:00:00.000Z",
      effectiveUntil: null,
      updatedAt: "2026-05-30T00:00:00.000Z",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
      env: {
        MATRIX_STRIPE_BILLING_ENABLED: "true",
        MATRIX_PAID_BETA_ENTITLEMENT_STATUS: "expired",
      } as NodeJS.ProcessEnv,
    });

    const res = await app.request("/", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("blocks legacy container proxying when paid-beta entitlement denies access", async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response("editor", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
      env: {
        MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED: "true",
        MATRIX_PAID_BETA_ENTITLEMENT_STATUS: "expired",
      } as NodeJS.ProcessEnv,
    });

    const res = await app.request("/", {
      headers: {
        host: "code.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: "Paid beta access required" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to the legacy container code-server when no running VPS exists", async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("editor", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/?folder=/home/matrixos/home", {
      headers: {
        host: "code.matrix-os.com",
        authorization: "Bearer clerk-session",
        cookie: "__session=clerk-cookie; code-server=session",
      },
    });

    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://matrixos-alice:8787/?folder=/home/matrixos/home");
    const headers = init?.headers as Headers;
    expect(headers.get("host")).toBe("code.matrix-os.com");
    expect(headers.get("x-forwarded-host")).toBe("code.matrix-os.com");
    expect(headers.get("x-matrix-code-proxy-token")).toBeTruthy();
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-platform-user-id")).toBeNull();
    expect(headers.get("cookie")).toBeNull();
    expect(res.headers.get("set-cookie")).toContain("matrix_code_session=");
    expect(res.headers.get("set-cookie")).toContain("HttpOnly");
    expect(res.headers.get("set-cookie")).toContain("SameSite=Lax");
    expect(res.headers.get("set-cookie")).toContain("Max-Age=43200");
  });

  it("accepts the short-lived code-domain session cookie for follow-up VPS editor requests", async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff113",
      clerkUserId: "user_alice",
      handle: "alice",
      status: "running",
      hetznerServerId: 123457,
      publicIPv4: "203.0.113.11",
      imageVersion: "matrix-os-host-2026.04.26-1",
      provisionedAt: "2026-04-26T12:00:00.000Z",
    });
    const verifyToken = vi.fn();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("editor", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({ verifyToken }),
      platformSecret: "platform-secret-123",
    });
    const issued = await issueSyncJwt({
      secret: JWT_SECRET,
      clerkUserId: "user_alice",
      handle: "alice",
      gatewayUrl: "https://code.matrix-os.com",
    });

    const res = await app.request("/stable/static/out/vs/code/browser/workbench/workbench.js", {
      headers: {
        host: "code.matrix-os.com",
        cookie: `matrix_code_session=${encodeURIComponent(issued.token)}; __session=ignored`,
      },
    });

    expect(res.status).toBe(200);
    expect(verifyToken).not.toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://203.0.113.11:443/stable/static/out/vs/code/browser/workbench/workbench.js");
    const headers = init?.headers as Headers;
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("x-matrix-code-proxy-token")).toBeTruthy();
    expect(headers.get("authorization")).toBeTruthy();
    expect(headers.get("authorization")).not.toContain("matrix_code_session");
  });

  it("returns 500 when sync JWT verification fails unexpectedly", async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    vi.spyOn(syncJwt, "verifySyncJwt").mockRejectedValueOnce(new Error("db unavailable"));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/api/sync/manifest", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clearly-a-token",
      },
    });

    expect(res.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls through to Clerk auth when a Clerk JWT is not a valid Matrix sync JWT", async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    const joseAuthError = Object.assign(new Error('"alg" (Algorithm) Header Parameter value not allowed'), {
      name: "JOSEAlgNotAllowed",
      code: "ERR_JOSE_ALG_NOT_ALLOWED",
    });
    vi.spyOn(syncJwt, "verifySyncJwt").mockRejectedValueOnce(joseAuthError);
    const verifyToken = vi.fn().mockResolvedValue({ sub: "user_alice" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({ verifyToken }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/api/apps", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session-jwt",
      },
    });

    expect(res.status).toBe(200);
    expect(verifyToken).toHaveBeenCalledWith("clerk-session-jwt");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("reports customer VPS release status for operators", async () => {
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff113",
      clerkUserId: "user_alice",
      handle: "alice",
      status: "running",
      hetznerServerId: 123457,
      publicIPv4: "203.0.113.11",
      imageVersion: "matrix-os-host-dev",
      provisionedAt: "2026-04-26T12:00:00.000Z",
      lastSeenAt: "2026-05-06T20:00:00.000Z",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        startedAt: "2026-05-06T21:16:29.650Z",
        release: {
          version: "matrix-os-host-dev",
          gitCommit: "a5a894cabe71a0379a877414414d865a01ecf440",
          buildTime: "2026-05-06T20:49:48Z",
        },
      }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/vps/releases", {
      headers: {
        authorization: "Bearer platform-secret-123",
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.machines).toEqual(expect.arrayContaining([
      expect.objectContaining({
        handle: "alice",
        release: expect.objectContaining({
          reachable: true,
          release: expect.objectContaining({
            gitCommit: "a5a894cabe71a0379a877414414d865a01ecf440",
          }),
        }),
      }),
    ]));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://203.0.113.11:443/api/system/info");
    expect((init?.headers as Headers).get("authorization")).toBeTruthy();
    expect((init?.headers as Headers).get("host")).toBe("app.matrix-os.com");
    expect((init?.headers as Headers).get("x-forwarded-host")).toBe("app.matrix-os.com");
  });

  it("requires authentication before proxying code-domain editor static assets", async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("asset", {
        status: 200,
        headers: {
          "content-type": "text/javascript",
          "cache-control": "public, max-age=31536000",
        },
      }),
    );
    const verifyToken = vi.fn().mockResolvedValue({ authenticated: false });
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken,
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request(
      "/stable-abc123/static/out/vs/editor/common/services/editorWebWorkerMain.js",
      {
        headers: {
          host: "code.matrix-os.com",
        },
      },
    );

    expect(res.status).toBe(401);
    expect(await res.text()).toBe("Unauthorized");
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.get("cdn-cache-control")).toBe("no-store");
    expect(res.headers.get("cloudflare-cdn-cache-control")).toBe("no-store");
    expect(verifyToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires authentication before serving app-domain shell static assets", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("asset", {
        status: 200,
        headers: {
          "content-type": "text/javascript",
          "cache-control": "public, max-age=31536000",
        },
      }),
    );
    const verifyToken = vi.fn().mockResolvedValue({ authenticated: false });
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken,
      }),
      platformSecret: "platform-secret-123",
    });

    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_123";
    try {
      const res = await app.request("/_next/static/chunks/app.js", {
        headers: {
          host: "app.matrix-os.com",
        },
      });

      expect(res.status).toBe(401);
      expect(await res.text()).toBe("Unauthorized");
      expect(res.headers.get("content-type")).not.toContain("text/html");
      expect(res.headers.get("cache-control")).toBe("no-store, private");
      expect(res.headers.get("cdn-cache-control")).toBe("no-store");
      expect(res.headers.get("cloudflare-cdn-cache-control")).toBe("no-store");
      expect(verifyToken).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    }
  });

  it("routes app-domain shell static assets with the short-lived shell route cookie", async () => {
    await insertUserMachine(db, {
      machineId: "machine-alice",
      clerkUserId: "user_alice",
      handle: "alice",
      hetznerServerId: 123,
      publicIPv4: "203.0.113.11",
      status: "running",
      imageVersion: "matrix-os-host-dev",
      provisionedAt: "2026-05-06T00:00:00.000Z",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("asset", {
        status: 200,
        headers: {
          "content-encoding": "gzip",
          "content-length": "999",
          "content-type": "text/javascript",
        },
      }),
    );
    const verifyToken = vi.fn().mockResolvedValue({ authenticated: false });
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken,
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/_next/static/chunks/app.js", {
      headers: {
        host: "app.matrix-os.com",
        cookie: "matrix_shell_route=alice",
      },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("asset");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://203.0.113.11:443/_next/static/chunks/app.js");
    const headers = init?.headers as Headers;
    expect(headers.get("authorization")).toBeTruthy();
    expect(headers.get("x-platform-user-id")).toBe("user_alice");
    expect(headers.get("x-platform-verified")).toBeNull();
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("content-length")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("cdn-cache-control")).toBe("no-store");
    expect(res.headers.get("cloudflare-cdn-cache-control")).toBe("no-store");
    expect(res.headers.get("vary")).toContain("Cookie");
    expect(res.headers.get("vary")).toContain("Accept-Encoding");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("routes app-domain manifest assets with the short-lived shell route cookie", async () => {
    await insertUserMachine(db, {
      machineId: "machine-alice",
      clerkUserId: "user_alice",
      handle: "alice",
      hetznerServerId: 123,
      publicIPv4: "203.0.113.11",
      status: "running",
      imageVersion: "matrix-os-host-dev",
      provisionedAt: "2026-05-06T00:00:00.000Z",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('{"name":"Matrix OS"}', {
        status: 200,
        headers: {
          "content-type": "application/manifest+json",
        },
      }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/manifest.json", {
      headers: {
        host: "app.matrix-os.com",
        cookie: "matrix_shell_route=alice",
      },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"name":"Matrix OS"}');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://203.0.113.11:443/manifest.json");
    const headers = init?.headers as Headers;
    expect(headers.get("authorization")).toBeTruthy();
    expect(headers.get("x-platform-user-id")).toBe("user_alice");
    expect(headers.get("x-platform-verified")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("cdn-cache-control")).toBe("no-store");
    expect(res.headers.get("cloudflare-cdn-cache-control")).toBe("no-store");
    expect(res.headers.get("vary")).toContain("Cookie");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("marks the code-domain auth page as non-cacheable", async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ authenticated: false }),
      }),
      platformSecret: "platform-secret-123",
    });

    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_123";
    try {
      const res = await app.request("/", {
        headers: {
          host: "code.matrix-os.com",
        },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("cache-control")).toBe("no-store, private");
    } finally {
      delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    }
  });

  it("adds a timeout and strips admin credentials on /proxy/:handle fetches", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/proxy/alice/api/ping", {
      headers: { authorization: "Bearer platform-secret-123" },
    });

    expect(res.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.redirect).toBe("manual");
    const headers = init?.headers as Headers;
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("cookie")).toBeNull();
  });

  it("allows operator /proxy/:handle access to a running VPS when user entitlement denies access", async () => {
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff128",
      clerkUserId: "user_alice",
      handle: "alice",
      status: "running",
      hetznerServerId: 123472,
      publicIPv4: "203.0.113.28",
      imageVersion: "matrix-os-host-2026.04.26-1",
      provisionedAt: "2026-04-26T12:00:00.000Z",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      platformSecret: "platform-secret-123",
      env: { MATRIX_PAID_BETA_ENTITLEMENT_STATUS: "expired" } as NodeJS.ProcessEnv,
    });

    const res = await app.request("/proxy/alice/api/ping", {
      headers: { authorization: "Bearer platform-secret-123" },
    });

    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://203.0.113.28:443/api/ping");
  });

  it("rejects invalid /proxy/:handle values before DNS interpolation", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/proxy/bad_handle/api/ping", {
      headers: { authorization: "Bearer platform-secret-123" },
    });

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("logs and returns 502 when the app-domain container proxy fetch fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("upstream exploded"))
      .mockRejectedValueOnce(new TypeError("fetch failed"));
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/api/ping", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Container unreachable" });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[platform] app-domain proxy retry attempt=1 handle=alice"),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[platform] app-domain proxy retry attempt=2 handle=alice"),
    );
    expect(errorSpy).toHaveBeenCalledWith("[platform] app-domain proxy failed:", "fetch failed");
  });

  it("re-resolves the live container endpoint and retries the proxy request", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const docker = stubDocker({ id: "docker-ctr-2", ipAddress: "172.18.0.55" });
    const app = createApp({
      db,
      docker,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/api/ping", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://172.18.0.55:4000/api/ping");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("http://172.18.0.55:4000/api/ping");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[platform] app-domain proxy retry attempt=1 handle=alice"),
    );
    expect((await getContainer(db, "alice"))?.containerId).toBe("docker-ctr-2");
  });
});
