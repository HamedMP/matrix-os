/**
 * S20 / T099: a fenced collaboration runtime refuses new work and detaches its
 * handles so a startup fallback can destroy the owner database safely.
 */
import { Hono, type Context } from "hono";
import type { UpgradeWebSocket, WSEvents } from "hono/ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { createGatewayCollaboration } from "../../packages/gateway/src/collaboration/wiring.js";
import {
  collaborationIds,
  createCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";

describe("gateway collaboration fence", () => {
  let fixture: CollaborationTestDatabase;

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fixture.destroy();
  });

  it("refuses registration and new streams after fencing and lets a later shutdown return immediately", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const runtime = await createGatewayCollaboration({
      db: fixture.db,
      chatRepository: new ChatRepository(fixture.db),
      config: {
        runtimeId: collaborationIds.runtime,
        activeKeyId: "key-1",
        proofKeys: { "key-1": "a".repeat(32) },
        preflightSecret: "b".repeat(32),
        platformBaseUrl: "https://platform.internal",
        serviceToken: "c".repeat(32),
      },
      resolveParticipant: async (actorId) => ({ actorId, displayName: actorId }),
      resolveInvitationIdentifier: async (identifier) => ({ actorId: identifier, displayName: identifier }),
      outboxFetch: async () => new Response(null, { status: 204 }),
      startTimers: false,
    });
    runtime.fence();
    const upgradeWebSocket = ((factory: (context: Context) => WSEvents<unknown>) => (
      (context: Context) => { factory(context); return context.text("upgrade"); }
    )) as unknown as UpgradeWebSocket;
    expect(() => runtime.register({ app: new Hono(), upgradeWebSocket })).toThrow(/shutting down/);
    await expect(runtime.eventRegistry.open({
      connectionId: "connection_fenced",
      scopeId: collaborationIds.scope,
      actorId: "user_x",
      authorityGeneration: 1,
      afterSequence: 0,
      socket: { send: () => {}, close: () => {}, bufferedAmount: 0 },
    } as never)).rejects.toBeInstanceOf(Error);
    await expect(runtime.shutdown()).resolves.toBeUndefined();
    await expect(runtime.outbox.runOnce()).resolves.toBe(0);
  });
});
