import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RuntimeSelectionResponseSchema } from "@matrix-os/contracts";
import { createClerkAuth } from "../../packages/platform/src/clerk-auth.js";
import {
  type PlatformDB,
  insertUserMachine,
} from "../../packages/platform/src/db.js";
import { createApp } from "../../packages/platform/src/main.js";
import { APP_SESSION_COOKIE } from "../../packages/platform/src/session-cookies.js";
import {
  issueSyncJwt,
  verifySyncJwt,
} from "../../packages/platform/src/sync-jwt.js";
import {
  JWT_SECRET,
  cleanupProxyRoutingTest,
  setupProxyRoutingTest,
  stubOrchestrator,
} from "./proxy-routing-test-utils.js";

async function insertMachine(
  db: PlatformDB,
  input: {
    clerkUserId?: string;
    handle: string;
    runtimeSlot: string;
    status?: string;
  },
): Promise<void> {
  await insertUserMachine(db, {
    machineId: `machine-${input.handle}`,
    clerkUserId: input.clerkUserId ?? "user_alice",
    handle: input.handle,
    runtimeSlot: input.runtimeSlot,
    status: input.status ?? "running",
    hetznerServerId: 100,
    publicIPv4: "203.0.113.10",
    imageVersion: "stable",
    serverType: "cpx22",
    provisionedAt: "2026-07-11T00:00:00.000Z",
  });
}

async function issueSourceToken(db: PlatformDB): Promise<string> {
  await insertMachine(db, {
    handle: "alice-source",
    runtimeSlot: "primary",
  });
  return (await issueSyncJwt({
    secret: JWT_SECRET,
    clerkUserId: "user_alice",
    handle: "alice-source",
    gatewayUrl: "https://app.matrix-os.com/vm/alice-source",
    runtimeSlot: "primary",
  })).token;
}

function createTestApp(db: PlatformDB, verifyToken = vi.fn().mockResolvedValue(null)) {
  return createApp({
    db,
    orchestrator: stubOrchestrator(),
    clerkAuth: createClerkAuth({ verifyToken }),
    platformSecret: "platform-secret-123",
  });
}

