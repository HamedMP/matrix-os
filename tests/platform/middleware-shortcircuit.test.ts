import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  createPlatformDb,
  type PlatformDB,
} from "../../packages/platform/src/db.js";
import { createApp } from "../../packages/platform/src/main.js";
import { createClerkAuth } from "../../packages/platform/src/clerk-auth.js";
import type { Orchestrator } from "../../packages/platform/src/orchestrator.js";

const JWT_SECRET = "test-secret-at-least-32-characters-long";

// A stub orchestrator that returns undefined from getInfo and throws from
// every mutation. The container-proxy middleware MUST NOT reach anything
// on this stub when it short-circuits device-flow paths.
function stubOrchestrator(): Orchestrator {
  return {
    provision: vi.fn().mockRejectedValue(new Error("should not be called")),
    start: vi.fn().mockRejectedValue(new Error("should not be called")),
    stop: vi.fn().mockRejectedValue(new Error("should not be called")),
    destroy: vi.fn().mockRejectedValue(new Error("should not be called")),
    upgrade: vi.fn().mockRejectedValue(new Error("should not be called")),
    rollingRestart: vi.fn().mockRejectedValue(new Error("should not be called")),
    getInfo: vi.fn().mockReturnValue(undefined),
    getImage: vi.fn().mockReturnValue("mock:latest"),
    listAll: vi.fn().mockReturnValue([]),
    syncStates: vi.fn().mockResolvedValue(undefined),
  };
}

describe("container-proxy middleware short-circuit for device-flow paths", () => {
  let tmpDir: string;
  let db: PlatformDB;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_"bad"&<tag>';
    tmpDir = mkdtempSync(join(tmpdir(), "middleware-shortcircuit-"));
    db = createPlatformDb(join(tmpDir, "test.db"));

    // Clerk stub that always fails verification -- proves the short-circuit
    // takes effect BEFORE the middleware gets a chance to call Clerk.
    const clerkAuth = createClerkAuth({
      verifyToken: vi.fn().mockRejectedValue(new Error("clerk not reachable")),
    });

    app = createApp({ db, orchestrator: stubOrchestrator(), clerkAuth });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.PLATFORM_JWT_SECRET;
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  });

  it("GET /auth/device?user_code=XYZ on Host app.matrix-os.com short-circuits to the device-flow handler (not 500/502)", async () => {
    const res = await app.request("/auth/device?user_code=BCDF-GHJK", {
      headers: { host: "app.matrix-os.com" },
    });

    // Must NOT be 500 "Clerk not configured" or 502 "Container unreachable" --
    // the middleware should let the request fall through to the device-flow
    // route registered by createAuthRoutes.
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    // device-flow's GET handler sets a CSRF cookie.
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/device_csrf=[A-Fa-f0-9]+/);
  });

  it("GET /sign-in on Host app.matrix-os.com serves an escaped Clerk page with nonce CSP", async () => {
    const res = await app.request("/sign-in", {
      headers: { host: "app.matrix-os.com" },
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("content-security-policy")).toContain("'nonce-");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(html).toContain('data-clerk-publishable-key="pk_test_&quot;bad&quot;&amp;&lt;tag&gt;"');
    expect(html).not.toContain('data-clerk-publishable-key="pk_test_"bad"&<tag>"');
    expect(html).toMatch(/<script nonce="[^"]+"/);
  });

  it("POST /api/auth/device/code on Host app.matrix-os.com does NOT proxy to a container (reaches device-flow handler)", async () => {
    const res = await app.request("/api/auth/device/code", {
      method: "POST",
      headers: {
        host: "app.matrix-os.com",
        "content-type": "application/json",
      },
      body: JSON.stringify({ clientId: "matrixos-cli" }),
    });

    // If the short-circuit failed, we'd hit the container-proxy middleware,
    // which would return 401 Unauthorized (no Clerk cookie for /api/* gateway
    // paths) or 500 "Clerk not configured". A 200 proves the device-flow
    // handler served the request directly.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      deviceCode: expect.any(String),
      userCode: expect.stringMatching(/^[A-Z]{4}-[A-Z]{4}$/),
    });
  });

  it("POST /api/auth/device/token on Host app.matrix-os.com does NOT proxy (reaches device-flow handler)", async () => {
    const res = await app.request("/api/auth/device/token", {
      method: "POST",
      headers: {
        host: "app.matrix-os.com",
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceCode: "nonexistent", clientId: "matrixos-cli" }),
    });

    // device-flow's token handler returns 410 for an unknown/expired code.
    // Anything 5xx would prove the proxy middleware swallowed the request.
    expect(res.status).toBeLessThan(500);
    expect(res.status).not.toBe(502);
    // Should be an "expired_token" / "invalid_grant" style error from the
    // device-flow handler, not a Clerk/proxy error.
    const body = await res.json().catch(() => ({}));
    expect(body.error).not.toBe("Clerk not configured");
    expect(body.error).not.toBe("Container unreachable");
  });

  it("non-device /api/* path on Host app.matrix-os.com WITHOUT a token is rejected by the middleware (401)", async () => {
    // Sanity check: short-circuit is narrow -- normal gateway paths still
    // get the container-proxy middleware's auth check.
    const res = await app.request("/api/some/other/route", {
      headers: { host: "app.matrix-os.com" },
    });
    expect(res.status).toBe(401);
  });
});
