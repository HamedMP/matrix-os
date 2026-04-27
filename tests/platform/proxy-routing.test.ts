import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
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
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
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