describe("trusted runtime selection route", () => {
  let db: PlatformDB;

  beforeEach(async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    process.env.MATRIX_API_ORIGIN = "https://api.matrix-os.com";
    db = await setupProxyRoutingTest();
  });

  afterEach(async () => {
    await cleanupProxyRoutingTest(db);
    delete process.env.MATRIX_API_ORIGIN;
    delete process.env.PLATFORM_PUBLIC_URL;
    delete process.env.EDGE_ROUTER_SECRET;
  });

  it("fails closed when the dedicated API origin is absent or aliases an app host", async () => {
    const sourceToken = await issueSourceToken(db);
    for (const configuredOrigin of [undefined, "https://app.matrix-os.com", "https://code.matrix-os.com"]) {
      if (configuredOrigin) process.env.MATRIX_API_ORIGIN = configuredOrigin;
      else delete process.env.MATRIX_API_ORIGIN;
      process.env.PLATFORM_PUBLIC_URL = "https://app.matrix-os.com";
      const response = await createTestApp(db).request("/api/auth/runtime-selection", {
        method: "POST",
        headers: {
          host: configuredOrigin ? new URL(configuredOrigin).host : "api.matrix-os.com",
          authorization: `Bearer ${sourceToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ slot: "primary" }),
      });
      expect(response.status).toBe(503);
      expect(JSON.stringify(await response.json())).not.toMatch(/token|eyJ/i);
    }
  });

  it("authenticates the native bearer before parsing the request body", async () => {
    const app = createTestApp(db);

    const response = await app.request("/api/auth/runtime-selection", {
      method: "POST",
      headers: {
        host: "api.matrix-os.com",
        "content-type": "application/json",
      },
      body: "not-json",
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("rejects Clerk bearer and cookie-carried sync credentials", async () => {
    const sourceToken = await issueSourceToken(db);
    const clerkApp = createTestApp(db, vi.fn().mockResolvedValue({ sub: "user_alice" }));
    const clerkResponse = await clerkApp.request("/api/auth/runtime-selection", {
      method: "POST",
      headers: {
        host: "api.matrix-os.com",
        authorization: "Bearer clerk-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({ slot: "primary" }),
    });
    const cookieResponse = await createTestApp(db).request("/api/auth/runtime-selection", {
      method: "POST",
      headers: {
        host: "api.matrix-os.com",
        cookie: `${APP_SESSION_COOKIE}=${encodeURIComponent(sourceToken)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ slot: "primary" }),
    });

    expect(clerkResponse.status).toBe(401);
    expect(cookieResponse.status).toBe(401);
    expect(JSON.stringify(await clerkResponse.json())).not.toMatch(/token|eyJ/i);
    expect(JSON.stringify(await cookieResponse.json())).not.toMatch(/token|eyJ/i);
  });

  it("denies the app and code hosts without proxying or returning a bearer", async () => {
    const sourceToken = await issueSourceToken(db);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("wrong target", { status: 200 }),
    );
    const app = createTestApp(db);

    process.env.EDGE_ROUTER_SECRET = "edge-secret";
    for (const headers of [
      { host: "app.matrix-os.com" },
      { host: "code.matrix-os.com" },
      {
        host: "matrix-platform.internal",
        "x-forwarded-host": "app.matrix-os.com",
        "x-matrix-edge-secret": "edge-secret",
      },
      {
        host: "matrix-platform.internal",
        "x-forwarded-host": "code.matrix-os.com",
        "x-matrix-edge-secret": "edge-secret",
      },
      {
        host: "app.matrix-os.com",
        "x-forwarded-host": "api.matrix-os.com",
      },
    ]) {
      const response = await app.request("/api/auth/runtime-selection", {
        method: "POST",
        headers: {
          ...headers,
          authorization: `Bearer ${sourceToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ slot: "primary" }),
      });
      expect(response.status).toBe(404);
      expect(JSON.stringify(await response.json())).not.toMatch(/token|eyJ/i);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a source credential inside the expiry skew window", async () => {
    await insertMachine(db, {
      handle: "alice-source",
      runtimeSlot: "primary",
    });
    const sourceToken = (await issueSyncJwt({
      secret: JWT_SECRET,
      clerkUserId: "user_alice",
      handle: "alice-source",
      gatewayUrl: "https://app.matrix-os.com/vm/alice-source",
      runtimeSlot: "primary",
      expiresInSec: 30,
    })).token;

    const response = await createTestApp(db).request("/api/auth/runtime-selection", {
      method: "POST",
      headers: {
        host: "api.matrix-os.com",
        authorization: `Bearer ${sourceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ slot: "primary" }),
    });

    expect(response.status).toBe(401);
    expect(JSON.stringify(await response.json())).not.toMatch(/token|eyJ/i);
  });

  it("issues an owner-scoped replacement credential for a running computer", async () => {
    const sourceToken = await issueSourceToken(db);
    await insertMachine(db, {
      handle: "alice-review",
      runtimeSlot: "review",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("wrong target", { status: 200 }),
    );

    process.env.EDGE_ROUTER_SECRET = "edge-secret";
    const response = await createTestApp(db).request("/api/auth/runtime-selection", {
      method: "POST",
      headers: {
        host: "matrix-platform.internal",
        "x-forwarded-host": "api.matrix-os.com",
        "x-matrix-edge-secret": "edge-secret",
        authorization: `Bearer ${sourceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ slot: "review" }),
    });

    expect(response.status).toBe(200);
    const body = RuntimeSelectionResponseSchema.parse(await response.json());
    expect(body).toMatchObject({ handle: "alice-review", slot: "review" });
    const sourceClaims = await verifySyncJwt(sourceToken, { secret: JWT_SECRET });
    const replacementClaims = await verifySyncJwt(body.accessToken, { secret: JWT_SECRET });
    expect(replacementClaims).toMatchObject({
      sub: "user_alice",
      handle: "alice-review",
      runtime_slot: "review",
    });
    expect(replacementClaims.exp).toBeLessThanOrEqual(sourceClaims.exp);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not select another owner's or an unavailable computer", async () => {
    const sourceToken = await issueSourceToken(db);
    await insertMachine(db, {
      clerkUserId: "user_bob",
      handle: "bob-private",
      runtimeSlot: "private",
    });
    await insertMachine(db, {
      handle: "alice-stopped",
      runtimeSlot: "stopped",
      status: "failed",
    });
    const app = createTestApp(db);

    for (const slot of ["private", "stopped"]) {
      const response = await app.request("/api/auth/runtime-selection", {
        method: "POST",
        headers: {
          host: "api.matrix-os.com",
          authorization: `Bearer ${sourceToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ slot }),
      });
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "Computer unavailable" });
    }
  });

  it("rejects invalid and oversized bodies without leaking credentials", async () => {
    const sourceToken = await issueSourceToken(db);
    const app = createTestApp(db);
    for (const [body, expectedStatus] of [
      [JSON.stringify({ slot: "../bob" }), 400],
      [JSON.stringify({ slot: "primary", padding: "x".repeat(2_000) }), 413],
    ] as const) {
      const response = await app.request("/api/auth/runtime-selection", {
        method: "POST",
        headers: {
          host: "api.matrix-os.com",
          authorization: `Bearer ${sourceToken}`,
          "content-type": "application/json",
        },
        body,
      });
      expect(response.status).toBe(expectedStatus);
      expect(JSON.stringify(await response.json())).not.toMatch(/token|eyJ|alice-source/i);
    }
  });

  it("rate limits unauthenticated source attempts before repeated verification", async () => {
    const app = createTestApp(db);
    let response: Response | undefined;
    for (let attempt = 0; attempt <= 60; attempt += 1) {
      response = await app.request("/api/auth/runtime-selection", {
        method: "POST",
        headers: {
          host: "api.matrix-os.com",
          authorization: "Bearer invalid-token",
          "content-type": "application/json",
          "cf-connecting-ip": `198.51.100.${attempt}`,
          "x-real-ip": `203.0.113.${attempt}`,
          "x-forwarded-for": `192.0.2.${attempt}`,
        },
        body: JSON.stringify({ slot: "primary" }),
      });
    }

    expect(response?.status).toBe(429);
    await expect(response?.json()).resolves.toEqual({ error: "Too many requests" });
  });

  it("rate limits repeated credential exchanges for one authenticated principal", async () => {
    const sourceToken = await issueSourceToken(db);
    const app = createTestApp(db);
    let response: Response | undefined;
    for (let attempt = 0; attempt <= 30; attempt += 1) {
      response = await app.request("/api/auth/runtime-selection", {
        method: "POST",
        headers: {
          host: "api.matrix-os.com",
          authorization: `Bearer ${sourceToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ slot: "primary" }),
      });
    }

    expect(response?.status).toBe(429);
    await expect(response?.json()).resolves.toEqual({ error: "Too many requests" });
  });
});
