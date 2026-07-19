import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import {
  type PlatformDB,
  deleteContainer,
  ensurePlatformUser,
  getContainer,
  getPlatformUserByClerkId,
  insertCheckoutAttempt,
  insertUserMachine,
  updateContainerStatus,
  upsertBillingEntitlement,
} from "../../packages/platform/src/db.js";
import {
  buildPostAuthRedirectPath,
  createApp,
  escapeInlineScriptJson,
} from "../../packages/platform/src/main.js";
import { createClerkAuth } from "../../packages/platform/src/clerk-auth.js";
import { buildBillingSetupTarget } from "../../packages/platform/src/auth-pages.js";
import { issueSyncJwt } from "../../packages/platform/src/sync-jwt.js";
import * as syncJwt from "../../packages/platform/src/sync-jwt.js";
import type { CustomerVpsService } from "../../packages/platform/src/customer-vps.js";
import {
  JWT_SECRET,
  cleanupProxyRoutingTest,
  combinedSetCookie,
  cookieHeaderFromSetCookie,
  expectedFallbackProvisionHandle,
  setupProxyRoutingTest,
  stubDocker,
  stubOrchestrator,
} from "./proxy-routing-test-utils.js";

describe("platform proxy routing", () => {
  let db: PlatformDB;

  beforeEach(async () => {
    db = await setupProxyRoutingTest();
  });

  afterEach(async () => {
    await cleanupProxyRoutingTest(db);
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
    expect(buildPostAuthRedirectPath("https://app.matrix-os.com/sign-up/verify-email-address?session=secret")).toBe("/");
    expect(buildPostAuthRedirectPath("https://app.matrix-os.com/sign-in/sso-callback?runtime=staging&session=secret")).toBe(
      "/?runtime=staging",
    );
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
        "x-matrix-native-app-session": "1",
        "x-matrix-platform-session": "native",
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
    expect(headers.get("x-matrix-native-app-session")).toBeNull();
    expect(headers.get("x-matrix-platform-session")).toBeNull();
    expect(res.headers.get("set-cookie") ?? "").not.toContain("matrix_shell_route=");
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

  it("routes sync JWT bearer requests through app.matrix-os.com to the matching container", async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
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

  it("routes sandboxed srcdoc Vite app assets with null-origin CORS through the shell route cookie", async () => {
    await insertUserMachine(db, {
      machineId: "machine-alice-vite-asset",
      clerkUserId: "user_alice",
      handle: "alice",
      hetznerServerId: 127,
      publicIPv4: "203.0.113.15",
      status: "running",
      imageVersion: "matrix-os-host-dev",
      provisionedAt: "2026-05-06T00:00:00.000Z",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("console.log('chess')", {
        status: 200,
        headers: {
          "content-type": "application/javascript",
          vary: "Accept-Encoding",
        },
      }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/apps/chess/assets/index.js", {
      headers: {
        host: "app.matrix-os.com",
        origin: "null",
        cookie: "matrix_shell_route=alice",
      },
    });

    expect(res.status).toBe(200);
    const [assetUrl, assetInit] = fetchMock.mock.calls[0]!;
    expect(assetUrl).toBe("https://203.0.113.15:443/apps/chess/assets/index.js");
    const assetHeaders = assetInit?.headers as Headers;
    expect(assetHeaders.get("origin")).toBe("null");
    expect(assetHeaders.get("accept-encoding")).toBe("identity");
    expect(assetHeaders.get("cookie")).toBeNull();
    expect(res.headers.get("access-control-allow-origin")).toBe("null");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(res.headers.get("vary")).toContain("Origin");
    expect(res.headers.get("vary")).toContain("Cookie");
    expect(res.headers.get("vary")).toContain("Accept-Encoding");
  });

  it("rewrites proxied Vite app HTML to signed explicit VM asset URLs for srcdoc iframes", async () => {
    await insertUserMachine(db, {
      machineId: "machine-alice-vite-html",
      clerkUserId: "user_alice",
      handle: "alice",
      hetznerServerId: 128,
      publicIPv4: "203.0.113.16",
      status: "running",
      imageVersion: "matrix-os-host-dev",
      provisionedAt: "2026-05-06T00:00:00.000Z",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        '<!doctype html><script>const fixture = \'src="./assets/not-a-real-import.js"\';</script><script type="module" src="./assets/index.js"></script><link rel="stylesheet" href="./assets/index.css">',
        {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
        },
      ),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/apps/chess/", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://203.0.113.16:443/apps/chess/");
    const html = await res.text();
    expect(html).toMatch(/src="\/vm\/alice\/apps\/chess\/assets\/index\.js\?matrix_asset_token=[^"]+"/);
    expect(html).toMatch(/href="\/vm\/alice\/apps\/chess\/assets\/index\.css\?matrix_asset_token=[^"]+"/);
    expect(html).toContain('src="./assets/not-a-real-import.js"');
    expect(res.headers.get("set-cookie")).toContain("matrix_shell_route=alice");
    expect(res.headers.get("set-cookie")).toContain("SameSite=Lax");
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

  it("logs sanitized VPS upstream 5xx metadata for code-domain routing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await deleteContainer(db, "alice");
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff116",
      clerkUserId: "user_alice",
      handle: "alice",
      runtimeSlot: "primary",
      status: "running",
      hetznerServerId: 123460,
      publicIPv4: "203.0.113.14",
      imageVersion: "matrix-os-host-2026.04.26-1",
      provisionedAt: "2026-04-26T12:00:00.000Z",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Editor unavailable", { status: 502 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/?folder=/home/matrix/home", {
      headers: {
        host: "code.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(res.status).toBe(502);
    expect(await res.text()).toBe("Editor unavailable");
    expect(warnSpy).toHaveBeenCalledWith(
      "[platform] code-domain vps upstream 5xx handle=alice runtimeSlot=primary publicIPv4=203.0.113.14 path=\"/\" status=502",
    );
    expect(warnSpy.mock.calls.join("\n")).not.toContain("clerk-session");
    expect(warnSpy.mock.calls.join("\n")).not.toContain("platform-secret-123");
    expect(warnSpy.mock.calls.join("\n")).not.toContain("folder=/home/matrix/home");
  });

  it("does not log code-domain upstream metadata for successful VPS responses", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await deleteContainer(db, "alice");
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff117",
      clerkUserId: "user_alice",
      handle: "alice",
      runtimeSlot: "primary",
      status: "running",
      hetznerServerId: 123461,
      publicIPv4: "203.0.113.15",
      imageVersion: "matrix-os-host-2026.04.26-1",
      provisionedAt: "2026-04-26T12:00:00.000Z",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
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
    expect(await res.text()).toBe("editor");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("routes stale legacy-container users to billing setup in VPS-native mode", async () => {
    await updateContainerStatus(db, "alice", "stopped", "stale-container-id");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("auth shell billing", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
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
        AUTH_SHELL_HOST: "auth-shell.test",
        AUTH_SHELL_PORT: "3200",
        // VPS-native routing wins over the legacy env flag when customerVpsService is configured.
        MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED: "true",
      } as NodeJS.ProcessEnv,
    });

    const res = await app.request("/?billing=setup", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toBe("auth shell billing");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://auth-shell.test:3200/?billing=setup");
    expect(html).not.toContain("Preparing Matrix OS");
    expect(html).not.toContain('http-equiv="refresh"');
    expect(html).not.toContain("Failed to wake container");
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
    expect(res.headers.get("content-security-policy")).toContain("worker-src 'self' blob:");
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(res.headers.get("content-security-policy")).toContain("https://challenges.cloudflare.com");
    expect(res.headers.get("content-security-policy")).toContain("frame-src https://challenges.cloudflare.com");
    expect(res.headers.get("set-cookie") ?? "").not.toContain("matrix_runtime_slot=");
    const html = await res.text();
    expect(html).toContain('fallbackRedirectUrl: redirectTarget');
    expect(html).toContain('forceRedirectUrl: redirectTarget');
    expect(html).toContain('signInForceRedirectUrl: redirectTarget');
    expect(html).toContain('signUpForceRedirectUrl: redirectTarget');
    expect(html).not.toContain('afterSignInUrl');
    expect(html).toContain('var redirectTarget = "/?runtime=staging";');
    expect(html).toContain('var signOutTarget = "/sign-in";');
    expect(html).toContain("continueWithClerkSession");
    expect(html).toContain("fetch('/api/auth/app-session'");
    expect(html).toContain("if (res.status === 402) {");
    expect(html).toContain("openBillingSettingsFromClerkSession();");
    expect(html).toContain("function clerkSignOutWithTimeout()");
    expect(html).toContain("var SIGN_OUT_TIMEOUT_MS = 10000;");
    expect(html).toContain("window.setTimeout(function() {");
    expect(html).toContain("}, SIGN_OUT_TIMEOUT_MS);");
    expect(html).toContain("if (timeoutId !== undefined) window.clearTimeout(timeoutId);");
    expect(html).toContain("window.location.replace(signOutTarget)");
    expect(html).toContain("[matrix] Clerk.signOut did not finish");
    expect(html).not.toContain("window.location.replace(redirectTarget)");
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
    expect(html).toContain("fallbackRedirectUrl: redirectTarget");
    expect(html).toContain('var signOutTarget = "/sign-in";');
    expect(html).not.toContain("Choose a Matrix OS machine");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps signed-in sign-out routing on the sign-up page", async () => {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_matrix";
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue(null),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/sign-up", {
      headers: { host: "app.matrix-os.com" },
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('var signOutTarget = "/sign-up";');
  });

  it("exchanges a browser Clerk token for an app session cookie before continuing", async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    await deleteContainer(db, "alice");
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff138",
      clerkUserId: "user_alice",
      handle: "alice",
      runtimeSlot: "primary",
      status: "running",
      hetznerServerId: 123482,
      publicIPv4: "203.0.113.33",
      imageVersion: "matrix-os-host-2026.05.31-1",
      serverType: "cpx22",
      provisionedAt: "2026-05-31T12:00:00.000Z",
    });
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff140",
      clerkUserId: "user_alice",
      handle: "alice-staging",
      runtimeSlot: "staging",
      status: "running",
      hetznerServerId: 123484,
      publicIPv4: "203.0.113.35",
      imageVersion: "matrix-os-host-2026.05.31-1",
      serverType: "cpx22",
      provisionedAt: "2026-05-31T12:05:00.000Z",
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

    const exchange = await app.request("/api/auth/app-session", {
      method: "POST",
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({ redirectTo: "/runtime?runtime=staging" }),
    });

    expect(exchange.status).toBe(200);
    await expect(exchange.json()).resolves.toEqual({ redirectTo: "/runtime?runtime=staging" });
    const setCookie = combinedSetCookie(exchange.headers);
    expect(setCookie).toContain("matrix_app_session=");
    expect(setCookie).toContain("matrix_native_app_session=;");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");

    const appSession = setCookie?.split(";", 1)[0] ?? "";
    const shell = await app.request("/", {
      headers: {
        host: "app.matrix-os.com",
        cookie: appSession,
      },
    });

    expect(shell.status).toBe(200);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://203.0.113.35:443/");
    const browserForwardHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers as HeadersInit);
    expect(browserForwardHeaders.get("x-matrix-native-app-session")).toBeNull();
    expect(browserForwardHeaders.get("x-matrix-platform-session")).toBeNull();
  });

  it("issues an app session for a collaborator whose only accessible runtime is a preview", async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    await deleteContainer(db, "alice");
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff141",
      clerkUserId: "user_bob",
      handle: "pr-1055",
      runtimeSlot: "pr-1055",
      provisioningClass: "preview",
      accessClerkUserIds: ["user_alice"],
      status: "running",
      hetznerServerId: 123485,
      publicIPv4: "203.0.113.55",
      imageVersion: "v2026.07.19-pr1055",
      serverType: "cpx22",
      provisionedAt: "2026-07-19T12:00:00.000Z",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("shared preview", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const exchange = await app.request("/api/auth/app-session", {
      method: "POST",
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({ redirectTo: "/vm/pr-1055" }),
    });

    expect(exchange.status).toBe(200);
    await expect(exchange.json()).resolves.toEqual({ redirectTo: "/vm/pr-1055" });
    const appSession = cookieHeaderFromSetCookie(exchange.headers, ["matrix_app_session"]);
    const shell = await app.request("/vm/pr-1055", {
      headers: {
        host: "app.matrix-os.com",
        cookie: appSession,
      },
    });

    expect(shell.status).toBe(200);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://203.0.113.55:443/");
    const forwardedHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers as HeadersInit);
    expect(forwardedHeaders.get("x-platform-user-id")).toBe("user_alice");
    expect(forwardedHeaders.get("x-platform-verified")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("exchanges a native sync JWT for an app session cookie before continuing", async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    const issued = await issueSyncJwt({
      secret: JWT_SECRET,
      clerkUserId: "user_alice",
      handle: "alice",
      gatewayUrl: "https://alice.matrix-os.com",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("shell", { status: 200 }),
    );
    const verifyToken = vi.fn().mockResolvedValue(null);
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({ verifyToken }),
      platformSecret: "platform-secret-123",
    });

    const exchange = await app.request("/api/auth/app-session", {
      method: "POST",
      headers: {
        host: "app.matrix-os.com",
        authorization: `Bearer ${issued.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ redirectTo: "/" }),
    });

    expect(exchange.status).toBe(200);
    await expect(exchange.json()).resolves.toEqual({ redirectTo: "/" });
    const setCookie = combinedSetCookie(exchange.headers);
    expect(setCookie).toContain("matrix_app_session=");
    expect(setCookie).toContain("matrix_native_app_session=");
    expect(setCookie).toContain(encodeURIComponent(issued.token));
    expect(verifyToken).not.toHaveBeenCalled();

    const appSession = cookieHeaderFromSetCookie(exchange.headers, [
      "matrix_app_session",
      "matrix_native_app_session",
    ]);
    const shell = await app.request("/", {
      headers: {
        host: "app.matrix-os.com",
        cookie: appSession,
      },
    });

    expect(shell.status).toBe(200);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://matrixos-alice:3000/");
    const nativeForwardHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers as HeadersInit);
    expect(nativeForwardHeaders.get("x-matrix-native-app-session")).toBe("1");
    expect(nativeForwardHeaders.get("x-matrix-platform-session")).toBeNull();
  });

  it("marks native app sessions behind Cloud Run forwarded-host routing", async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    const issued = await issueSyncJwt({
      secret: JWT_SECRET,
      clerkUserId: "user_alice",
      handle: "alice",
      gatewayUrl: "https://alice.matrix-os.com",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("shell", { status: 200 }),
    );
    const app = createApp({
      db,
      env: { ...process.env, EDGE_ROUTER_SECRET: "edge-secret" },
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue(null),
      }),
      platformSecret: "platform-secret-123",
    });

    const exchange = await app.request("/api/auth/app-session", {
      method: "POST",
      headers: {
        host: "matrix-platform-jqxkjdhtkq-ey.a.run.app",
        "x-forwarded-host": "app.matrix-os.com",
        "x-matrix-edge-secret": "edge-secret",
        authorization: `Bearer ${issued.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ redirectTo: "/" }),
    });

    expect(exchange.status).toBe(200);
    const appSession = cookieHeaderFromSetCookie(exchange.headers, [
      "matrix_app_session",
      "matrix_native_app_session",
    ]);
    const shell = await app.request("/", {
      headers: {
        host: "matrix-platform-jqxkjdhtkq-ey.a.run.app",
        "x-forwarded-host": "app.matrix-os.com",
        "x-matrix-edge-secret": "edge-secret",
        cookie: appSession,
      },
    });

    expect(shell.status).toBe(200);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://matrixos-alice:3000/");
    const nativeForwardHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers as HeadersInit);
    expect(nativeForwardHeaders.get("x-matrix-native-app-session")).toBe("1");
    expect(nativeForwardHeaders.get("x-platform-user-id")).toBe("user_alice");
    expect(nativeForwardHeaders.get("x-matrix-edge-secret")).toBeNull();
  });

  it("marks native app sessions on customer VPS routing behind Cloud Run", async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    await deleteContainer(db, "alice");
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff159",
      clerkUserId: "user_alice",
      handle: "alice",
      status: "running",
      hetznerServerId: 123459,
      publicIPv4: "203.0.113.59",
      imageVersion: "matrix-os-host-2026.06.08-1",
      provisionedAt: "2026-06-08T12:00:00.000Z",
    });
    const issued = await issueSyncJwt({
      secret: JWT_SECRET,
      clerkUserId: "user_alice",
      handle: "alice",
      gatewayUrl: "https://alice.matrix-os.com",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("shell", { status: 200 }),
    );
    const app = createApp({
      db,
      env: { ...process.env, EDGE_ROUTER_SECRET: "edge-secret" },
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue(null),
      }),
      platformSecret: "platform-secret-123",
    });

    const exchange = await app.request("/api/auth/app-session", {
      method: "POST",
      headers: {
        host: "matrix-platform-jqxkjdhtkq-ey.a.run.app",
        "x-forwarded-host": "app.matrix-os.com",
        "x-matrix-edge-secret": "edge-secret",
        authorization: `Bearer ${issued.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ redirectTo: "/" }),
    });

    expect(exchange.status).toBe(200);
    const appSession = cookieHeaderFromSetCookie(exchange.headers, [
      "matrix_app_session",
      "matrix_native_app_session",
    ]);
    const shell = await app.request("/", {
      headers: {
        host: "matrix-platform-jqxkjdhtkq-ey.a.run.app",
        "x-forwarded-host": "app.matrix-os.com",
        "x-matrix-edge-secret": "edge-secret",
        cookie: appSession,
      },
    });

    expect(shell.status).toBe(200);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://203.0.113.59:443/");
    const nativeForwardHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers as HeadersInit);
    expect(nativeForwardHeaders.get("x-matrix-native-app-session")).toBe("1");
    expect(nativeForwardHeaders.get("x-platform-user-id")).toBe("user_alice");
    expect(nativeForwardHeaders.get("x-forwarded-host")).toBe("app.matrix-os.com");
    expect(nativeForwardHeaders.get("x-matrix-edge-secret")).toBeNull();
  });

  it("uses x-forwarded-host for app-domain routing behind Cloud Run", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("shell", { status: 200 }),
    );
    const app = createApp({
      db,
      env: { ...process.env, EDGE_ROUTER_SECRET: "edge-secret" },
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/", {
      headers: {
        host: "matrix-platform-jqxkjdhtkq-ey.a.run.app",
        "x-forwarded-host": "app.matrix-os.com",
        "x-matrix-edge-secret": "edge-secret",
        authorization: "Bearer clerk-session",
      },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("shell");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://matrixos-alice:3000/");
    const headers = init?.headers as Headers;
    expect(headers.get("x-forwarded-host")).toBe("app.matrix-os.com");
    expect(headers.get("x-matrix-edge-secret")).toBeNull();
  });

  it("uses x-forwarded-host for code-domain routing behind Cloud Run", async () => {
    await deleteContainer(db, "alice");
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff151",
      clerkUserId: "user_alice",
      handle: "alice",
      status: "running",
      hetznerServerId: 123491,
      publicIPv4: "203.0.113.91",
      imageVersion: "matrix-os-host-2026.06.06-1",
      provisionedAt: "2026-06-06T12:00:00.000Z",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("editor", { status: 200 }),
    );
    const app = createApp({
      db,
      env: { ...process.env, EDGE_ROUTER_SECRET: "edge-secret" },
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/?folder=/home/matrix/home", {
      headers: {
        host: "matrix-platform-jqxkjdhtkq-ey.a.run.app",
        "x-forwarded-host": "code.matrix-os.com",
        "x-matrix-edge-secret": "edge-secret",
        authorization: "Bearer clerk-session",
      },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("editor");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://203.0.113.91:443/?folder=/home/matrix/home");
    const headers = init?.headers as Headers;
    expect(headers.get("host")).toBe("code.matrix-os.com");
    expect(headers.get("x-forwarded-host")).toBe("code.matrix-os.com");
    expect(headers.get("x-matrix-edge-secret")).toBeNull();
  });

  it("does not trust x-forwarded-host for app-domain routing without the edge secret", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("shell", { status: 200 }),
    );
    const app = createApp({
      db,
      env: { ...process.env, EDGE_ROUTER_SECRET: "edge-secret" },
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/", {
      headers: {
        host: "matrix-platform-jqxkjdhtkq-ey.a.run.app",
        "x-forwarded-host": "app.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.status).not.toBe(200);
  });

  it("reports no runtime when a signed-in Clerk user has no Matrix computer", async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    await deleteContainer(db, "alice");
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_new" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const exchange = await app.request("/api/auth/app-session", {
      method: "POST",
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(exchange.status).toBe(404);
    await expect(exchange.json()).resolves.toEqual({
      error: "Matrix computer unavailable",
      code: "no_runtime",
    });
    const setCookie = combinedSetCookie(exchange.headers);
    expect(setCookie).toContain("matrix_app_session=;");
    expect(setCookie).toContain("matrix_native_app_session=;");
    expect(setCookie).toContain("Max-Age=0");
  });

  it("revokes the current Clerk session and clears Matrix and Clerk cookies on sign-out", async () => {
    const revokeSession = vi.fn().mockResolvedValue(undefined);
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice", sid: "sess_123" }),
        revokeSession,
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/api/auth/app-session", {
      method: "DELETE",
      headers: {
        host: "app.matrix-os.com",
        cookie: [
          "matrix_app_session=matrix-token",
          "__session=clerk-token",
          "__client_uat=123",
          "matrix_shell_route=alice",
          "__session_safeSuffix-123=clerk-token",
          "__client_uat_safeSuffix_456=456",
          "__session_unsafe.suffix=ignored",
          "other=value",
        ].join("; "),
      },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      cleared: true,
      clerkSessionRevoked: true,
    });
    expect(revokeSession).toHaveBeenCalledWith("sess_123");
    const setCookie = combinedSetCookie(res.headers);
    expect(setCookie).toContain("matrix_app_session=;");
    expect(setCookie).toContain("matrix_native_app_session=;");
    expect(setCookie).toContain("matrix_shell_route=;");
    expect(setCookie).toContain("__session=;");
    expect(setCookie).toContain("__client_uat=;");
    expect(setCookie).toContain("__session_safeSuffix-123=;");
    expect(setCookie).toContain("__client_uat_safeSuffix_456=;");
    expect(setCookie).not.toContain("__session_unsafe.suffix=;");
    expect(setCookie).toContain("Domain=matrix-os.com");
  });

  it("returns generic sign-out success and clears cookies when Clerk revoke fails", async () => {
    const errorSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice", sid: "sess_123" }),
        revokeSession: vi.fn().mockRejectedValue(new Error("provider exploded")),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/api/auth/app-session", {
      method: "DELETE",
      headers: {
        host: "app.matrix-os.com",
        cookie: "matrix_app_session=matrix-token; __session=clerk-token; __client_uat=123",
      },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      cleared: true,
      clerkSessionRevoked: false,
    });
    const setCookie = combinedSetCookie(res.headers);
    expect(setCookie).toContain("matrix_app_session=;");
    expect(setCookie).toContain("matrix_native_app_session=;");
    expect(setCookie).toContain("__session=;");
    expect(setCookie).toContain("__client_uat=;");
    expect(errorSpy).toHaveBeenCalledWith("[auth/app-session] Clerk session revoke failed", "Error");
  });

  it("logs Clerk revoke timeouts specifically while returning generic sign-out success", async () => {
    const errorSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const timeoutError = new Error("operation timed out");
    timeoutError.name = "TimeoutError";
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice", sid: "sess_123" }),
        revokeSession: vi.fn().mockRejectedValue(timeoutError),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/api/auth/app-session", {
      method: "DELETE",
      headers: {
        host: "app.matrix-os.com",
        cookie: "matrix_app_session=matrix-token; __session=clerk-token",
      },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      cleared: true,
      clerkSessionRevoked: false,
    });
    expect(combinedSetCookie(res.headers)).toContain("__session=;");
    expect(errorSpy).toHaveBeenCalledWith(
      "[auth/app-session] Clerk session revoke timed out",
      "TimeoutError",
    );
  });

  it("lets a signed-in checkout return start hosted runtime provisioning without admin credentials", async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    await deleteContainer(db, "alice");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        username: "newuser",
        first_name: "New",
        last_name: "User",
        primary_email_address_id: "email_1",
        email_addresses: [{ id: "email_1", email_address: "new@example.com" }],
      }),
    );
    const customerVpsService = {
      provision: vi.fn().mockResolvedValue({
        machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff150",
        status: "provisioning",
        etaSeconds: 90,
      }),
    };
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_new" }),
      }),
      platformSecret: "platform-secret-123",
      customerVpsService: customerVpsService as unknown as CustomerVpsService,
      env: { ...process.env, CLERK_SECRET_KEY: "sk_test_matrix" },
    });

    const provision = await app.request("/api/auth/provision-runtime", {
      method: "POST",
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(provision.status).toBe(202);
    await expect(provision.json()).resolves.toEqual({
      runtime: "customer_vps",
      handle: "newuser",
      clerkUserId: "user_new",
      runtimeSlot: "primary",
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff150",
      status: "provisioning",
      etaSeconds: 90,
    });
    expect(customerVpsService.provision).toHaveBeenCalledWith({
      handle: "newuser",
      clerkUserId: "user_new",
      runtimeSlot: "primary",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.clerk.com/v1/users/user_new",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer sk_test_matrix",
          accept: "application/json",
        }),
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );
    await expect(getPlatformUserByClerkId(db, "user_new")).resolves.toMatchObject({
      clerkId: "user_new",
      handle: "newuser",
      displayName: "New User",
      email: "new@example.com",
      containerId: "vps:9f05824c-8d0a-4d83-9cb4-b312d43ff150",
    });
  });

  it("passes directly selected developer tools to hosted runtime provisioning", async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    await deleteContainer(db, "alice");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        username: "newuser",
        first_name: "New",
        last_name: "User",
        primary_email_address_id: "email_1",
        email_addresses: [{ id: "email_1", email_address: "new@example.com" }],
      }),
    );
    const customerVpsService = {
      provision: vi.fn().mockResolvedValue({
        machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff150",
        status: "provisioning",
        etaSeconds: 90,
      }),
    };
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_new_tools" }),
      }),
      platformSecret: "platform-secret-123",
      customerVpsService: customerVpsService as unknown as CustomerVpsService,
      env: { ...process.env, CLERK_SECRET_KEY: "sk_test_matrix" },
    });

    const provision = await app.request("/api/auth/provision-runtime", {
      method: "POST",
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({ developerTools: ["opencode", "pi"] }),
    });

    expect(provision.status).toBe(202);
    expect(customerVpsService.provision).toHaveBeenCalledWith({
      handle: "newuser",
      clerkUserId: "user_new_tools",
      runtimeSlot: "primary",
      developerTools: ["opencode", "pi"],
    });
  });

  it("falls back to settling checkout-attempt developer tools when provisioning after payment", async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    await deleteContainer(db, "alice");
    await insertCheckoutAttempt(db, {
      id: "attempt_tools",
      clerkUserId: "user_paid_tools",
      stripeSessionId: "cs_paid_tools",
      status: "paid",
      createdAt: "2026-06-23T12:00:00.000Z",
      developerTools: ["claude-code"],
    });
    await insertCheckoutAttempt(db, {
      id: "attempt_tools_newer_open",
      clerkUserId: "user_paid_tools",
      stripeSessionId: "cs_open_tools",
      status: "open",
      createdAt: "2026-06-23T12:05:00.000Z",
      developerTools: ["opencode", "pi"],
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        username: "newuser",
        first_name: "New",
        last_name: "User",
        primary_email_address_id: "email_1",
        email_addresses: [{ id: "email_1", email_address: "new@example.com" }],
      }),
    );
    const customerVpsService = {
      provision: vi.fn().mockResolvedValue({
        machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff150",
        status: "provisioning",
        etaSeconds: 90,
      }),
    };
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_paid_tools" }),
      }),
      platformSecret: "platform-secret-123",
      customerVpsService: customerVpsService as unknown as CustomerVpsService,
      env: { ...process.env, CLERK_SECRET_KEY: "sk_test_matrix" },
    });

    const provision = await app.request("/api/auth/provision-runtime", {
      method: "POST",
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(provision.status).toBe(202);
    expect(customerVpsService.provision).toHaveBeenCalledWith({
      handle: "newuser",
      clerkUserId: "user_paid_tools",
      runtimeSlot: "primary",
      developerTools: ["claude-code"],
    });
  });

  it("does not block hosted runtime provisioning when Clerk returns an empty avatar URL", async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    await deleteContainer(db, "alice");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        username: "newuser",
        first_name: "New",
        last_name: "User",
        image_url: "",
        primary_email_address_id: "email_1",
        email_addresses: [{ id: "email_1", email_address: "new@example.com" }],
      }),
    );
    const customerVpsService = {
      provision: vi.fn().mockResolvedValue({
        machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff151",
        status: "provisioning",
        etaSeconds: 90,
      }),
    };
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_new_avatar" }),
      }),
      platformSecret: "platform-secret-123",
      customerVpsService: customerVpsService as unknown as CustomerVpsService,
      env: { ...process.env, CLERK_SECRET_KEY: "sk_test_matrix" },
    });

    const provision = await app.request("/api/auth/provision-runtime", {
      method: "POST",
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(provision.status).toBe(202);
    expect(customerVpsService.provision).toHaveBeenCalledWith({
      handle: "newuser",
      clerkUserId: "user_new_avatar",
      runtimeSlot: "primary",
    });
    await expect(getPlatformUserByClerkId(db, "user_new_avatar")).resolves.toMatchObject({
      clerkId: "user_new_avatar",
      handle: "newuser",
      displayName: "New User",
      email: "new@example.com",
      containerId: "vps:9f05824c-8d0a-4d83-9cb4-b312d43ff151",
    });
  });

  it("selects another handle before provisioning when the preferred handle is already in users", async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    await ensurePlatformUser(db, {
      clerkId: "user_existing",
      handle: "newuser",
      displayName: "Existing User",
      email: "existing@example.com",
      containerId: "vps:existing-machine",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        username: "newuser",
        first_name: "New",
        last_name: "User",
        primary_email_address_id: "email_1",
        email_addresses: [{ id: "email_1", email_address: "new@example.com" }],
      }),
    );
    const customerVpsService = {
      provision: vi.fn().mockResolvedValue({
        machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff150",
        status: "provisioning",
        etaSeconds: 90,
      }),
    };
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_new" }),
      }),
      platformSecret: "platform-secret-123",
      customerVpsService: customerVpsService as unknown as CustomerVpsService,
      env: { ...process.env, CLERK_SECRET_KEY: "sk_test_matrix" },
    });

    const provision = await app.request("/api/auth/provision-runtime", {
      method: "POST",
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(provision.status).toBe(202);
    expect(customerVpsService.provision).toHaveBeenCalledWith({
      handle: "new",
      clerkUserId: "user_new",
      runtimeSlot: "primary",
    });
    await expect(getPlatformUserByClerkId(db, "user_new")).resolves.toMatchObject({
      clerkId: "user_new",
      handle: "new",
      containerId: "vps:9f05824c-8d0a-4d83-9cb4-b312d43ff150",
    });
  });

  it("uses an existing platform user identity before fetching Clerk during provisioning", async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    await ensurePlatformUser(db, {
      clerkId: "user_new",
      handle: "newuser",
      displayName: "New User",
      email: "new@example.com",
      containerId: "clerk:user_new",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("should not fetch Clerk"));
    const customerVpsService = {
      provision: vi.fn().mockResolvedValue({
        machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff150",
        status: "provisioning",
        etaSeconds: 90,
      }),
    };
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_new" }),
      }),
      platformSecret: "platform-secret-123",
      customerVpsService: customerVpsService as unknown as CustomerVpsService,
      env: { ...process.env, CLERK_SECRET_KEY: undefined },
    });

    const provision = await app.request("/api/auth/provision-runtime", {
      method: "POST",
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(provision.status).toBe(202);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(customerVpsService.provision).toHaveBeenCalledWith({
      handle: "newuser",
      clerkUserId: "user_new",
      runtimeSlot: "primary",
    });
    await expect(getPlatformUserByClerkId(db, "user_new")).resolves.toMatchObject({
      handle: "newuser",
      displayName: "New User",
      email: "new@example.com",
      containerId: "vps:9f05824c-8d0a-4d83-9cb4-b312d43ff150",
    });
  });

  it("trims generated handles again after length limiting", async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    await deleteContainer(db, "very-long-username-with-hyphen");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        username: "very-long-username-with-hyphen-x",
        primary_email_address_id: "email_1",
        email_addresses: [{ id: "email_1", email_address: "fallback@example.com" }],
      }),
    );
    const customerVpsService = {
      provision: vi.fn().mockResolvedValue({ status: "provisioning" }),
    };
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_new" }),
      }),
      platformSecret: "platform-secret-123",
      customerVpsService: customerVpsService as unknown as CustomerVpsService,
      env: { ...process.env, CLERK_SECRET_KEY: "sk_test_matrix" },
    });

    const provision = await app.request("/api/auth/provision-runtime", {
      method: "POST",
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(provision.status).toBe(202);
    await expect(provision.json()).resolves.toMatchObject({
      handle: "very-long-username-with-hyphen",
      clerkUserId: "user_new",
    });
    expect(customerVpsService.provision).toHaveBeenCalledWith({
      handle: "very-long-username-with-hyphen",
      clerkUserId: "user_new",
      runtimeSlot: "primary",
    });
  });

  it("blocks signed-in runtime provisioning before Stripe checkout creates an entitlement", async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    const customerVpsService = {
      provision: vi.fn().mockResolvedValue({
        machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff156",
        status: "provisioning",
        etaSeconds: 90,
      }),
    };
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_new" }),
      }),
      platformSecret: "platform-secret-123",
      customerVpsService: customerVpsService as unknown as CustomerVpsService,
      env: {
        ...process.env,
        CLERK_SECRET_KEY: "sk_test_matrix",
        STRIPE_SECRET_KEY: "sk_test_billing",
      },
    });

    const provision = await app.request("/api/auth/provision-runtime", {
      method: "POST",
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(provision.status).toBe(402);
    await expect(provision.json()).resolves.toEqual({
      error: "Billing upgrade required",
      code: "billing_required",
    });
    expect(customerVpsService.provision).not.toHaveBeenCalled();
  });

  it("falls back instead of claiming another user's active Clerk handle", async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    await deleteContainer(db, "alice");
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff151",
      clerkUserId: "user_alice",
      handle: "alice",
      runtimeSlot: "primary",
      status: "running",
      hetznerServerId: 123482,
      publicIPv4: "203.0.113.33",
      imageVersion: "matrix-os-host-2026.05.31-1",
      serverType: "cpx22",
      provisionedAt: "2026-05-31T12:00:00.000Z",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        username: "alice",
        primary_email_address_id: "email_1",
        email_addresses: [{ id: "email_1", email_address: "alice@example.com" }],
      }),
    );
    const customerVpsService = {
      provision: vi.fn().mockResolvedValue({ status: "provisioning" }),
    };
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_new" }),
      }),
      platformSecret: "platform-secret-123",
      customerVpsService: customerVpsService as unknown as CustomerVpsService,
      env: { ...process.env, CLERK_SECRET_KEY: "sk_test_matrix" },
    });

    const provision = await app.request("/api/auth/provision-runtime", {
      method: "POST",
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    const fallbackHandle = expectedFallbackProvisionHandle("user_new");
    expect(provision.status).toBe(202);
    await expect(provision.json()).resolves.toEqual({
      runtime: "customer_vps",
      handle: fallbackHandle,
      clerkUserId: "user_new",
      runtimeSlot: "primary",
      status: "provisioning",
    });
    expect(customerVpsService.provision).toHaveBeenCalledWith({
      handle: fallbackHandle,
      clerkUserId: "user_new",
      runtimeSlot: "primary",
    });
  });

  it("falls back instead of claiming another user's active handle in another slot", async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    await deleteContainer(db, "alice");
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff152",
      clerkUserId: "user_alice",
      handle: "alice",
      runtimeSlot: "staging",
      status: "running",
      hetznerServerId: 123483,
      publicIPv4: "203.0.113.34",
      imageVersion: "matrix-os-host-2026.05.31-1",
      serverType: "cpx22",
      provisionedAt: "2026-05-31T12:00:00.000Z",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        username: "alice",
        primary_email_address_id: "email_1",
        email_addresses: [{ id: "email_1", email_address: "alice@example.com" }],
      }),
    );
    const customerVpsService = {
      provision: vi.fn().mockResolvedValue({ status: "provisioning" }),
    };
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_new" }),
      }),
      platformSecret: "platform-secret-123",
      customerVpsService: customerVpsService as unknown as CustomerVpsService,
      env: { ...process.env, CLERK_SECRET_KEY: "sk_test_matrix" },
    });

    const provision = await app.request("/api/auth/provision-runtime", {
      method: "POST",
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    const fallbackHandle = expectedFallbackProvisionHandle("user_new");
    expect(provision.status).toBe(202);
    await expect(provision.json()).resolves.toEqual({
      runtime: "customer_vps",
      handle: fallbackHandle,
      clerkUserId: "user_new",
      runtimeSlot: "primary",
      status: "provisioning",
    });
    expect(customerVpsService.provision).toHaveBeenCalledWith({
      handle: fallbackHandle,
      clerkUserId: "user_new",
      runtimeSlot: "primary",
    });
  });

  it("keeps a same-user active machine handle even with a stale legacy container row", async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff153",
      clerkUserId: "user_new",
      handle: "alice",
      runtimeSlot: "primary",
      status: "running",
      hetznerServerId: 123484,
      publicIPv4: "203.0.113.35",
      imageVersion: "matrix-os-host-2026.05.31-1",
      serverType: "cpx22",
      provisionedAt: "2026-05-31T12:00:00.000Z",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        username: "alice",
        primary_email_address_id: "email_1",
        email_addresses: [{ id: "email_1", email_address: "alice@example.com" }],
      }),
    );
    const customerVpsService = {
      provision: vi.fn().mockResolvedValue({ status: "running" }),
    };
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_new" }),
      }),
      platformSecret: "platform-secret-123",
      customerVpsService: customerVpsService as unknown as CustomerVpsService,
      env: { ...process.env, CLERK_SECRET_KEY: "sk_test_matrix" },
    });

    const provision = await app.request("/api/auth/provision-runtime", {
      method: "POST",
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(provision.status).toBe(202);
    await expect(provision.json()).resolves.toEqual({
      runtime: "customer_vps",
      handle: "alice",
      clerkUserId: "user_new",
      runtimeSlot: "primary",
      status: "running",
    });
    expect(customerVpsService.provision).toHaveBeenCalledWith({
      handle: "alice",
      clerkUserId: "user_new",
      runtimeSlot: "primary",
    });
  });

  it("keeps a same-user handle when another runtime slot already uses it", async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    await deleteContainer(db, "alice");
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff155",
      clerkUserId: "user_new",
      handle: "alice",
      runtimeSlot: "staging",
      status: "running",
      hetznerServerId: 123486,
      publicIPv4: "203.0.113.37",
      imageVersion: "matrix-os-host-2026.05.31-1",
      serverType: "cpx22",
      provisionedAt: "2026-05-31T12:00:00.000Z",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        username: "alice",
        primary_email_address_id: "email_1",
        email_addresses: [{ id: "email_1", email_address: "alice@example.com" }],
      }),
    );
    const customerVpsService = {
      provision: vi.fn().mockResolvedValue({ status: "provisioning" }),
    };
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_new" }),
      }),
      platformSecret: "platform-secret-123",
      customerVpsService: customerVpsService as unknown as CustomerVpsService,
      env: { ...process.env, CLERK_SECRET_KEY: "sk_test_matrix" },
    });

    const provision = await app.request("/api/auth/provision-runtime", {
      method: "POST",
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(provision.status).toBe(202);
    await expect(provision.json()).resolves.toEqual({
      runtime: "customer_vps",
      handle: "alice",
      clerkUserId: "user_new",
      runtimeSlot: "primary",
      status: "provisioning",
    });
    expect(customerVpsService.provision).toHaveBeenCalledWith({
      handle: "alice",
      clerkUserId: "user_new",
      runtimeSlot: "primary",
    });
  });

  it("falls back instead of claiming another user's legacy container handle", async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        username: "alice",
        primary_email_address_id: "email_1",
        email_addresses: [{ id: "email_1", email_address: "alice@example.com" }],
      }),
    );
    const customerVpsService = {
      provision: vi.fn().mockResolvedValue({ status: "provisioning" }),
    };
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_new" }),
      }),
      platformSecret: "platform-secret-123",
      customerVpsService: customerVpsService as unknown as CustomerVpsService,
      env: { ...process.env, CLERK_SECRET_KEY: "sk_test_matrix" },
    });

    const provision = await app.request("/api/auth/provision-runtime", {
      method: "POST",
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    const fallbackHandle = expectedFallbackProvisionHandle("user_new");
    expect(provision.status).toBe(202);
    await expect(provision.json()).resolves.toEqual({
      runtime: "customer_vps",
      handle: fallbackHandle,
      clerkUserId: "user_new",
      runtimeSlot: "primary",
      status: "provisioning",
    });
    expect(customerVpsService.provision).toHaveBeenCalledWith({
      handle: fallbackHandle,
      clerkUserId: "user_new",
      runtimeSlot: "primary",
    });
  });

  it("continues signed-in auth pages through a Clerk token exchange", async () => {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_matrix";
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue(null),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/sign-up", {
      headers: { host: "app.matrix-os.com" },
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("window.Clerk.session.getToken()");
    expect(html).toContain("fetch('/api/auth/app-session'");
    expect(html).toContain("function clerkSignOutWithTimeout()");
    expect(html).toContain("window.location.replace(signOutTarget)");
    expect(html).toContain("fetch('/api/auth/provision-runtime'");
    expect(html).toContain("signal: controller.signal");
    expect(html).toContain("window.clearTimeout(timeoutId);");
    expect(html).toContain(".auth-card.default-installs-card");
    expect(html).toContain("setDefaultInstallsCard(true);");
    expect(html).toContain("state.className = 'session-state default-installs-state';");
    expect(html).toContain("kicker.textContent = 'Default installs';");
    expect(html).toContain("heading.textContent = 'Choose what Matrix installs first';");
    expect(html).toContain("toolsHeading.textContent = 'Developer tools';");
    expect(html).toContain("label.className = 'developer-tool-option selected';");
    expect(html).toContain("var developerToolLogos = {");
    expect(html).toContain("<title>OpenAI</title>");
    expect(html).toContain("<title>Anthropic</title>");
    expect(html).toContain("<title id=\"opencode-title\">OpenCode</title>");
    expect(html).toContain("<title>Pi</title>");
    expect(html).toContain("logo.innerHTML = developerToolLogos[tool] || '';");
    expect(html).toContain("footerText.textContent = 'CLI login happens after the VPS is ready. Tool authentication is completed inside each CLI.';");
    expect(html).toContain("matrix.billing.checkoutAttemptAt");
    expect(html).toContain("hasTrustedCheckoutReturn()");
    expect(html).toContain("stripCheckoutReturnParams()");
    expect(html).toContain("if (provisionStarted)");
    expect(html).toContain("maxBillingConfirmationPolls");
    expect(html).toContain("provisioningPolls = 0;");
    expect(html).toContain("Opening Billing settings");
    expect(html).toContain("matrix.billing.setupRetryCount");
    expect(html).toContain("var maxBillingSetupReloads = 3;");
    expect(html).toContain("Billing settings are still loading");
    expect(html).toContain("2000 + retryCount * 1000");
    expect(html).toContain("var billingSetupTarget = ");
    expect(html).toContain("var url = new URL(billingSetupTarget);");
    expect(html).toContain("window.location.replace(target);");
    expect(html).not.toContain("Open Billing settings");
    expect(html).not.toContain("Stripe opens only after you continue from Billing.");
    expect(html).not.toContain("fetch('/billing/checkout'");
    expect(html).not.toContain("planSlug: 'matrix_builder'");
    expect(html).not.toContain("Checkout unavailable");
    expect(html).not.toContain("showCheckoutUnavailableState();");
    expect(html).not.toContain("Opening secure checkout");
    expect(html).toContain("retryProvisioningAfterBillingDelay(developerTools)");
    expect(html).toContain("Confirming billing");
    expect(html).toContain("provisioning_conflict");
    expect(html).toContain("if (body && body.code === 'provisioning_conflict') {\n                billingConfirmationPolls = 0;\n                provisioningPolls = 0;");
    expect(html).toContain("checkoutJustCompleted = false;");
    expect(html).toContain("Starting your Matrix computer");
    expect(html).toContain("Preparing your Matrix computer");
    expect(html).toContain("method: 'DELETE'");
    expect(html).toContain("Loading your Matrix computer");
    expect(html).not.toContain("ask the operator to provision this account");
    expect(html).not.toContain("You are already signed in");
  });

  it("opens billing settings instead of direct checkout when app-session billing is required", async () => {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_matrix";
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue(null),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/sign-up", {
      headers: { host: "app.matrix-os.com" },
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("if (res.status === 402) {\n            openBillingSettingsFromClerkSession();");
    expect(html).toContain("Opening Billing settings");
    expect(html).toContain("matrix.billing.setupRetryCount");
    expect(html).toContain("var maxBillingSetupReloads = 3;");
    expect(html).toContain("Billing settings are still loading");
    expect(html).toContain("var billingSetupTarget = ");
    expect(html).toContain("var url = new URL(billingSetupTarget);");
    expect(html).toContain("window.location.replace(target);");
    expect(html).not.toContain("Open Billing settings");
    expect(html).not.toContain("'Start checkout',\n        startBillingCheckoutFromClerkSession");
    expect(html).not.toContain("fetch('/billing/checkout'");
  });

  it("builds billing setup targets on the app origin while preserving device return", () => {
    expect(buildBillingSetupTarget(
      "https://app.matrix-os.com",
      "/?device_return=%2Fauth%2Fdevice%3Fuser_code%3DBCDF-GHJK",
    )).toBe(
      "https://app.matrix-os.com/?billing=setup&device_return=%2Fauth%2Fdevice%3Fuser_code%3DBCDF-GHJK",
    );
    expect(buildBillingSetupTarget(
      "https://app.matrix-os.com",
      "/?device_return=https%3A%2F%2Fevil.example%2Fauth%2Fdevice%3Fuser_code%3DBCDF-GHJK",
    )).toBe("https://app.matrix-os.com/?billing=setup");
  });

  it("sends code-domain billing setup handoffs back to the app shell origin", async () => {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_matrix";
    delete process.env.MATRIX_APP_ORIGIN;
    const app = createApp({
      db,
      env: {
        ...process.env,
        MATRIX_APP_ORIGIN: "https://staging-app.matrix-os.com",
      },
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue(null),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/sign-up?device_return=%2Fauth%2Fdevice%3Fuser_code%3DBCDF-GHJK", {
      headers: { host: "code.matrix-os.com" },
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(
      'var billingSetupTarget = "https://staging-app.matrix-os.com/?billing=setup\\u0026device_return=%2Fauth%2Fdevice%3Fuser_code%3DBCDF-GHJK";',
    );
    expect(html).toContain("var url = new URL(billingSetupTarget);");
    expect(html).toContain("return url.toString();");
    expect(html).not.toContain("var url = new URL('/', window.location.origin);");
  });

  it("returns billing_required for signed-in app-session exchange before a Stripe entitlement exists", async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    process.env.MATRIX_BILLING_PROVIDER = "stripe";
    process.env.STRIPE_SECRET_KEY = "sk_test_matrix";
    await deleteContainer(db, "alice");
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_new" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const exchange = await app.request("/api/auth/app-session", {
      method: "POST",
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(exchange.status).toBe(402);
    await expect(exchange.json()).resolves.toEqual({
      error: "Billing upgrade required",
      code: "billing_required",
    });
    const setCookie = combinedSetCookie(exchange.headers);
    expect(setCookie).toContain("matrix_app_session=;");
    expect(setCookie).toContain("matrix_native_app_session=;");
    expect(setCookie).toContain("Max-Age=0");
  });

  it("returns billing_required for stale legacy-container users in VPS-native app-session exchange", async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    process.env.MATRIX_BILLING_PROVIDER = "stripe";
    process.env.STRIPE_SECRET_KEY = "sk_test_matrix";
    await updateContainerStatus(db, "alice", "stopped", "stale-container-id");
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
      customerVpsService: {} as CustomerVpsService,
      env: {
        MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED: "true",
        MATRIX_BILLING_PROVIDER: "stripe",
        STRIPE_SECRET_KEY: "sk_test_matrix",
      } as NodeJS.ProcessEnv,
    });

    const exchange = await app.request("/api/auth/app-session", {
      method: "POST",
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(exchange.status).toBe(402);
    await expect(exchange.json()).resolves.toEqual({
      error: "Billing upgrade required",
      code: "billing_required",
    });
    const setCookie = combinedSetCookie(exchange.headers);
    expect(setCookie).toContain("matrix_app_session=;");
    expect(setCookie).toContain("matrix_native_app_session=;");
    expect(setCookie).toContain("Max-Age=0");
  });

  it("serves the shell billing gate from auth-shell for signed-in users before a VPS exists", async () => {
    process.env.MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED = "false";
    process.env.AUTH_SHELL_HOST = "auth-shell.test";
    process.env.AUTH_SHELL_PORT = "3200";
    await deleteContainer(db, "alice");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("auth shell", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_new" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/?device_return=%2Fauth%2Fdevice%3Fuser_code%3DBCDF-GHJK", {
      headers: {
        host: "app.matrix-os.com",
        cookie: "__session=clerk-new",
      },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("auth shell");
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.get("cdn-cache-control")).toBe("no-store");
    expect(res.headers.get("cloudflare-cdn-cache-control")).toBe("no-store");
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://auth-shell.test:3200/?device_return=%2Fauth%2Fdevice%3Fuser_code%3DBCDF-GHJK",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        method: "GET",
        redirect: "manual",
        signal: expect.any(AbortSignal),
      }),
    );
    const proxiedHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Headers | undefined;
    expect(proxiedHeaders?.get("host")).toBe("auth-shell.test:3200");
    expect(proxiedHeaders?.get("x-forwarded-host")).toBe("app.matrix-os.com");
    expect(proxiedHeaders?.get("x-forwarded-proto")).toBe("http");
    delete process.env.AUTH_SHELL_HOST;
    delete process.env.AUTH_SHELL_PORT;
  });

  it("serves anonymous app-domain sign-in from auth-shell before a VPS exists", async () => {
    process.env.MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED = "false";
    process.env.AUTH_SHELL_HOST = "auth-shell.test";
    process.env.AUTH_SHELL_PORT = "3200";
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_matrix";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('<main data-matrix-auth-shell="true">sign in</main>', {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth(),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/sign-in", {
      headers: {
        host: "app.matrix-os.com",
      },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('data-matrix-auth-shell="true"');
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://auth-shell.test:3200/sign-in");
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        method: "GET",
        redirect: "manual",
        signal: expect.any(AbortSignal),
      }),
    );
    const proxiedHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Headers | undefined;
    expect(proxiedHeaders?.get("host")).toBe("auth-shell.test:3200");
    expect(proxiedHeaders?.get("x-forwarded-host")).toBe("app.matrix-os.com");
    expect(proxiedHeaders?.get("x-forwarded-proto")).toBe("http");
    delete process.env.AUTH_SHELL_HOST;
    delete process.env.AUTH_SHELL_PORT;
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  });

  it("falls back to the inline auth page when anonymous auth-shell sign-in fails", async () => {
    process.env.MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED = "false";
    process.env.AUTH_SHELL_HOST = "auth-shell.test";
    process.env.AUTH_SHELL_PORT = "3200";
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_matrix";
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(timeout);
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth(),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/sign-in", {
      headers: {
        host: "app.matrix-os.com",
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    const html = await res.text();
    expect(fetchMock).toHaveBeenCalled();
    expect(html).toContain('data-matrix-platform-fallback-auth="true"');
    expect(html).toContain("Welcome back to Matrix");
    delete process.env.AUTH_SHELL_HOST;
    delete process.env.AUTH_SHELL_PORT;
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  });

  it("keeps anonymous app-domain file requests on the gateway 401 path", async () => {
    process.env.MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED = "false";
    process.env.AUTH_SHELL_HOST = "auth-shell.test";
    process.env.AUTH_SHELL_PORT = "3200";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("auth shell", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth(),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/files/system/config.json", {
      headers: {
        host: "app.matrix-os.com",
      },
    });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(fetchMock).not.toHaveBeenCalled();
    delete process.env.AUTH_SHELL_HOST;
    delete process.env.AUTH_SHELL_PORT;
  });

  it("redirects to automatic billing setup when the no-VPS auth-shell proxy times out", async () => {
    process.env.MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED = "false";
    process.env.AUTH_SHELL_HOST = "auth-shell.test";
    process.env.AUTH_SHELL_PORT = "3200";
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_matrix";
    await deleteContainer(db, "alice");
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(timeout);
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_new" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/", {
      headers: {
        host: "app.matrix-os.com",
        cookie: "__session=clerk-new",
      },
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?billing=setup");
    expect(fetchMock).toHaveBeenCalled();
  });

  it("shows a controlled auto-retry page when billing setup cannot reach auth-shell", async () => {
    process.env.MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED = "false";
    process.env.AUTH_SHELL_HOST = "auth-shell.test";
    process.env.AUTH_SHELL_PORT = "3200";
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_matrix";
    await deleteContainer(db, "alice");
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(timeout);
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_new" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/?billing=setup", {
      headers: {
        host: "app.matrix-os.com",
        cookie: "__session=clerk-new",
      },
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(fetchMock).toHaveBeenCalled();
    expect(html).toContain("Loading your Matrix computer");
    expect(html).toContain("Opening Billing settings");
    expect(html).toContain("matrix.billing.setupRetryCount");
    expect(html).toContain("var maxBillingSetupReloads = 3;");
    expect(html).toContain("Billing settings are still loading");
    expect(html).toContain("2000 + retryCount * 1000");
    expect(html).toContain("var billingSetupTarget = ");
    expect(html).toContain("var url = new URL(billingSetupTarget);");
    expect(html).toContain("window.location.replace(target);");
    expect(html).not.toContain("Matrix OS shell unavailable");
    expect(html).not.toContain("Open Billing settings");
  });

  it("keeps legacy no-container app-domain users on the platform auth page", async () => {
    process.env.MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED = "true";
    process.env.AUTH_SHELL_HOST = "auth-shell.test";
    process.env.AUTH_SHELL_PORT = "3200";
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_matrix";
    await deleteContainer(db, "alice");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("auth shell", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_new" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/?device_return=%2Fauth%2Fdevice%3Fuser_code%3DBCDF-GHJK", {
      headers: {
        host: "app.matrix-os.com",
        cookie: "__session=clerk-new",
      },
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('var redirectTarget = "/?device_return=%2Fauth%2Fdevice%3Fuser_code%3DBCDF-GHJK";');
    expect(html).toContain('var deviceReturnTarget = "/auth/device?user_code=BCDF-GHJK";');
    expect(html).toContain("Opening Billing settings");
    expect(html).toContain("var billingSetupTarget = ");
    expect(html).toContain("var url = new URL(billingSetupTarget);");
    expect(html).toContain("window.location.replace(target);");
    expect(html).toContain("window.location.replace(deviceReturnTarget || payload.redirectTo || redirectTarget);");
    expect(html).toContain("fetch('/api/auth/provision-runtime'");
    expect(html).not.toContain("Open Billing settings");
    expect(html).not.toBe("auth shell");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps legacy no-container app-domain billing users on the settings handoff", async () => {
    process.env.MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED = "true";
    process.env.AUTH_SHELL_HOST = "auth-shell.test";
    process.env.AUTH_SHELL_PORT = "3200";
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_matrix";
    await deleteContainer(db, "alice");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("auth shell", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_new" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/", {
      headers: {
        host: "app.matrix-os.com",
        cookie: "__session=clerk-new",
      },
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('var redirectTarget = "/";');
    expect(html).toContain('var deviceReturnTarget = "";');
    expect(html).toContain("Opening Billing settings");
    expect(html).toContain("var billingSetupTarget = ");
    expect(html).toContain("var url = new URL(billingSetupTarget);");
    expect(html).toContain("window.location.replace(target);");
    expect(html).not.toContain("Open Billing settings");
    expect(html).not.toContain("Stripe opens only after you continue from Billing.");
    expect(html).not.toContain("'Start checkout',\n        startBillingCheckoutFromClerkSession");
    expect(html).not.toBe("auth shell");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not trust a stale app session cookie over a different Clerk session", async () => {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_matrix";
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    await deleteContainer(db, "alice");
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff139",
      clerkUserId: "user_old",
      handle: "alice",
      runtimeSlot: "primary",
      status: "running",
      hetznerServerId: 123483,
      publicIPv4: "203.0.113.34",
      imageVersion: "matrix-os-host-2026.05.31-1",
      serverType: "cpx22",
      provisionedAt: "2026-05-31T12:00:00.000Z",
    });
    const issued = await issueSyncJwt({
      secret: JWT_SECRET,
      clerkUserId: "user_old",
      handle: "alice",
      gatewayUrl: "https://alice.matrix-os.com",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("wrong target", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_new" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/", {
      headers: {
        host: "app.matrix-os.com",
        cookie: `matrix_app_session=${encodeURIComponent(issued.token)}; __session=clerk-new`,
      },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("fetch('/api/auth/app-session'");
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

  it("routes explicit VM native app capability assets without browser cookies", async () => {
    await deleteContainer(db, "alice");
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff141",
      clerkUserId: "user_alice",
      handle: "alice-staging",
      runtimeSlot: "staging",
      status: "running",
      hetznerServerId: 123485,
      publicIPv4: "203.0.113.35",
      imageVersion: "v082-login-shell-8935a7cd",
      provisionedAt: "2026-05-25T11:23:51.076Z",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("window.Utilities = {};", {
        status: 200,
        headers: { "content-type": "application/javascript" },
      }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request(
      "/vm/alice-staging/api/native-apps/sessions/session_aaaaaaaaaaaaaaaaaaaaaaaa/stream/stream_bbbbbbbbbbbbbbbbbbbbbbbb/js/Utilities.js",
      { headers: { host: "app.matrix-os.com", origin: "null" } },
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("window.Utilities = {};");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "https://203.0.113.35:443/api/native-apps/sessions/session_aaaaaaaaaaaaaaaaaaaaaaaa/stream/stream_bbbbbbbbbbbbbbbbbbbbbbbb/js/Utilities.js",
    );
    const headers = init?.headers as Headers;
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("x-platform-user-id")).toBeNull();
  });

  it("rejects explicit VM native app stream assets without a capability token", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("unexpected", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request(
      "/vm/alice-staging/api/native-apps/sessions/session_aaaaaaaaaaaaaaaaaaaaaaaa/stream/js/Utilities.js",
      { headers: { host: "app.matrix-os.com", origin: "null" } },
    );

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();

    const authenticatedRes = await app.request(
      "/vm/alice-staging/api/native-apps/sessions/session_aaaaaaaaaaaaaaaaaaaaaaaa/stream/js/Utilities.js",
      {
        headers: {
          host: "app.matrix-os.com",
          origin: "null",
          authorization: "Bearer clerk-session",
        },
      },
    );

    expect(authenticatedRes.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("routes signed explicit VM Vite app assets with null-origin CORS without browser cookies", async () => {
    await deleteContainer(db, "alice");
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff140",
      clerkUserId: "user_alice",
      handle: "alice",
      runtimeSlot: "primary",
      status: "running",
      hetznerServerId: 123484,
      publicIPv4: "203.0.113.34",
      imageVersion: "matrix-os-host-2026.04.26-1",
      provisionedAt: "2026-04-26T12:00:00.000Z",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          '<!doctype html><script type="module" src="./assets/index.js"></script><link rel="stylesheet" href="./assets/index.css">',
          {
            status: 200,
            headers: {
              "content-type": "text/html; charset=utf-8",
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response('import{a}from"./react.js";import("./editor.js");const untouched=Array.from("./plain.js");console.log("chess")', {
          status: 200,
          headers: {
            "content-type": "application/javascript",
            vary: "Accept-Encoding",
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response('@import "./theme.css";@font-face{src:url("./font.woff2")}main{background:url(./image.png)}', {
          status: 200,
          headers: { "content-type": "text/css; charset=utf-8" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("font-data", {
          status: 200,
          headers: { "content-type": "font/woff2" },
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

    const htmlRes = await app.request("/apps/chess/", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });
    expect(htmlRes.status).toBe(200);
    const html = await htmlRes.text();
    const assetPath = html.match(/src="([^"]+)"/)?.[1];
    const stylesheetPath = html.match(/href="([^"]+)"/)?.[1];
    expect(assetPath).toMatch(/^\/vm\/alice\/apps\/chess\/assets\/index\.js\?matrix_asset_token=/);
    expect(stylesheetPath).toMatch(/^\/vm\/alice\/apps\/chess\/assets\/index\.css\?matrix_asset_token=/);

    const res = await app.request(assetPath ?? "/invalid", {
      headers: {
        host: "app.matrix-os.com",
        origin: "null",
      },
    });

    expect(res.status).toBe(200);
    const [assetUrl, assetInit] = fetchMock.mock.calls[1]!;
    expect(assetUrl).toBe("https://203.0.113.34:443/apps/chess/assets/index.js");
    const assetHeaders = assetInit?.headers as Headers;
    expect(assetHeaders.get("origin")).toBe("null");
    expect(assetHeaders.get("accept-encoding")).toBe("identity");
    expect(assetHeaders.get("cookie")).toBeNull();
    expect(assetHeaders.get("x-platform-user-id")).toBeNull();
    expect(res.headers.get("access-control-allow-origin")).toBe("null");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(res.headers.get("vary")).toContain("Origin");
    expect(res.headers.get("set-cookie")).toContain("matrix_shell_route=alice");
    const js = await res.text();
    expect(js).toMatch(/from"\.\/react\.js\?matrix_asset_token=[^"]+"/);
    expect(js).toMatch(/import\("\.\/editor\.js\?matrix_asset_token=[^"]+"\)/);
    expect(js).toContain('Array.from("./plain.js")');

    const cssRes = await app.request(stylesheetPath ?? "/invalid", {
      headers: { host: "app.matrix-os.com", origin: "null" },
    });
    expect(cssRes.status).toBe(200);
    const css = await cssRes.text();
    expect(css).toMatch(/@import "\.\/theme\.css\?matrix_asset_token=[^"]+"/);
    expect(css).toMatch(/url\("\.\/font\.woff2\?matrix_asset_token=[^"]+"\)/);
    expect(css).toMatch(/url\(\.\/image\.png\?matrix_asset_token=[^)]+\)/);

    const fontPath = css.match(/url\("([^"]+font\.woff2[^"]*)"\)/)?.[1];
    const fontUrl = new URL(fontPath ?? "/invalid", `https://app.matrix-os.com${stylesheetPath}`);
    const fontRes = await app.request(`${fontUrl.pathname}${fontUrl.search}`, {
      headers: { host: "app.matrix-os.com", origin: "null" },
    });
    expect(fontRes.status).toBe(200);
    expect(fetchMock.mock.calls[3]?.[0]).toBe("https://203.0.113.34:443/apps/chess/assets/font.woff2");
  });

  it("binds cookie-free Vite assets and lazy chunks to the selected same-handle runtime", async () => {
    await deleteContainer(db, "alice");
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff150",
      clerkUserId: "user_alice",
      handle: "alice",
      runtimeSlot: "primary",
      status: "running",
      hetznerServerId: 123500,
      publicIPv4: "203.0.113.50",
      imageVersion: "matrix-os-host-2026.04.26-1",
      provisionedAt: "2026-04-26T12:00:00.000Z",
    });
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff151",
      clerkUserId: "user_alice",
      handle: "alice",
      runtimeSlot: "review",
      status: "running",
      hetznerServerId: 123501,
      publicIPv4: "203.0.113.51",
      imageVersion: "matrix-os-host-2026.04.26-1",
      provisionedAt: "2026-04-26T12:01:00.000Z",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response('<!doctype html><script type="module" src="./assets/index.js"></script>', {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      )
      .mockResolvedValueOnce(
        new Response('import("./editor.js")', {
          status: 200,
          headers: { "content-type": "application/javascript" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("export const editor = true", {
          status: 200,
          headers: { "content-type": "application/javascript" },
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

    const htmlRes = await app.request("/vm/alice/apps/chess/?runtime=review", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(htmlRes.status).toBe(200);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://203.0.113.51:443/apps/chess/");
    const html = await htmlRes.text();
    const entryAssetPath = html.match(/src="([^"]+)"/)?.[1];
    expect(entryAssetPath).toMatch(
      /^\/vm\/alice\/apps\/chess\/assets\/index\.js\?runtime=review&matrix_asset_token=/,
    );

    const entryRes = await app.request(entryAssetPath ?? "/invalid", {
      headers: { host: "app.matrix-os.com", origin: "null" },
    });
    expect(entryRes.status).toBe(200);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://203.0.113.51:443/apps/chess/assets/index.js");
    const entryJs = await entryRes.text();
    const lazyImportPath = entryJs.match(/import\("([^"]+)"\)/)?.[1];
    expect(lazyImportPath).toMatch(/^\.\/editor\.js\?runtime=review&matrix_asset_token=/);

    const tamperedAssetPath = entryAssetPath?.replace("runtime=review", "runtime=primary");
    const tamperedRes = await app.request(tamperedAssetPath ?? "/invalid", {
      headers: { host: "app.matrix-os.com", origin: "null" },
    });
    expect(tamperedRes.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const lazyAssetUrl = new URL(lazyImportPath ?? "/invalid", `https://app.matrix-os.com${entryAssetPath}`);
    const lazyRes = await app.request(`${lazyAssetUrl.pathname}${lazyAssetUrl.search}`, {
      headers: { host: "app.matrix-os.com", origin: "null" },
    });
    expect(lazyRes.status).toBe(200);
    expect(fetchMock.mock.calls[2]?.[0]).toBe("https://203.0.113.51:443/apps/chess/assets/editor.js");
  });

  it("rejects unsigned explicit VM Vite app assets before probing a handle", async () => {
    await deleteContainer(db, "alice");
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff14a",
      clerkUserId: "user_alice",
      handle: "alice",
      runtimeSlot: "primary",
      status: "running",
      hetznerServerId: 123494,
      publicIPv4: "203.0.113.44",
      imageVersion: "matrix-os-host-2026.04.26-1",
      provisionedAt: "2026-04-26T12:00:00.000Z",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("console.log('chess')", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/vm/alice/apps/chess/assets/index.js", {
      headers: {
        host: "app.matrix-os.com",
        origin: "null",
      },
    });

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
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
    expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
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

  it("routes an explicitly shared preview to a collaborator but never shares customer machines", async () => {
    await deleteContainer(db, "alice");
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff137",
      clerkUserId: "user_bob",
      handle: "pr-1037",
      runtimeSlot: "pr-1037",
      provisioningClass: "preview",
      accessClerkUserIds: ["user_alice"],
      status: "running",
      hetznerServerId: 123481,
      publicIPv4: "203.0.113.37",
      imageVersion: "v2026.07.19-pr1037",
      provisionedAt: "2026-07-19T12:00:00.000Z",
    });
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff138",
      clerkUserId: "user_bob",
      handle: "bob-private",
      runtimeSlot: "primary",
      accessClerkUserIds: ["user_alice"],
      status: "running",
      hetznerServerId: 123482,
      publicIPv4: "203.0.113.38",
      imageVersion: "v2026.07.19",
      provisionedAt: "2026-07-19T12:00:00.000Z",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("shared preview", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const shared = await app.request("/vm/pr-1037", {
      headers: { host: "app.matrix-os.com", authorization: "Bearer clerk-session" },
    });
    expect(shared.status).toBe(200);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://203.0.113.37:443/");

    const routeCookies = shared.headers.get("set-cookie") ?? "";
    fetchMock.mockClear();
    const followUp = await app.request("/api/projects", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
        cookie: routeCookies,
      },
    });
    expect(followUp.status).toBe(200);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://203.0.113.37:443/api/projects");

    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(Response.json({ release: { version: "v2026.07.19-pr1037" } }));
    const picker = await app.request("/runtime", {
      headers: { host: "app.matrix-os.com", authorization: "Bearer clerk-session" },
    });
    expect(picker.status).toBe(200);
    const pickerHtml = await picker.text();
    expect(pickerHtml).toContain('href="/vm/pr-1037"');
    expect(pickerHtml).not.toContain("bob-private");

    fetchMock.mockClear();
    const privateMachine = await app.request("/vm/bob-private", {
      headers: { host: "app.matrix-os.com", authorization: "Bearer clerk-session" },
    });
    expect(privateMachine.status).toBe(404);
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
        "x-matrix-edge-secret": "edge-secret",
      },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("explicit shell");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://203.0.113.28:443/");
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("x-matrix-edge-secret")).toBeNull();
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

  it("serves the safe app-domain service worker without auth", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("wrong target", { status: 200 }),
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
      const res = await app.request("/service-worker.js", {
        headers: {
          host: "app.matrix-os.com",
        },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/javascript");
      expect(res.headers.get("cache-control")).toBe("no-store, private");
      expect(res.headers.get("cdn-cache-control")).toBe("no-store");
      expect(res.headers.get("service-worker-allowed")).toBe("/");
      const body = await res.text();
      expect(body).not.toContain("registration.unregister()");
      expect(body).toContain('p.startsWith("/api/")');
      expect(body).toContain('p.startsWith("/files/apps/")');
      expect(body).toContain('p.startsWith("/_next/static/")');
      expect(verifyToken).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    }
  });

  it("proxies app-domain PostHog relay logs without auth or session headers", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
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
      const res = await app.request("/relay/i/v1/logs?verbose=true", {
        method: "POST",
        headers: {
          host: "app.matrix-os.com",
          authorization: "Bearer clerk-session",
          cookie: "__session=clerk-cookie; matrix_app_session__alice=session",
          "content-type": "application/json",
        },
        body: JSON.stringify({ api_key: "phc_test", batch: [] }),
      });

      expect(res.status).toBe(204);
      expect(verifyToken).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledOnce();
      const [target, init] = fetchMock.mock.calls[0]!;
      expect(target).toBe("https://eu.i.posthog.com/i/v1/logs?verbose=true");
      expect(init?.method).toBe("POST");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.headers).toBeInstanceOf(Headers);
      const headers = init?.headers as Headers;
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("cookie")).toBeNull();
      expect(headers.get("host")).toBe("eu.i.posthog.com");
    } finally {
      delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    }
  });

  it("keeps protocol-relative app-domain PostHog relay paths on the PostHog host", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
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
      const res = await app.request("/relay//internal-metadata.svc/api?x=1", {
        method: "POST",
        headers: {
          host: "app.matrix-os.com",
          "content-type": "application/json",
        },
        body: "{}",
      });

      expect(res.status).toBe(204);
      expect(verifyToken).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledOnce();
      const [target, init] = fetchMock.mock.calls[0]!;
      expect(target).toBe("https://eu.i.posthog.com//internal-metadata.svc/api?x=1");
      const headers = init?.headers as Headers;
      expect(headers.get("host")).toBe("eu.i.posthog.com");
    } finally {
      delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    }
  });

  it("proxies app-domain PostHog relay static assets to the asset host with upstream caching", async () => {
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
      const res = await app.request("/relay/static/array.js", {
        headers: {
          host: "app.matrix-os.com",
          authorization: "Bearer clerk-session",
          cookie: "__session=clerk-cookie",
        },
      });

      expect(res.status).toBe(200);
      expect(await res.text()).toBe("asset");
      expect(res.headers.get("cache-control")).toBe("public, max-age=31536000");
      expect(verifyToken).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledOnce();
      const [target, init] = fetchMock.mock.calls[0]!;
      expect(target).toBe("https://eu-assets.i.posthog.com/static/array.js");
      const headers = init?.headers as Headers;
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("cookie")).toBeNull();
      expect(headers.get("host")).toBe("eu-assets.i.posthog.com");
    } finally {
      delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    }
  });

  it("routes app-domain icons directly to the runtime gateway", async () => {
    const verifyToken = vi.fn().mockResolvedValue({ sub: "user_alice" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("icon", {
        status: 200,
        headers: { "content-type": "image/png", etag: '"icon-etag"', "cache-control": "no-store" },
      }),
    );
    const app = createApp({
      db,
      docker: stubDocker(),
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({ verifyToken }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/icons/workspace.png?v=icon-etag", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session-jwt",
      },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("icon");
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://172.18.0.14:4000/icons/workspace.png?v=icon-etag");
  });

  it("uses private browser caching and disables shared CDN cache for app-domain static assets", async () => {
    const verifyToken = vi.fn().mockResolvedValue({ sub: "user_alice" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("chunk", {
        status: 200,
        headers: {
          "content-type": "application/javascript",
          "cache-control": "no-store",
          "cdn-cache-control": "public, max-age=31536000",
        },
      }),
    );
    const app = createApp({
      db,
      docker: stubDocker(),
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({ verifyToken }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/_next/static/chunks/app-shell-abc123.js", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session-jwt",
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(res.headers.get("cdn-cache-control")).toBe("no-store");
    expect(res.headers.get("cloudflare-cdn-cache-control")).toBe("no-store");
    expect(res.headers.get("vary")).toContain("Cookie");
    expect(res.headers.get("vary")).toContain("Accept-Encoding");
  });

  it("uses short private browser caching for unversioned release-owned app-domain assets", async () => {
    const verifyToken = vi.fn().mockResolvedValue({ sub: "user_alice" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("font", {
        status: 200,
        headers: { "content-type": "font/woff2", "cache-control": "no-store" },
      }),
    );
    const app = createApp({
      db,
      docker: stubDocker(),
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({ verifyToken }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/fonts/inter.woff2", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session-jwt",
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, max-age=86400");
    expect(res.headers.get("cdn-cache-control")).toBe("no-store");
    expect(res.headers.get("cloudflare-cdn-cache-control")).toBe("no-store");
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
    expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
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
