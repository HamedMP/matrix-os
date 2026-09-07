import { Hono, type Context } from "hono";
import type { UpgradeWebSocket, WSEvents } from "hono/ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import {
  createGatewayCollaboration,
  loadGatewayCollaborationConfig,
} from "../../packages/gateway/src/collaboration/wiring.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
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

  it("derives the VPS runtime ID from the existing machine identity", () => {
    expect(loadGatewayCollaborationConfig({
      MATRIX_COLLABORATION_ENABLED: "true",
      MATRIX_MACHINE_ID: "11111111-1111-4111-8111-111111111111",
      MATRIX_COLLABORATION_ACTIVE_KEY_ID: "key-1",
      MATRIX_COLLABORATION_PROOF_KEYS: JSON.stringify({ "key-1": "a".repeat(32) }),
      MATRIX_COLLABORATION_PREFLIGHT_SECRET: "b".repeat(32),
      PLATFORM_INTERNAL_URL: "https://platform.internal",
      UPGRADE_TOKEN: "c".repeat(32),
    })).toMatchObject({ runtimeId: "vps:11111111-1111-4111-8111-111111111111" });
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

  it("removes expired owner-local export artifacts during startup recovery", async () => {
    await bootstrapCollaborationDatabase(fixture.db);
    await fixture.db.insertInto("collaboration_scopes").values({
      id: collaborationIds.scope,
      owner_type: "personal",
      owner_id: "user_owner",
      kind: "chat",
      resource_id: collaborationIds.chat,
      parent_scope_id: null,
      membership_mode: "direct",
      lifecycle: "shared",
      authority_runtime_id: collaborationIds.runtime,
      execution_generation: null,
      execution_eligibility: null,
      created_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-09-01T00:00:00.000Z",
      deleted_at: null,
    }).execute();
    await fixture.db.insertInto("collaboration_exports").values({
      id: "50000000-0000-4000-8000-000000000001",
      scope_id: collaborationIds.scope,
      owner_id: "user_owner",
      payload: {},
      created_at: "2026-09-01T00:00:00.000Z",
      expires_at: "2026-09-02T00:00:00.000Z",
    }).execute();

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
    expect(await fixture.db.selectFrom("collaboration_exports").select("id").execute()).toEqual([]);
    await runtime.shutdown();
  });
});
