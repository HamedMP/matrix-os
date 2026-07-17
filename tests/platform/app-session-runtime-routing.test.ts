import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createClerkAuth } from "../../packages/platform/src/clerk-auth.js";
import { type PlatformDB, insertUserMachine } from "../../packages/platform/src/db.js";
import { createApp } from "../../packages/platform/src/main.js";
import { APP_SESSION_COOKIE } from "../../packages/platform/src/session-cookies.js";
import { resolveAppDomainIdentity } from "../../packages/platform/src/session-routing-identity.js";
import { issueSyncJwt } from "../../packages/platform/src/sync-jwt.js";
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
    publicIPv4: string;
  },
): Promise<void> {
  await insertUserMachine(db, {
    machineId: `machine-${input.handle}`,
    clerkUserId: input.clerkUserId ?? "user_alice",
    handle: input.handle,
    runtimeSlot: input.runtimeSlot,
    status: "running",
    hetznerServerId: 100,
    publicIPv4: input.publicIPv4,
    imageVersion: "dev",
    serverType: "cpx22",
    provisionedAt: "2026-07-16T00:00:00.000Z",
  });
}

describe("browser app-session runtime routing", () => {
  let db: PlatformDB;

  beforeEach(async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    db = await setupProxyRoutingTest();
  });

  afterEach(async () => {
    await cleanupProxyRoutingTest(db);
  });

  async function primarySessionCookie(): Promise<string> {
    const issued = await issueSyncJwt({
      secret: JWT_SECRET,
      clerkUserId: "user_alice",
      handle: "alice-primary",
      gatewayUrl: "https://app.matrix-os.com/vm/alice-primary",
      runtimeSlot: "primary",
    });
    return `${APP_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
  }

  it("keeps a selected same-owner computer when the app session names primary", async () => {
    await insertMachine(db, {
      handle: "alice-primary",
      runtimeSlot: "primary",
      publicIPv4: "203.0.113.20",
    });
    await insertMachine(db, {
      handle: "alice-review",
      runtimeSlot: "review",
      publicIPv4: "203.0.113.21",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("review", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({ verifyToken: vi.fn().mockResolvedValue(null) }),
      platformSecret: "platform-secret-123",
    });

    const response = await app.request("/api/projects", {
      headers: {
        host: "app.matrix-os.com",
        cookie: [
          await primarySessionCookie(),
          "matrix_shell_route=alice-review",
          "matrix_shell_runtime_slot=review",
        ].join("; "),
      },
    });

    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://203.0.113.21:443/api/projects");
  });

  it("does not let a route cookie move an app session to another owner", async () => {
    await insertMachine(db, {
      handle: "alice-primary",
      runtimeSlot: "primary",
      publicIPv4: "203.0.113.20",
    });
    await insertMachine(db, {
      clerkUserId: "user_bob",
      handle: "bob-review",
      runtimeSlot: "review",
      publicIPv4: "203.0.113.22",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("primary", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({ verifyToken: vi.fn().mockResolvedValue(null) }),
      platformSecret: "platform-secret-123",
    });

    const response = await app.request("/api/projects", {
      headers: {
        host: "app.matrix-os.com",
        cookie: [
          await primarySessionCookie(),
          "matrix_shell_route=bob-review",
          "matrix_shell_runtime_slot=review",
        ].join("; "),
      },
    });

    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://203.0.113.20:443/api/projects");
  });

  it("falls back to the signed app-session machine when the selected machine is missing", async () => {
    await insertMachine(db, {
      handle: "alice-primary",
      runtimeSlot: "primary",
      publicIPv4: "203.0.113.20",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("primary", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({ verifyToken: vi.fn().mockResolvedValue(null) }),
      platformSecret: "platform-secret-123",
    });

    const response = await app.request("/api/projects", {
      headers: {
        host: "app.matrix-os.com",
        cookie: [
          await primarySessionCookie(),
          "matrix_shell_route=missing-review",
          "matrix_shell_runtime_slot=review",
        ].join("; "),
      },
    });

    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://203.0.113.20:443/api/projects");
  });

  it("keeps principal-only resolution independent from selected machine cookies", async () => {
    await insertMachine(db, {
      handle: "alice-review",
      runtimeSlot: "review",
      publicIPv4: "203.0.113.21",
    });
    const cookieHeader = [
      await primarySessionCookie(),
      "matrix_shell_route=alice-review",
      "matrix_shell_runtime_slot=review",
    ].join("; ");

    const identity = await resolveAppDomainIdentity({
      authHeader: undefined,
      cookieHeader,
      db,
      platformJwtSecret: JWT_SECRET,
      clerkPrincipalOnly: true,
      requestedHandle: "alice-review",
      runtimeSlot: "review",
    });

    expect(identity).toMatchObject({
      handle: "alice-primary",
      userId: "user_alice",
      runtimeSlot: "primary",
      source: "auth",
    });
  });
});
