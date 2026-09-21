import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import type { Agent } from "undici";
import { describe, expect, it } from "vitest";
import type { PlatformDB } from "../../packages/platform/src/db.js";
import { bootstrapPlatformCollaboration } from "../../packages/platform/src/collaboration/bootstrap.js";
import {
  createPlatformCollaborationTestDatabase,
  destroyPlatformCollaborationTestDatabase,
} from "./collaboration-test-support.js";

const validEnvironment = {
  MATRIX_COLLABORATION_ACTIVE_KEY_ID: "key-1",
  MATRIX_COLLABORATION_PROOF_KEYS: JSON.stringify({ "key-1": "a".repeat(32) }),
  MATRIX_COLLABORATION_ALLOWED_ORIGINS: "https://app.matrix-os.com",
};

describe("platform collaboration bootstrap", () => {
  it("keeps collaboration composition out of the platform startup entrypoint", async () => {
    const [startupSource, bootstrapSource] = await Promise.all([
      readFile("packages/platform/src/platform-startup.ts", "utf8"),
      readFile("packages/platform/src/collaboration/bootstrap.ts", "utf8"),
    ]);

    expect(startupSource).toContain("const collaboration = await bootstrapPlatformCollaboration({");
    expect(startupSource).toContain("collaboration?.shutdown(),");
    expect(startupSource).not.toContain("loadPlatformCollaborationConfig");
    expect(startupSource).not.toContain("authenticateRuntime:");
    expect(bootstrapSource).not.toContain(".shutdown()");
  });

  it("registers fail-closed routes before database startup when configuration is incomplete", async () => {
    const composition = await bootstrapPlatformCollaboration({
      env: { MATRIX_COLLABORATION_ACTIVE_KEY_ID: "key-1" },
      db: undefined as unknown as PlatformDB,
      platformSecret: "platform-secret",
      platformJwtSecret: "platform-jwt-secret",
      customerVpsProxyDispatcher: undefined as unknown as Agent,
    });
    expect("failClosed" in composition && composition.failClosed.reason).toBe("origin_configuration_missing");
    expect(composition.sockets).toBeUndefined();
    const app = new Hono();
    composition.register(app);
    const response = await app.request("/api/collaboration/inbox");
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Collaboration unavailable" });
    await composition.shutdown();
  });

  it("fails closed with no release flag consulted when configuration is absent", async () => {
    const composition = await bootstrapPlatformCollaboration({
      env: {},
      db: undefined as unknown as PlatformDB,
      platformSecret: "platform-secret",
      platformJwtSecret: "platform-jwt-secret",
      customerVpsProxyDispatcher: undefined as unknown as Agent,
    });
    expect("failClosed" in composition).toBe(true);
  });

  it("returns an owner-shutdown runtime when collaboration is configured", async () => {
    const fixture = await createPlatformCollaborationTestDatabase();
    try {
      const runtime = await bootstrapPlatformCollaboration({
        env: validEnvironment,
        db: { kysely: fixture.collaborationDb } as unknown as PlatformDB,
        platformSecret: "platform-secret",
        platformJwtSecret: "platform-jwt-secret",
        customerVpsProxyDispatcher: {} as Agent,
      });

      expect("failClosed" in runtime).toBe(false);
      expect(runtime.sockets).toBeDefined();
      expect("cutover" in runtime && runtime.cutover).toMatchObject({
        run: expect.any(Function), resume: expect.any(Function), rollback: expect.any(Function),
      });
      await runtime.shutdown();
    } finally {
      await destroyPlatformCollaborationTestDatabase(fixture);
    }
  });
});
