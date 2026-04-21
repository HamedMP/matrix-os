import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  createPlatformDb,
  type PlatformDB,
  insertContainer,
} from "../../packages/platform/src/db.js";
import { createOrchestrator } from "../../packages/platform/src/orchestrator.js";
import { createApp } from "../../packages/platform/src/main.js";
import { createClerkAuth } from "../../packages/platform/src/clerk-auth.js";
import { verifySyncJwt } from "../../packages/platform/src/sync-jwt.js";

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
  let tmpDir: string;
  let db: PlatformDB;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    tmpDir = mkdtempSync(join(tmpdir(), "device-routes-"));
    db = createPlatformDb(join(tmpDir, "test.db"));

    const { docker } = createMockDocker();
    const orchestrator = createOrchestrator({ db, docker: docker as any });

    insertContainer(db, {
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

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.PLATFORM_JWT_SECRET;
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
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
        expiresIn: 900,
        interval: 5,
      });
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
      expect(res.headers.get("content-security-policy")).not.toContain("'unsafe-inline'");
      const cookie = res.headers.get("set-cookie") ?? "";
      expect(cookie).toMatch(/device_csrf=[A-Fa-f0-9]+/);
      expect(cookie).toMatch(/HttpOnly/);
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

    it("returns 401 when Authorization header is missing", async () => {
      const res = await app.request("/api/me");
      expect(res.status).toBe(401);
    });
  });
});
