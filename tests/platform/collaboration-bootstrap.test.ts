import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import type { Agent } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlatformDB } from "../../packages/platform/src/db.js";
import { bootstrapPlatformCollaboration } from "../../packages/platform/src/collaboration/bootstrap.js";
import {
  createPlatformCollaborationTestDatabase,
  destroyPlatformCollaborationTestDatabase,
} from "./collaboration-test-support.js";

const validEnvironment = {
  MATRIX_COLLABORATION_TICKET_ACTIVE_KEY_ID: "direct-key",
  MATRIX_COLLABORATION_TICKET_KEYS: JSON.stringify({ "direct-key": Buffer.alloc(32, 1).toString("base64url") }),
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
      env: { MATRIX_COLLABORATION_TICKET_ACTIVE_KEY_ID: "direct-key" },
      db: undefined as unknown as PlatformDB,
      platformSecret: "platform-secret",
      platformJwtSecret: "platform-jwt-secret",
      customerVpsProxyDispatcher: undefined as unknown as Agent,
    });
    expect("failClosed" in composition && composition.failClosed.reason).toBe("origin_configuration_missing");
    expect(composition.direct).toBeUndefined();
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

  it("leaves no organization timers running when the relay origin is invalid", async () => {
    const fixture = await createPlatformCollaborationTestDatabase();
    vi.useFakeTimers();
    try {
      // Baseline: timers the database fixture itself owns; bootstrap must add none.
      const baseline = vi.getTimerCount();
      const composition = await bootstrapPlatformCollaboration({
        env: { ...validEnvironment, MATRIX_COLLABORATION_RELAY_ORIGIN: "http://insecure.example" },
        db: { kysely: fixture.collaborationDb } as unknown as PlatformDB,
        platformSecret: "platform-secret",
        platformJwtSecret: "platform-jwt-secret",
        customerVpsProxyDispatcher: {} as Agent,
      });
      expect("failClosed" in composition).toBe(true);
      expect(vi.getTimerCount()).toBe(baseline);
      await composition.shutdown();
    } finally {
      vi.useRealTimers();
      await destroyPlatformCollaborationTestDatabase(fixture);
    }
  });

  it("starts with connection tickets unavailable when the ticket signing configuration is unusable", async () => {
    // A mistimed key rotation must cost the ticket route, not the platform. Each of these
    // three shapes is refused by the keyring loader, so the composition still comes up whole
    // with no issuer and no published signing key.
    const seedFor = (index: number) => Buffer.alloc(32, index).toString("base64url");
    const manyKeys = (prefix: string, count: number, offset: number) => Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`${prefix}-${index + 1}`, seedFor(offset + index + 1)]),
    );
    const recent = new Date(Date.now() - 60_000).toISOString();
    const unusable = [
      { name: "future-dated retirement", env: { MATRIX_COLLABORATION_TICKET_RETIRED_AT: JSON.stringify({ "ticket-key-1": new Date(Date.now() + 3 * 60 * 60_000).toISOString() }) } },
      { name: "malformed JSON", env: { MATRIX_COLLABORATION_TICKET_RETIRED_AT: "{not json" } },
      { name: "unparseable date", env: { MATRIX_COLLABORATION_TICKET_RETIRED_AT: JSON.stringify({ "ticket-key-1": "yesterday" }) } },
      {
        // Under each half of the key cap, over the combined total the issuer publishes.
        name: "more keys than the issuer publishes",
        env: {
          MATRIX_COLLABORATION_TICKET_ACTIVE_KEY_ID: "active-key-1",
          MATRIX_COLLABORATION_TICKET_KEYS: JSON.stringify(manyKeys("active-key", 5, 0)),
          MATRIX_COLLABORATION_TICKET_RETIRED_KEYS: JSON.stringify(manyKeys("retired-key", 5, 10)),
          MATRIX_COLLABORATION_TICKET_RETIRED_AT: JSON.stringify(Object.fromEntries(Object.keys(manyKeys("retired-key", 5, 10)).map((keyId) => [keyId, recent]))),
        },
      },
    ];
    for (const { name, env: unusableEnv } of unusable) {
      const fixture = await createPlatformCollaborationTestDatabase();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const runtime = await bootstrapPlatformCollaboration({
          env: {
            ...validEnvironment,
            MATRIX_COLLABORATION_TICKET_ACTIVE_KEY_ID: "ticket-key-2",
            MATRIX_COLLABORATION_TICKET_KEYS: JSON.stringify({ "ticket-key-2": Buffer.alloc(32, 2).toString("base64url") }),
            MATRIX_COLLABORATION_TICKET_RETIRED_KEYS: JSON.stringify({ "ticket-key-1": Buffer.alloc(32, 1).toString("base64url") }),
            ...unusableEnv,
          },
          db: { kysely: fixture.collaborationDb } as unknown as PlatformDB,
          platformSecret: "platform-secret",
          platformJwtSecret: "platform-jwt-secret",
          customerVpsProxyDispatcher: {} as Agent,
        });
        // The platform starts: this is a real composition, not the fail-closed registrar.
        expect(`${name}: ${"failClosed" in runtime}`).toBe(`${name}: false`);
        expect(`${name}: ${"direct" in runtime && runtime.direct?.issuer === null}`).toBe(`${name}: true`);
        await runtime.shutdown();
      } finally {
        warn.mockRestore();
        await destroyPlatformCollaborationTestDatabase(fixture);
      }
    }
  });

  it("returns an owner-shutdown runtime when collaboration is configured", async () => {
  it("fails closed when only retired V1 proof keys are configured", async () => {
    const composition = await bootstrapPlatformCollaboration({
      env: {
        MATRIX_COLLABORATION_ALLOWED_ORIGINS: "https://app.matrix-os.com",
        MATRIX_COLLABORATION_ACTIVE_KEY_ID: "legacy-key",
        MATRIX_COLLABORATION_PROOF_KEYS: JSON.stringify({ "legacy-key": "a".repeat(32) }),
      },
      db: undefined as unknown as PlatformDB,
      platformSecret: "platform-secret",
      platformJwtSecret: "platform-jwt-secret",
      customerVpsProxyDispatcher: undefined as unknown as Agent,
    });
    expect("failClosed" in composition && composition.failClosed.reason).toBe("signing_configuration_missing");
  });

  it("starts direct ticket authority without V1 proof keys", async () => {
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
      expect(runtime.direct?.issuer).toBeDefined();
      expect("cutover" in runtime && runtime.cutover).toMatchObject({
        run: expect.any(Function), resume: expect.any(Function), rollback: expect.any(Function),
      });
      await runtime.shutdown();
    } finally {
      await destroyPlatformCollaborationTestDatabase(fixture);
    }
  });
});
