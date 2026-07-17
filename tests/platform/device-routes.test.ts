import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import {
  type PlatformDB,
  insertContainer,
  insertUserMachine,
} from "../../packages/platform/src/db.js";
import { createOrchestrator } from "../../packages/platform/src/orchestrator.js";
import { createApp } from "../../packages/platform/src/main.js";
import { createAuthRoutes } from "../../packages/platform/src/auth-routes.js";
import { createClerkAuth } from "../../packages/platform/src/clerk-auth.js";
import { issueSyncJwt, verifySyncJwt } from "../../packages/platform/src/sync-jwt.js";

const JWT_SECRET = "test-secret-at-least-32-characters-long";

function createMockDocker() {
  const ctr = {
    id: "mock-ctr-id",
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  };
  return {
    docker: {
      listNetworks: vi.fn().mockResolvedValue([{ Name: "matrixos-net" }]),
      createNetwork: vi.fn().mockResolvedValue({}),
      createContainer: vi.fn().mockResolvedValue(ctr),
      getContainer: vi.fn().mockReturnValue(ctr),
      pull: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe("device routes", () => {
  let db: PlatformDB;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_device_routes";

    const { docker } = createMockDocker();
    const orchestrator = createOrchestrator({ db, docker: docker as any });

    await insertContainer(db, {
      handle: "alice",
      clerkUserId: "user_alice",
      port: 5001,
      shellPort: 6001,
      status: "running",
    });

    const clerkAuth = createClerkAuth({
      verifyToken: async (token) => {
        if (token === "clerk-alice") return { sub: "user_alice" };
        if (token === "clerk-bob") return { sub: "user_bob" };
        throw new Error("invalid clerk token");
      },
    });

    app = createApp({ db, orchestrator, clerkAuth });
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
    delete process.env.PLATFORM_JWT_SECRET;
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    delete process.env.PLATFORM_PUBLIC_URL;
    delete process.env.NEXT_PUBLIC_MATRIX_APP_URL;
  });

  describe("POST /api/auth/device/code", () => {
    it("returns deviceCode, userCode, verificationUri, expiresIn, interval", async () => {
      const res = await app.request("/api/auth/device/code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: "matrixos-cli" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        deviceCode: expect.any(String),
        userCode: expect.stringMatching(/^[A-Z]{4}-[A-Z]{4}$/),
        verificationUri: expect.stringContaining("/auth/device?user_code="),
        expiresIn: 2700,
        interval: 5,
      });
    });

    it("includes a validated native callback for the macOS client", async () => {
      const res = await app.request("/api/auth/device/code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: "matrix-os-macos",
          redirectUri: "matrixos://auth?status=approved",
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      const verificationUri = new URL(body.verificationUri);
      expect(verificationUri.searchParams.get("redirect_uri")).toBe(
        "matrixos://auth?status=approved",
      );
      expect(verificationUri.searchParams.get("redirect_sig")).toEqual(expect.any(String));
    });

    it("includes a signed canonical native callback for the Electron desktop client", async () => {
      const res = await app.request("/api/auth/device/code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: "matrix-os-desktop",
          redirectUri: "matrixos://auth?status=approved",
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      const verificationUri = new URL(body.verificationUri);
      expect(verificationUri.searchParams.get("redirect_uri")).toBe(
        "matrixos://auth?status=approved",
      );
      expect(verificationUri.searchParams.get("redirect_sig")).toEqual(expect.any(String));
    });

    it("keeps the legacy app-owned scheme signable for trusted desktop clients", async () => {
      const res = await app.request("/api/auth/device/code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: "matrix-os-desktop",
          redirectUri: "matrix-os://device-auth",
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      const verificationUri = new URL(body.verificationUri);
      expect(verificationUri.searchParams.get("redirect_uri")).toBe(
        "matrix-os://device-auth",
      );
      expect(verificationUri.searchParams.get("redirect_sig")).toEqual(expect.any(String));
    });

    it("rejects arbitrary legacy scheme callbacks even for trusted desktop clients", async () => {
      const res = await app.request("/api/auth/device/code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: "matrix-os-desktop",
          redirectUri: "matrix-os://settings?status=approved",
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      const verificationUri = new URL(body.verificationUri);
      expect(verificationUri.searchParams.has("redirect_uri")).toBe(false);
      expect(verificationUri.searchParams.has("redirect_sig")).toBe(false);
    });

    it("uses the app shell origin for macOS approval even when platform API origin differs", async () => {
      process.env.PLATFORM_PUBLIC_URL = "https://api.matrix-os.com";
      process.env.NEXT_PUBLIC_MATRIX_APP_URL = "https://app.matrix-os.com";
      const { docker } = createMockDocker();
      const routedApp = createApp({
        db,
        orchestrator: createOrchestrator({ db, docker: docker as any }),
        clerkAuth: createClerkAuth({
          verifyToken: async () => ({ sub: "user_alice" }),
        }),
      });

      const res = await routedApp.request("/api/auth/device/code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: "matrix-os-macos",
          redirectUri: "matrixos://auth?status=approved",
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      const verificationUri = new URL(body.verificationUri);
      expect(verificationUri.origin).toBe("https://app.matrix-os.com");
      expect(verificationUri.pathname).toBe("/auth/device");
      expect(verificationUri.searchParams.get("redirect_uri")).toBe(
        "matrixos://auth?status=approved",
      );
      expect(verificationUri.searchParams.get("redirect_sig")).toEqual(expect.any(String));
    });

    it("ignores native callbacks for other clients or invalid schemes", async () => {
      const cliRes = await app.request("/api/auth/device/code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: "matrixos-cli",
          redirectUri: "matrixos://auth?status=approved",
        }),
      });
      const invalidRes = await app.request("/api/auth/device/code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: "matrix-os-macos",
          redirectUri: "https://evil.example/callback",
        }),
      });

      const cliBody = await cliRes.json();
      const invalidBody = await invalidRes.json();
      expect(new URL(cliBody.verificationUri).searchParams.has("redirect_uri")).toBe(false);
      expect(new URL(cliBody.verificationUri).searchParams.has("redirect_sig")).toBe(false);
      expect(new URL(invalidBody.verificationUri).searchParams.has("redirect_uri")).toBe(false);
      expect(new URL(invalidBody.verificationUri).searchParams.has("redirect_sig")).toBe(false);
    });

    it("rejects oversized body with 413", async () => {
      const huge = "x".repeat(8192);
      const body = JSON.stringify({ clientId: huge });
      const res = await app.request("/api/auth/device/code", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Force the bodyLimit middleware's Content-Length short-circuit;
          // app.request() doesn't set this automatically.
          "content-length": String(Buffer.byteLength(body)),
        },
        body,
      });

      expect(res.status).toBe(413);
    });

    it("logs JSON parse failures before returning invalid_request", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const res = await app.request("/api/auth/device/code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "invalid_request" });
      expect(errorSpy).toHaveBeenCalledWith(
        "[device/code] JSON parse failed:",
        expect.any(String),
      );
      errorSpy.mockRestore();
    });

    it("uses X-Forwarded-For as a fallback rate-limit key when no proxy IP header is present", async () => {
      for (let i = 0; i < 100; i++) {
        const res = await app.request("/api/auth/device/code", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": "203.0.113.10",
          },
          body: JSON.stringify({ clientId: "matrixos-cli" }),
        });
        expect(res.status).toBe(200);
      }

      const res = await app.request("/api/auth/device/code", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "203.0.113.10",
        },
        body: JSON.stringify({ clientId: "matrixos-cli" }),
      });

      expect(res.status).toBe(429);
      expect((await res.json()).error).toBe("too_many_requests");
    });
  });

  describe("POST /api/auth/device/token", () => {
    it("returns 428 authorization_pending before approval", async () => {
      const code = await app
        .request("/api/auth/device/code", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientId: "matrixos-cli" }),
        })
        .then((r) => r.json());

      const res = await app.request("/api/auth/device/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deviceCode: code.deviceCode,
          clientId: "matrixos-cli",
        }),
      });

      expect(res.status).toBe(428);
      const body = await res.json();
      expect(body.error).toBe("authorization_pending");
    });

    it("returns 429 slow_down on rapid polling", async () => {
      const code = await app
        .request("/api/auth/device/code", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientId: "matrixos-cli" }),
        })
        .then((r) => r.json());

      await app.request("/api/auth/device/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceCode: code.deviceCode, clientId: "matrixos-cli" }),
      });
      const res = await app.request("/api/auth/device/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceCode: code.deviceCode, clientId: "matrixos-cli" }),
      });

      expect(res.status).toBe(429);
      const body = await res.json();
      expect(body.error).toBe("slow_down");
    });

    it("logs JSON parse failures before returning invalid_request", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const res = await app.request("/api/auth/device/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "invalid_request" });
      expect(errorSpy).toHaveBeenCalledWith(
        "[device/token] JSON parse failed:",
        expect.any(String),
      );
      errorSpy.mockRestore();
    });

    it("returns 200 with a valid sync JWT after approval", async () => {
      const code = await app
        .request("/api/auth/device/code", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientId: "matrixos-cli" }),
        })
        .then((r) => r.json());

      // simulate approval (skip the HTML form -- approve directly via Clerk session)
      const setCookieRes = await app.request(
        `/auth/device?user_code=${code.userCode}`,
      );
      const cookieHeader = setCookieRes.headers.get("set-cookie") ?? "";
      const csrfMatch = cookieHeader.match(/device_csrf=([^;]+)/);
      expect(csrfMatch).toBeTruthy();
      const csrf = csrfMatch![1];

      const approveRes = await app.request("/auth/device/approve", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: "Bearer clerk-alice",
          cookie: `device_csrf=${csrf}`,
        },
        body: new URLSearchParams({
          userCode: code.userCode,
          csrf,
        }).toString(),
      });
      expect(approveRes.status).toBe(200);
      const successCsp = approveRes.headers.get("content-security-policy") ?? "";
      expect(successCsp).toContain("frame-ancestors 'none'");
      expect(successCsp).toContain("script-src 'self' https://clerk.matrix-os.com");
      expect(successCsp).not.toContain("https://challenges.cloudflare.com");
      expect(successCsp).not.toContain("worker-src");
      expect(successCsp).not.toContain("frame-src");

      const tokenRes = await app.request("/api/auth/device/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deviceCode: code.deviceCode,
          clientId: "matrixos-cli",
        }),
      });

      expect(tokenRes.status).toBe(200);
      const body = await tokenRes.json();
      expect(body).toMatchObject({
        accessToken: expect.any(String),
        userId: "user_alice",
        handle: "alice",
        expiresAt: expect.any(Number),
      });

      const claims = await verifySyncJwt(body.accessToken, { secret: JWT_SECRET });
      expect(claims.sub).toBe("user_alice");
      expect(claims.handle).toBe("alice");
    });

    it("returns a token for VPS-native users stored only in user_machines", async () => {
      await insertUserMachine(db, {
        machineId: "machine_bob",
        clerkUserId: "user_bob",
        handle: "bob",
        status: "running",
        provisionedAt: new Date().toISOString(),
      });
      const code = await app
        .request("/api/auth/device/code", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientId: "matrixos-cli" }),
        })
        .then((r) => r.json());

      const setCookieRes = await app.request(
        `/auth/device?user_code=${code.userCode}`,
      );
      const csrf = (setCookieRes.headers.get("set-cookie") ?? "").match(
        /device_csrf=([^;]+)/,
      )![1];

      const approveRes = await app.request("/auth/device/approve", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: "Bearer clerk-bob",
          cookie: `device_csrf=${csrf}`,
        },
        body: new URLSearchParams({
          userCode: code.userCode,
          csrf,
        }).toString(),
      });
      expect(approveRes.status).toBe(200);

      const tokenRes = await app.request("/api/auth/device/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deviceCode: code.deviceCode,
          clientId: "matrixos-cli",
        }),
      });

      expect(tokenRes.status).toBe(200);
      const body = await tokenRes.json();
      expect(body).toMatchObject({
        accessToken: expect.any(String),
        userId: "user_bob",
        handle: "bob",
        expiresAt: expect.any(Number),
      });

      const claims = await verifySyncJwt(body.accessToken, { secret: JWT_SECRET });
      expect(claims.sub).toBe("user_bob");
      expect(claims.handle).toBe("bob");
    });

    it("issues a runtime-scoped token for the computer selected during approval", async () => {
      await insertUserMachine(db, {
        machineId: "machine_bob_primary",
        clerkUserId: "user_bob",
        handle: "bob",
        runtimeSlot: "primary",
        status: "running",
        provisionedAt: new Date().toISOString(),
      });
      await insertUserMachine(db, {
        machineId: "machine_bob_preview",
        clerkUserId: "user_bob",
        handle: "pr-992",
        runtimeSlot: "pr-992",
        provisioningClass: "preview",
        status: "running",
        provisionedAt: new Date().toISOString(),
      });
      const authApp = createAuthRoutes({
        db,
        clerkAuth: createClerkAuth({
          verifyToken: vi.fn().mockResolvedValue({ sub: "user_bob" }),
        }),
        jwtSecret: JWT_SECRET,
        platformUrl: "https://app.matrix-os.com",
        gatewayUrlForHandle: (handle) => `https://app.matrix-os.com/vm/${handle}`,
        ignoreLegacyContainers: true,
      });
      const code = await authApp.request("/api/auth/device/code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: "matrixos-cli" }),
      }).then((response) => response.json());
      const approvalPage = await authApp.request(`/auth/device?user_code=${code.userCode}`);
      const csrf = (approvalPage.headers.get("set-cookie") ?? "").match(/device_csrf=([^;]+)/)?.[1];

      const approval = await authApp.request("/auth/device/approve", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: "Bearer clerk-bob",
          cookie: `device_csrf=${csrf}`,
        },
        body: new URLSearchParams({
          userCode: code.userCode,
          csrf: csrf ?? "",
          runtimeSlot: "pr-992",
        }).toString(),
      });
      expect(approval.status).toBe(200);

      const tokenResponse = await authApp.request("/api/auth/device/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceCode: code.deviceCode, clientId: "matrixos-cli" }),
      });
      expect(tokenResponse.status).toBe(200);
      const tokenBody = await tokenResponse.json();
      expect(tokenBody).toMatchObject({ handle: "pr-992", runtimeSlot: "pr-992" });
      await expect(verifySyncJwt(tokenBody.accessToken, { secret: JWT_SECRET })).resolves.toMatchObject({
        sub: "user_bob",
        handle: "pr-992",
        runtime_slot: "pr-992",
      });

      const meResponse = await authApp.request("/api/me", {
        headers: { authorization: `Bearer ${tokenBody.accessToken}` },
      });
      expect(meResponse.status).toBe(200);
      await expect(meResponse.json()).resolves.toMatchObject({
        handle: "pr-992",
        runtimeSlot: "pr-992",
        gatewayUrl: "https://app.matrix-os.com/vm/pr-992",
      });
    });

    it("rejects a selected computer that is not owned by the approving user", async () => {
      await insertUserMachine(db, {
        machineId: "machine_bob_preview",
        clerkUserId: "user_bob",
        handle: "pr-992",
        runtimeSlot: "pr-992",
        provisioningClass: "preview",
        status: "running",
        provisionedAt: new Date().toISOString(),
      });
      const code = await app.request("/api/auth/device/code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: "matrixos-cli" }),
      }).then((response) => response.json());
      const approvalPage = await app.request(`/auth/device?user_code=${code.userCode}`);
      const csrf = (approvalPage.headers.get("set-cookie") ?? "").match(/device_csrf=([^;]+)/)?.[1];

      const approval = await app.request("/auth/device/approve", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: "Bearer clerk-alice",
          cookie: `device_csrf=${csrf}`,
        },
        body: new URLSearchParams({
          userCode: code.userCode,
          csrf: csrf ?? "",
          runtimeSlot: "pr-992",
        }).toString(),
      });

      expect(approval.status).toBe(404);
      await expect(approval.json()).resolves.toEqual({ error: "computer_unavailable" });
    });

    it("ignores stale legacy containers when issuing VPS-native device tokens", async () => {
      await insertContainer(db, {
        handle: "stale-bob",
        clerkUserId: "user_bob",
        port: 5101,
        shellPort: 6101,
        status: "stopped",
      });
      await insertUserMachine(db, {
        machineId: "machine_bob",
        clerkUserId: "user_bob",
        handle: "bob",
        status: "running",
        provisionedAt: new Date().toISOString(),
      });
      const authApp = createAuthRoutes({
        db,
        clerkAuth: createClerkAuth({
          verifyToken: vi.fn().mockResolvedValue({ sub: "user_bob" }),
        }),
        jwtSecret: JWT_SECRET,
        platformUrl: "https://app.matrix-os.com",
        gatewayUrlForHandle: (handle) => `https://${handle}.matrix.test`,
        ignoreLegacyContainers: true,
      });
      const code = await authApp
        .request("/api/auth/device/code", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientId: "matrixos-cli" }),
        })
        .then((r) => r.json());

      const setCookieRes = await authApp.request(
        `/auth/device?user_code=${code.userCode}`,
      );
      const csrf = (setCookieRes.headers.get("set-cookie") ?? "").match(
        /device_csrf=([^;]+)/,
      )![1];

      const approveRes = await authApp.request("/auth/device/approve", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: "Bearer clerk-bob",
          cookie: `device_csrf=${csrf}`,
        },
        body: new URLSearchParams({
          userCode: code.userCode,
          csrf,
        }).toString(),
      });
      expect(approveRes.status).toBe(200);

      const tokenRes = await authApp.request("/api/auth/device/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deviceCode: code.deviceCode,
          clientId: "matrixos-cli",
        }),
      });

      expect(tokenRes.status).toBe(200);
      const body = await tokenRes.json();
      expect(body).toMatchObject({
        accessToken: expect.any(String),
        userId: "user_bob",
        handle: "bob",
      });
      const claims = await verifySyncJwt(body.accessToken, { secret: JWT_SECRET });
      expect(claims.sub).toBe("user_bob");
      expect(claims.handle).toBe("bob");
      expect(claims.gateway_url).toBe("https://bob.matrix.test");
    });
  });

  describe("POST /auth/device/approve", () => {
    it("rejects with 401 when no Clerk session is present", async () => {
      const code = await app
        .request("/api/auth/device/code", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientId: "matrixos-cli" }),
        })
        .then((r) => r.json());

      const setCookieRes = await app.request(
        `/auth/device?user_code=${code.userCode}`,
      );
      const csrf = (setCookieRes.headers.get("set-cookie") ?? "").match(
        /device_csrf=([^;]+)/,
      )![1];

      const res = await app.request("/auth/device/approve", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `device_csrf=${csrf}`,
        },
        body: new URLSearchParams({ userCode: code.userCode, csrf }).toString(),
      });
      expect(res.status).toBe(401);
    });

    it("returns a native callback handoff page after approval when requested", async () => {
      const code = await app
        .request("/api/auth/device/code", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            clientId: "matrix-os-desktop",
            redirectUri: "matrixos://auth?status=approved",
          }),
        })
        .then((r) => r.json());

      const setCookieRes = await app.request(code.verificationUri);
      const csrf = (setCookieRes.headers.get("set-cookie") ?? "").match(
        /device_csrf=([^;]+)/,
      )![1];
      const verificationUri = new URL(code.verificationUri);
      const redirectSig = verificationUri.searchParams.get("redirect_sig");
      const html = await setCookieRes.text();
      expect(html).toContain('id="native-redirect-uri"');
      expect(html).toContain('id="native-redirect-sig"');
      expect(html).toContain("matrixos://auth?status=approved");
      expect(redirectSig).toEqual(expect.any(String));

      const approveRes = await app.request("/auth/device/approve", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: "Bearer clerk-alice",
          cookie: `device_csrf=${csrf}`,
        },
        body: new URLSearchParams({
          userCode: code.userCode,
          csrf,
          redirectUri: "matrixos://auth?status=approved",
          redirectSig: redirectSig ?? "",
        }).toString(),
      });

      expect(approveRes.status).toBe(200);
      const successHtml = await approveRes.text();
      expect(successHtml).toContain("Return to Matrix OS");
      expect(successHtml).toContain("matrixos://auth?status=approved");
      expect(successHtml).toContain('http-equiv="refresh"');
    });

    it("ignores manually appended native callbacks without the macOS signature", async () => {
      const code = await app
        .request("/api/auth/device/code", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientId: "matrixos-cli" }),
        })
        .then((r) => r.json());

      const setCookieRes = await app.request(
        `/auth/device?user_code=${code.userCode}&redirect_uri=${encodeURIComponent("matrixos://auth?status=approved")}`,
      );
      const csrf = (setCookieRes.headers.get("set-cookie") ?? "").match(
        /device_csrf=([^;]+)/,
      )![1];
      const html = await setCookieRes.text();
      expect(html).not.toContain("matrixos://auth?status=approved");

      const approveRes = await app.request("/auth/device/approve", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: "Bearer clerk-alice",
          cookie: `device_csrf=${csrf}`,
        },
        body: new URLSearchParams({
          userCode: code.userCode,
          csrf,
          redirectUri: "matrixos://auth?status=approved",
        }).toString(),
      });

      expect(approveRes.status).toBe(200);
      const successHtml = await approveRes.text();
      expect(successHtml).not.toContain("matrixos://auth?status=approved");
      expect(successHtml).not.toContain('http-equiv="refresh"');
    });

    it("leaves the device code pending when approval only carries the CSRF cookie", async () => {
      const code = await app
        .request("/api/auth/device/code", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientId: "matrixos-cli" }),
        })
        .then((r) => r.json());

      const setCookieRes = await app.request(
        `/auth/device?user_code=${code.userCode}`,
      );
      const csrf = (setCookieRes.headers.get("set-cookie") ?? "").match(
        /device_csrf=([^;]+)/,
      )![1];

      const approveRes = await app.request("/auth/device/approve", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `device_csrf=${csrf}`,
        },
        body: new URLSearchParams({ userCode: code.userCode, csrf }).toString(),
      });
      expect(approveRes.status).toBe(401);

      const tokenRes = await app.request("/api/auth/device/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deviceCode: code.deviceCode,
          clientId: "matrixos-cli",
        }),
      });
      expect(tokenRes.status).toBe(428);
      await expect(tokenRes.json()).resolves.toEqual({
        error: "authorization_pending",
      });
    });

    it("rejects with 403 when CSRF cookie does not match form field", async () => {
      const code = await app
        .request("/api/auth/device/code", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientId: "matrixos-cli" }),
        })
        .then((r) => r.json());

      const res = await app.request("/auth/device/approve", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: "Bearer clerk-alice",
          cookie: `device_csrf=cookie-value`,
        },
        body: new URLSearchParams({
          userCode: code.userCode,
          csrf: "form-value-mismatch",
        }).toString(),
      });
      expect(res.status).toBe(403);
    });

    it("logs form parse failures before returning invalid_request", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const formDataSpy = vi
        .spyOn(Request.prototype, "formData")
        .mockRejectedValueOnce(new Error("form parse boom"));
      const code = await app
        .request("/api/auth/device/code", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientId: "matrixos-cli" }),
        })
        .then((r) => r.json());

      const setCookieRes = await app.request(
        `/auth/device?user_code=${code.userCode}`,
      );
      const csrf = (setCookieRes.headers.get("set-cookie") ?? "").match(
        /device_csrf=([^;]+)/,
      )![1];

      const res = await app.request("/auth/device/approve", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: "Bearer clerk-alice",
          cookie: `device_csrf=${csrf}`,
        },
        body: new URLSearchParams({
          userCode: code.userCode,
          csrf,
        }).toString(),
      });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "invalid_request" });
      expect(errorSpy).toHaveBeenCalledWith("[device-flow] Form parse failed:", "form parse boom");

      formDataSpy.mockRestore();
      errorSpy.mockRestore();
    });
  });

  describe("GET /auth/device", () => {
    it("renders the approval HTML and sets a CSRF cookie", async () => {
      const res = await app.request("/auth/device?user_code=BCDF-GHJK");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(res.headers.get("content-security-policy")).toContain("script-src");
      expect(res.headers.get("content-security-policy")).toContain("'nonce-");
      expect(res.headers.get("content-security-policy")).toContain("https://challenges.cloudflare.com");
      expect(res.headers.get("content-security-policy")).toContain("worker-src 'self' blob:");
      expect(res.headers.get("content-security-policy")).toContain("frame-src https://challenges.cloudflare.com");
      expect(res.headers.get("content-security-policy")).not.toContain("'unsafe-inline'");
      const cookie = res.headers.get("set-cookie") ?? "";
      expect(cookie).toMatch(/device_csrf=[A-Fa-f0-9]+/);
      expect(cookie).toMatch(/HttpOnly/);
      const html = await res.text();
      expect(html).toContain(">matrix login<");
      expect(html).toContain('<span class="prompt">matrix</span> whoami');
      expect(html).toContain("shell attach -c main");
      expect(html).toContain("run -it -- claude");
      expect(html).toContain('<span class="prompt">matrix</span> doctor');
      expect(html).toContain('id="instance-line"');
      expect(html).toContain('id="identity-card"');
      expect(html).toContain('id="identity-avatar"');
      expect(html).toContain('id="identity-name"');
      expect(html).toContain('id="identity-username"');
      expect(html).toContain('id="identity-email"');
      expect(html).toContain('id="computer-select"');
      expect(html).toContain("fetchWithTimeout('/api/auth/computers'");
      expect(html).toContain("body.set('runtimeSlot', selectedRuntimeSlot)");
      expect(html).toContain("return 'auth';");
      expect(html).toContain("return renderComputers(await response.json()) ? 'ok' : 'empty';");
      expect(html).toContain("if (computerState === 'error') {");
      expect(html).toContain("showSignedInRecoveryState();");
      const continueStart = html.indexOf("async function continueDeviceOnboarding");
      const inventoryRequest = html.indexOf("var computerState = await loadComputers(token);", continueStart);
      const appSessionRequest = html.indexOf("fetchWithTimeout('/api/auth/app-session'", continueStart);
      expect(inventoryRequest).toBeGreaterThan(continueStart);
      expect(appSessionRequest).toBeGreaterThan(inventoryRequest);
      expect(html.indexOf("if (computerState === 'ok') {", continueStart)).toBeLessThan(appSessionRequest);
    });

    it("starts signed-out CLI approval on signup and sends runtime setup to the shell billing tab", async () => {
      const res = await app.request("/auth/device?user_code=BCDF-GHJK");
      const html = await res.text();

      expect(html).toContain("window.Clerk.mountSignUp");
      expect(html).toContain("signInUrl: deviceAuthUrl('sign-in')");
      expect(html).toContain("window.Clerk.mountSignIn");
      expect(html).toContain("signUpUrl: deviceAuthUrl('sign-up')");
      expect(html).toContain("fallbackRedirectUrl: approvalUrl");
      expect(html).toContain("fetchWithTimeout('/api/auth/app-session'");
      expect(html).toContain("if (res.status === 402 || res.status === 404) {");
      expect(html).toContain("redirectToBillingSetup()");
      expect(html).toContain("device_return");
      expect(html).not.toContain("fetchWithTimeout('/api/auth/provision-runtime'");
      expect(html).not.toContain("fetchWithTimeout('/billing/checkout'");
      expect(html).not.toContain("Provision Matrix computer");
      expect(html).not.toContain("Start checkout");
      expect(html).toContain("confirm.disabled = true;");
      expect(html).toContain("button.disabled = isBusy || !runtimeReady;");
      expect(html).toContain("delete signin.dataset.mounted;");
      const continueStart = html.indexOf("async function continueDeviceOnboarding");
      expect(html.indexOf("var token = await clerkTokenOrNull();", continueStart)).toBeLessThan(
        html.indexOf("showLoadingState('Checking your Matrix computer...');", continueStart),
      );
      expect(html).toContain(
        '<form id="confirm-area" method="POST" action="/auth/device/approve" style="display:none">',
      );
    });

    it("routes non-native missing-runtime responses through billing setup before recovery", async () => {
      const res = await app.request("/auth/device?user_code=BCDF-GHJK");
      const html = await res.text();

      const branchStart = html.indexOf("if (res.status === 402 || res.status === 404) {");
      const nativeRuntimeSetup = html.indexOf("if (nativeApp && res.status === 404)", branchStart);
      const billingRedirect = html.indexOf("redirectToBillingSetup();", branchStart);
      const fallbackRecovery = html.indexOf("showSignedInRecoveryState();", branchStart);

      expect(branchStart).toBeGreaterThanOrEqual(0);
      expect(nativeRuntimeSetup).toBeGreaterThan(branchStart);
      expect(billingRedirect).toBeGreaterThan(nativeRuntimeSetup);
      expect(fallbackRecovery).toBeGreaterThan(billingRedirect);
      expect(html).toContain(
        "Billing-required clients enter browser billing; only native no-runtime 404s keep dedicated setup copy.",
      );
    });

    it("renders native macOS approval copy with a signed app redirect", async () => {
      const codeRes = await app.request("/api/auth/device/code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: "matrix-os-macos",
          redirectUri: "matrixos://auth?status=approved",
        }),
      });
      const code = await codeRes.json();
      const verificationUri = new URL(code.verificationUri);
      const res = await app.request(`${verificationUri.pathname}${verificationUri.search}`);
      const html = await res.text();

      expect(html).toContain("Approve Matrix OS app");
      expect(html).toContain("Authorize the desktop app");
      expect(html).toContain("var nativeApp = true;");
      expect(html).toContain("Checking Matrix OS");
      expect(html).toContain("showRuntimeSetupState()");
      expect(html).toContain("Create or activate your Matrix computer first");
      expect(html).toContain('id="native-redirect-uri"');
      expect(html).toContain('value="matrixos://auth?status=approved"');
      expect(html).toContain('id="native-redirect-sig"');
      expect(html).not.toContain("Approve Matrix CLI");
      expect(html).not.toContain("Setting up Matrix CLI");
    });

    it("submits approval with an explicit Clerk bearer token", async () => {
      const res = await app.request("/auth/device?user_code=BCDF-GHJK");
      const html = await res.text();

      expect(html).toContain("window.Clerk.session.getToken()");
      expect(html).toContain("Authorization: `Bearer ${token}`");
      expect(html).toContain("new URLSearchParams");
      expect(html).toContain("userCode");
      expect(html).toContain("csrf");
      expect(html).toContain("if (!window.Clerk) return;");
      expect(html.indexOf("if (!window.Clerk) return;")).toBeLessThan(
        html.indexOf("event.preventDefault();"),
      );
      expect(html).toContain(
        '<form id="confirm-area" method="POST" action="/auth/device/approve" style="display:none">',
      );
      expect(html).toContain("var html = await res.text();");
      expect(html.indexOf("var html = await res.text();")).toBeLessThan(
        html.indexOf("document.open();"),
      );
      expect(html).toContain('id="confirm-button"');
      expect(html).toContain('id="clerk-script"');
      expect(html).not.toContain('onload="initClerk()"');
      expect(html).toContain("forceRedirectUrl: approvalUrl");
      expect(html).toContain("fallbackRedirectUrl: approvalUrl");
      expect(html).toContain("signInForceRedirectUrl: approvalUrl");
      expect(html).not.toContain("afterSignInUrl");
    });

    it("escapes the Clerk publishable key in the approval page", async () => {
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_"bad"&<tag>';

      const res = await app.request("/auth/device?user_code=BCDF-GHJK");
      const html = await res.text();

      expect(html).toContain('data-clerk-publishable-key="pk_test_&quot;bad&quot;&amp;&lt;tag&gt;"');
      expect(html).not.toContain('data-clerk-publishable-key="pk_test_"bad"&<tag>"');
      expect(html).toMatch(/<script nonce="[^"]+"/);
    });
  });

  describe("GET /api/me", () => {
    it("returns the user's handle and gateway URL when authed with a sync JWT", async () => {
      const code = await app
        .request("/api/auth/device/code", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientId: "matrixos-cli" }),
        })
        .then((r) => r.json());

      const setCookieRes = await app.request(
        `/auth/device?user_code=${code.userCode}`,
      );
      const csrf = (setCookieRes.headers.get("set-cookie") ?? "").match(
        /device_csrf=([^;]+)/,
      )![1];

      await app.request("/auth/device/approve", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: "Bearer clerk-alice",
          cookie: `device_csrf=${csrf}`,
        },
        body: new URLSearchParams({
          userCode: code.userCode,
          csrf,
        }).toString(),
      });

      const tokenRes = await app
        .request("/api/auth/device/token", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            deviceCode: code.deviceCode,
            clientId: "matrixos-cli",
          }),
        })
        .then((r) => r.json());

      const meRes = await app.request("/api/me", {
        headers: { authorization: `Bearer ${tokenRes.accessToken}` },
      });
      expect(meRes.status).toBe(200);
      const me = await meRes.json();
      expect(me.handle).toBe("alice");
      expect(me.gatewayUrl).toBe("https://app.matrix-os.com");
    });

    it("resolves /api/me for VPS-native users stored only in user_machines", async () => {
      await insertUserMachine(db, {
        machineId: "machine_bob",
        clerkUserId: "user_bob",
        handle: "bob",
        status: "running",
        provisionedAt: new Date().toISOString(),
      });
      const code = await app
        .request("/api/auth/device/code", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientId: "matrixos-cli" }),
        })
        .then((r) => r.json());

      const setCookieRes = await app.request(
        `/auth/device?user_code=${code.userCode}`,
      );
      const csrf = (setCookieRes.headers.get("set-cookie") ?? "").match(
        /device_csrf=([^;]+)/,
      )![1];

      await app.request("/auth/device/approve", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: "Bearer clerk-bob",
          cookie: `device_csrf=${csrf}`,
        },
        body: new URLSearchParams({
          userCode: code.userCode,
          csrf,
        }).toString(),
      });
      const tokenBody = await app
        .request("/api/auth/device/token", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            deviceCode: code.deviceCode,
            clientId: "matrixos-cli",
          }),
        })
        .then((r) => r.json());

      const meRes = await app.request("/api/me", {
        headers: { authorization: `Bearer ${tokenBody.accessToken}` },
      });

      expect(meRes.status).toBe(200);
      await expect(meRes.json()).resolves.toMatchObject({
        userId: "user_bob",
        handle: "bob",
        gatewayUrl: "https://app.matrix-os.com",
      });
    });

    it("rejects a sync JWT whose subject does not own the claimed container handle", async () => {
      const issued = await issueSyncJwt({
        secret: JWT_SECRET,
        clerkUserId: "user_mallory",
        handle: "alice",
        gatewayUrl: "https://app.matrix-os.com",
      });

      const res = await app.request("/api/me", {
        headers: { authorization: `Bearer ${issued.token}` },
      });

      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
    });

    it("emits telemetry when rejecting a sync JWT for a cross-user handle lookup", async () => {
      const captureEvent = vi.fn();
      const authApp = createAuthRoutes({
        db,
        jwtSecret: JWT_SECRET,
        platformUrl: "https://app.matrix-os.com",
        gatewayUrlForHandle: () => "https://app.matrix-os.com",
        captureEvent,
      });
      const issued = await issueSyncJwt({
        secret: JWT_SECRET,
        clerkUserId: "user_mallory",
        handle: "alice",
        gatewayUrl: "https://app.matrix-os.com",
      });

      const res = await authApp.request("/api/me", {
        headers: { authorization: `Bearer ${issued.token}` },
      });

      expect(res.status).toBe(401);
      expect(captureEvent).toHaveBeenCalledWith(
        "cli_runtime_lookup_unauthorized",
        expect.objectContaining({
          source: "platform-device-auth",
          shell_surface: "cli_tui",
        }),
      );
    });

    it("rejects a sync JWT whose subject does not own the claimed VPS-native handle", async () => {
      await insertUserMachine(db, {
        machineId: "machine_bob",
        clerkUserId: "user_bob",
        handle: "bob",
        status: "running",
        provisionedAt: new Date().toISOString(),
      });
      const issued = await issueSyncJwt({
        secret: JWT_SECRET,
        clerkUserId: "user_mallory",
        handle: "bob",
        gatewayUrl: "https://app.matrix-os.com",
      });

      const res = await app.request("/api/me", {
        headers: { authorization: `Bearer ${issued.token}` },
      });

      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
    });

    it("returns 401 when Authorization header is missing", async () => {
      const res = await app.request("/api/me");
      expect(res.status).toBe(401);
    });

    it("rate limits repeated invalid JWT lookups from the same client IP", async () => {
      for (let i = 0; i < 100; i++) {
        const res = await app.request("/api/me", {
          headers: {
            authorization: "Bearer not-a-valid-sync-jwt",
            "x-forwarded-for": "203.0.113.44",
          },
        });
        expect(res.status).toBe(401);
      }

      const res = await app.request("/api/me", {
        headers: {
          authorization: "Bearer not-a-valid-sync-jwt",
          "x-forwarded-for": "203.0.113.44",
        },
      });

      expect(res.status).toBe(429);
      await expect(res.json()).resolves.toEqual({ error: "too_many_requests" });
    });
  });
});
