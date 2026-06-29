import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { createHmac } from "node:crypto";
import {
  insertContainer,
  insertUserMachine,
  type PlatformDB,
} from "../../packages/platform/src/db.js";
import { createApp } from "../../packages/platform/src/main.js";
import type { Orchestrator } from "../../packages/platform/src/orchestrator.js";

function bearerFor(handle: string, secret: string): string {
  return createHmac("sha256", secret).update(handle).digest("hex");
}

describe("platform/internal-integration-routes", () => {
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
  });

  function stubOrchestrator(): Orchestrator {
    return {
      provision: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      destroy: vi.fn(),
      upgrade: vi.fn(),
      rollingRestart: vi.fn(),
      getInfo: vi.fn(),
      getImage: vi.fn(),
      listAll: vi.fn().mockReturnValue([]),
      syncStates: vi.fn(),
    };
  }

  function createTestApp() {
    const internalRoutes = new Hono();
    internalRoutes.get("/probe", (c) =>
      c.json({
        clerkUserId: c.get("internalContainerClerkUserId"),
      }),
    );

    return createApp({
      db,
      orchestrator: stubOrchestrator(),
      platformSecret: "platform-secret-123",
      internalIntegrationRoutes: internalRoutes,
    });
  }

  it("rejects requests without the per-container bearer token", async () => {
    const app = createTestApp();

    const res = await app.request("/internal/containers/alice/integrations/probe");

    expect(res.status).toBe(401);
  });

  it("passes authenticated requests through with the resolved clerk user id", async () => {
    const app = createTestApp();

    const res = await app.request("/internal/containers/alice/integrations/probe", {
      headers: {
        authorization: `Bearer ${bearerFor("alice", "platform-secret-123")}`,
      },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ clerkUserId: "user_alice" });
  });

  it("authorizes VPS-native user machines when no legacy container row exists", async () => {
    await insertUserMachine(db, {
      machineId: "machine-bob",
      clerkUserId: "user_bob",
      handle: "bob",
      hetznerServerId: 456,
      publicIPv4: "203.0.113.12",
      status: "running",
      imageVersion: "matrix-os-host-dev",
      provisionedAt: "2026-05-06T00:00:00.000Z",
    });
    const app = createTestApp();

    const res = await app.request("/internal/containers/bob/integrations/probe", {
      headers: {
        authorization: `Bearer ${bearerFor("bob", "platform-secret-123")}`,
      },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ clerkUserId: "user_bob" });
  });

  it("rejects handles whose VPS machine and legacy container owners differ", async () => {
    await insertUserMachine(db, {
      machineId: "machine-alice-mismatch",
      clerkUserId: "user_other",
      handle: "alice",
      hetznerServerId: 789,
      publicIPv4: "203.0.113.13",
      status: "running",
      imageVersion: "matrix-os-host-dev",
      provisionedAt: "2026-05-06T00:00:00.000Z",
    });
    const app = createTestApp();

    const res = await app.request("/internal/containers/alice/integrations/probe", {
      headers: {
        authorization: `Bearer ${bearerFor("alice", "platform-secret-123")}`,
      },
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: "Handle owner mismatch" });
  });
});
