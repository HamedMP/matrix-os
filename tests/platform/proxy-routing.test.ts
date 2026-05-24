import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { type PlatformDB, deleteContainer, getContainer, insertContainer, insertUserMachine } from "../../packages/platform/src/db.js";
import { createApp } from "../../packages/platform/src/main.js";
import type { Orchestrator } from "../../packages/platform/src/orchestrator.js";
import { createClerkAuth } from "../../packages/platform/src/clerk-auth.js";
import { issueSyncJwt } from "../../packages/platform/src/sync-jwt.js";
import * as syncJwt from "../../packages/platform/src/sync-jwt.js";
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

  it("routes Clerk sessions to the selected staging VPS slot", async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    await deleteContainer(db, "alice");
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff124",
      clerkUserId: "user_alice",
      handle: "alice-staging",
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

    const res = await app.request("/?runtime=staging", {
      headers: {
        host: "code.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("editor");
    expect(docker.getContainer).not.toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://203.0.113.22:443/?runtime=staging");
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

  it("persists the selected runtime slot while a staging VPS is booting", async () => {
    await deleteContainer(db, "alice");
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff125",
      clerkUserId: "user_alice",
      handle: "alice-staging",
      runtimeSlot: "staging",
      status: "provisioning",
      hetznerServerId: 123469,
      publicIPv4: null,
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

    const res = await app.request("/?runtime=staging", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(res.status).toBe(503);
    expect(res.headers.get("set-cookie")).toContain("matrix_runtime_slot=staging");

    const followUp = await app.request("/", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
        cookie: "matrix_runtime_slot=staging",
      },
    });

    expect(followUp.status).toBe(503);
    expect(followUp.headers.get("set-cookie")).toContain("matrix_runtime_slot=staging");
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
