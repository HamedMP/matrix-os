import { Hono, type Context } from "hono";
import type { UpgradeWebSocket, WSEvents } from "hono/ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import {
  createGatewayCollaboration,
  loadGatewayCollaborationConfig,
} from "../../packages/gateway/src/collaboration/wiring.js";
import {
  collaborationIds,
  createCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";

describe("gateway collaboration wiring", () => {
  let fixture: CollaborationTestDatabase;

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
  });

  afterEach(async () => {
    await fixture.destroy();
  });

  it("fails closed on incomplete environment configuration", () => {
    expect(loadGatewayCollaborationConfig({ MATRIX_COLLABORATION_ENABLED: "true" })).toBeNull();
    expect(loadGatewayCollaborationConfig({
      MATRIX_COLLABORATION_ENABLED: "true",
      MATRIX_RUNTIME_ID: collaborationIds.runtime,
      MATRIX_COLLABORATION_ACTIVE_KEY_ID: "key-1",
      MATRIX_COLLABORATION_PROOF_KEYS: JSON.stringify({ "key-1": "a".repeat(32) }),
      MATRIX_COLLABORATION_PREFLIGHT_SECRET: "b".repeat(32),
      PLATFORM_INTERNAL_URL: "https://platform.internal",
      UPGRADE_TOKEN: "c".repeat(32),
    })).toMatchObject({ runtimeId: collaborationIds.runtime });
  });

  it("resolves dependencies before route registration and drains before database disposal", async () => {
    const runtime = await createGatewayCollaboration({
      db: fixture.db,
      config: {
        runtimeId: collaborationIds.runtime,
        activeKeyId: "key-1",
        proofKeys: { "key-1": "a".repeat(32) },
        preflightSecret: "b".repeat(32),
        platformBaseUrl: "https://platform.internal",
        serviceToken: "c".repeat(32),
      },
      resolveParticipant: async (actorId) => ({ actorId, displayName: actorId }),
      outboxFetch: async () => new Response(null, { status: 204 }),
      startTimers: false,
    });
    const app = new Hono();
    let registeredSocket = false;
    const upgradeWebSocket = ((factory: (context: Context) => WSEvents<unknown>) => {
      registeredSocket = typeof factory === "function";
      return (context: Context) => context.text("upgrade");
    }) as unknown as UpgradeWebSocket;
    runtime.register({ app, upgradeWebSocket });
    expect(registeredSocket).toBe(true);
    expect(await fixture.db.selectFrom("collaboration_schema_migrations").select("version").execute())
      .toEqual([{ version: 1 }]);
    await runtime.shutdown();
    await expect(runtime.outbox.runOnce()).resolves.toBe(0);
  });
});
