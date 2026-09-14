import { readFile } from "node:fs/promises";
import type { Agent } from "undici";
import { describe, expect, it } from "vitest";
import type { PlatformDB } from "../../packages/platform/src/db.js";
import { bootstrapPlatformCollaboration } from "../../packages/platform/src/collaboration/bootstrap.js";
import {
  createPlatformCollaborationTestDatabase,
  destroyPlatformCollaborationTestDatabase,
} from "./collaboration-test-support.js";

const validEnvironment = {
  MATRIX_COLLABORATION_ENABLED: "true",
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

  it("fails closed before database startup when enabled configuration is incomplete", async () => {
    await expect(bootstrapPlatformCollaboration({
      env: { MATRIX_COLLABORATION_ENABLED: "true" },
      db: undefined as unknown as PlatformDB,
      platformSecret: "platform-secret",
      platformJwtSecret: "platform-jwt-secret",
      customerVpsProxyDispatcher: undefined as unknown as Agent,
    })).rejects.toThrow("Platform collaboration configuration is incomplete");
  });

  it("does not initialize collaboration dependencies while the feature is disabled", async () => {
    await expect(bootstrapPlatformCollaboration({
      env: {},
      db: undefined as unknown as PlatformDB,
      platformSecret: "platform-secret",
      platformJwtSecret: "platform-jwt-secret",
      customerVpsProxyDispatcher: undefined as unknown as Agent,
    })).resolves.toBeUndefined();
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

      expect(runtime).toBeDefined();
      expect(runtime?.sockets).toBeDefined();
      await runtime?.shutdown();
    } finally {
      await destroyPlatformCollaborationTestDatabase(fixture);
    }
  });
});
