import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { PlatformDB } from "../../packages/platform/src/db.js";
import {
  deleteContainer,
  insertUserMachine,
  upsertBillingEntitlement,
} from "../../packages/platform/src/db.js";
import {
  buildPlatformWebSocketUpgradeHeaders,
  classifySessionRoutedHost,
  classifyWebSocketPath,
  createApp,
  getTrustedSessionRoutedWebSocketHost,
} from "../../packages/platform/src/main.js";
import { createClerkAuth } from "../../packages/platform/src/clerk-auth.js";
import { issueSyncJwt } from "../../packages/platform/src/sync-jwt.js";
import { buildPlatformVerificationToken } from "../../packages/platform/src/platform-token.js";
import {
  JWT_SECRET,
  cleanupProxyRoutingTest,
  setupProxyRoutingTest,
  stubOrchestrator,
} from "./proxy-routing-test-utils.js";

describe("platform proxy routing billing and provisioning", () => {
  let db: PlatformDB;

  beforeEach(async () => {
    db = await setupProxyRoutingTest();
  });

  afterEach(async () => {
    await cleanupProxyRoutingTest(db);
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

  it("serves platform billing status for native desktop sync-JWT callers", async () => {
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
    const issued = await issueSyncJwt({
      secret: JWT_SECRET,
      clerkUserId: "user_alice",
      handle: "alice",
      gatewayUrl: "https://app.matrix-os.com",
      runtimeSlot: "primary",
    });
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("wrong target", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockRejectedValue(new Error("not a Clerk token")),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/billing/status", {
      headers: {
        host: "app.matrix-os.com",
        authorization: `Bearer ${issued.token}`,
      },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      entitlement: { planSlug: "matrix_builder" },
      access: { runtimeProxyAllowed: true },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serves platform billing status for app-shell session cookie callers", async () => {
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
    const issued = await issueSyncJwt({
      secret: JWT_SECRET,
      clerkUserId: "user_alice",
      handle: "alice",
      gatewayUrl: "https://app.matrix-os.com",
      runtimeSlot: "primary",
    });
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("wrong target", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockRejectedValue(new Error("missing Clerk token")),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/billing/status", {
      headers: {
        host: "app.matrix-os.com",
        cookie: `matrix_app_session=${encodeURIComponent(issued.token)}`,
      },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      entitlement: { planSlug: "matrix_builder" },
      access: { runtimeProxyAllowed: true },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not authorize billing routes with per-app session cookies", async () => {
    const issued = await issueSyncJwt({
      secret: JWT_SECRET,
      clerkUserId: "user_alice",
      handle: "alice",
      gatewayUrl: "https://app.matrix-os.com",
      runtimeSlot: "primary",
    });
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockRejectedValue(new Error("missing Clerk token")),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/billing/status", {
      headers: {
        host: "app.matrix-os.com",
        cookie: `matrix_app_session__calculator=${encodeURIComponent(issued.token)}`,
      },
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("x-auth-failure")).toBeNull();
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("returns unauthorized for invalid app-shell session cookies on billing routes", async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockRejectedValue(new Error("missing Clerk token")),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/billing/status", {
      headers: {
        host: "app.matrix-os.com",
        cookie: "matrix_app_session=not-a-sync-jwt",
      },
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("x-auth-failure")).toBe("app-session-stale");
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("returns generic unauthorized for expired app-shell session cookies on billing routes", async () => {
    const issued = await issueSyncJwt({
      secret: JWT_SECRET,
      clerkUserId: "user_alice",
      handle: "alice",
      gatewayUrl: "https://app.matrix-os.com",
      runtimeSlot: "primary",
      expiresInSec: -120,
    });
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockRejectedValue(new Error("missing Clerk token")),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/billing/status", {
      headers: {
        host: "app.matrix-os.com",
        cookie: `matrix_app_session=${encodeURIComponent(issued.token)}`,
      },
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("x-auth-failure")).toBe("app-session-stale");
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("uses the raw bearer sync JWT for native billing fallback when a stale Clerk cookie is present", async () => {
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
    const issued = await issueSyncJwt({
      secret: JWT_SECRET,
      clerkUserId: "user_alice",
      handle: "alice",
      gatewayUrl: "https://app.matrix-os.com",
      runtimeSlot: "primary",
    });
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("wrong target", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: {
        extractToken: vi.fn((_authorization, cookie) => (cookie ? "stale-clerk-cookie" : null)),
        verify: vi.fn().mockResolvedValue({ authenticated: false }),
        verifyAndMatchOwner: vi.fn(),
        revokeSession: vi.fn(),
        isPublicPath: vi.fn(() => false),
      },
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/billing/status", {
      headers: {
        host: "app.matrix-os.com",
        authorization: `Bearer ${issued.token}`,
        cookie: "__session=stale-clerk-cookie",
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
    expect(await res.json()).toEqual({
      error: "Billing unavailable",
      code: "billing_unavailable",
    });
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

  it("requires the edge secret before websocket routing trusts x-forwarded-host", () => {
    const cloudRunHost = "matrix-platform-jqxkjdhtkq-ey.a.run.app";

    expect(
      getTrustedSessionRoutedWebSocketHost(
        cloudRunHost,
        "code.matrix-os.com",
        undefined,
        "edge-secret",
        "/ws?token=secret",
      ),
    ).toBe(cloudRunHost);
    expect(
      getTrustedSessionRoutedWebSocketHost(
        cloudRunHost,
        "code.matrix-os.com",
        "wrong-secret",
        "edge-secret",
        "/ws?token=secret",
      ),
    ).toBe(cloudRunHost);
    expect(
      getTrustedSessionRoutedWebSocketHost(
        cloudRunHost,
        "code.matrix-os.com",
        "edge-secret",
        "edge-secret",
        "/ws?token=secret",
      ),
    ).toBe("code.matrix-os.com");
  });

  it("keeps token-authenticated websocket fallback for internal platform hosts", () => {
    expect(
      getTrustedSessionRoutedWebSocketHost(
        "platform:9000",
        undefined,
        undefined,
        "edge-secret",
        "/ws?token=secret",
      ),
    ).toBe("app.matrix-os.com");
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
});
