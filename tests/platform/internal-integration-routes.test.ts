import { createHmac } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  createPlatformDb,
  insertContainer,
  type PlatformDB,
} from "../../packages/platform/src/db.js";
import { createApp } from "../../packages/platform/src/main.js";
import type { Orchestrator } from "../../packages/platform/src/orchestrator.js";

function bearerFor(handle: string, secret: string): string {
  return createHmac("sha256", secret).update(handle).digest("hex");
}

describe("platform/internal-integration-routes", () => {
  let tmpDir: string;
  let db: PlatformDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "platform-internal-integration-"));
    db = createPlatformDb(join(tmpDir, "test.db"));
    insertContainer(db, {
      handle: "alice",
      clerkUserId: "user_alice",
      port: 5001,
      shellPort: 6001,
      status: "running",
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
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
});
