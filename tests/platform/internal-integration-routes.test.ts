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

function delegatedHeaders(handle: string, userId: string, secret = "platform-secret-123") {
  return {
    authorization: `Bearer ${bearerFor(handle, secret)}`,
    "x-platform-user-id": userId,
    "x-platform-verified": createHmac("sha256", bearerFor(handle, secret)).update(userId).digest("hex"),
  };
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

  it("resolves preview VPS handles from user_machines", async () => {
    await insertUserMachine(db, {
      machineId: "00000000-0000-4000-8000-000000001298",
      clerkUserId: "user_preview_owner",
      handle: "pr-1298",
      runtimeSlot: "pr-1298",
      provisioningClass: "preview",
      status: "running",
      provisionedAt: "2026-08-22T00:00:00.000Z",
    });
    const app = createTestApp();

    const res = await app.request("/internal/containers/pr-1298/integrations/probe", {
      headers: {
        authorization: `Bearer ${bearerFor("pr-1298", "platform-secret-123")}`,
      },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ clerkUserId: "user_preview_owner" });
  });

  it("uses an authenticated Preview collaborator for integration calls", async () => {
    await insertUserMachine(db, {
      machineId: "00000000-0000-4000-8000-000000001299",
      clerkUserId: "user_preview_owner",
      handle: "pr-1299",
      runtimeSlot: "pr-1299",
      provisioningClass: "preview",
      accessClerkUserIds: ["user_collaborator"],
      status: "running",
      provisionedAt: "2026-08-22T00:00:00.000Z",
    });
    const res = await createTestApp().request("/internal/containers/pr-1299/integrations/probe", {
      headers: delegatedHeaders("pr-1299", "user_collaborator"),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ clerkUserId: "user_collaborator" });
  });

  it("accepts an unsigned owner header from a legacy single-user customer gateway", async () => {
    await insertUserMachine(db, {
      machineId: "00000000-0000-4000-8000-000000001301",
      clerkUserId: "user_customer_owner",
      handle: "customer-1301",
      runtimeSlot: "main",
      provisioningClass: "customer",
      status: "running",
      provisionedAt: "2026-08-22T00:00:00.000Z",
    });
    const app = createTestApp();
    const res = await app.request("/internal/containers/customer-1301/integrations/probe", {
      headers: {
        authorization: `Bearer ${bearerFor("customer-1301", "platform-secret-123")}`,
        "x-platform-user-id": "user_customer_owner",
      },
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ clerkUserId: "user_customer_owner" });

    for (const headers of [
      { "x-platform-user-id": "user_stranger" },
      { "x-platform-user-id": "user_customer_owner", "x-platform-verified": "invalid" },
    ]) {
      const rejected = await app.request("/internal/containers/customer-1301/integrations/probe", {
        headers: {
          authorization: `Bearer ${bearerFor("customer-1301", "platform-secret-123")}`,
          ...headers,
        },
      });
      expect(rejected.status).toBe(401);
    }
  });

  it("rejects unsigned owner headers on shared and Preview machines", async () => {
    await insertUserMachine(db, {
      machineId: "00000000-0000-4000-8000-000000001302",
      clerkUserId: "user_customer_owner",
      handle: "customer-1302",
      runtimeSlot: "main",
      provisioningClass: "customer",
      accessClerkUserIds: ["user_collaborator"],
      status: "running",
      provisionedAt: "2026-08-22T00:00:00.000Z",
    });
    await insertUserMachine(db, {
      machineId: "00000000-0000-4000-8000-000000001303",
      clerkUserId: "user_preview_owner",
      handle: "pr-1303",
      runtimeSlot: "pr-1303",
      provisioningClass: "preview",
      status: "running",
      provisionedAt: "2026-08-22T00:00:00.000Z",
    });
    const app = createTestApp();
    for (const [handle, owner] of [
      ["customer-1302", "user_customer_owner"],
      ["pr-1303", "user_preview_owner"],
    ]) {
      const res = await app.request(`/internal/containers/${handle}/integrations/probe`, {
        headers: {
          authorization: `Bearer ${bearerFor(handle!, "platform-secret-123")}`,
          "x-platform-user-id": owner!,
        },
      });
      expect(res.status).toBe(401);
    }
  });

  it("rejects a delegated actor who cannot access the Preview machine", async () => {
    await insertUserMachine(db, {
      machineId: "00000000-0000-4000-8000-000000001300",
      clerkUserId: "user_preview_owner",
      handle: "pr-1300",
      runtimeSlot: "pr-1300",
      provisioningClass: "preview",
      accessClerkUserIds: ["user_collaborator"],
      status: "running",
      provisionedAt: "2026-08-22T00:00:00.000Z",
    });
    const res = await createTestApp().request("/internal/containers/pr-1300/integrations/probe", {
      headers: delegatedHeaders("pr-1300", "user_stranger"),
    });
    expect(res.status).toBe(403);
  });

  it("rejects an invalid delegated identity instead of falling back to the machine owner", async () => {
    const res = await createTestApp().request("/internal/containers/alice/integrations/probe", {
      headers: {
        ...delegatedHeaders("alice", "user_other"),
        "x-platform-verified": "invalid",
      },
    });
    expect(res.status).toBe(401);
  });

  it("does not delegate a personal machine's integrations to another actor", async () => {
    const res = await createTestApp().request("/internal/containers/alice/integrations/probe", {
      headers: delegatedHeaders("alice", "user_collaborator"),
    });
    expect(res.status).toBe(403);
  });
});
