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

  it("detaches registries and adapters when fenced after a shutdown that timed out mid-drain", async () => {
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
    // The directory outbox drain never completes, so shutdown() hangs after setting closing and
    // before it reaches the handles drained after the outbox (participant resolver, verifier).
    const outboxShutdown = vi.spyOn(runtime.outbox, "shutdown").mockImplementation(() => new Promise<void>(() => {}));
    const verifierShutdown = vi.spyOn(runtime.verifier, "shutdown");
    const hung = runtime.shutdown();
    await Promise.race([hung, new Promise((resolve) => setTimeout(resolve, 20))]);
    expect(outboxShutdown).toHaveBeenCalledOnce();
    expect(verifierShutdown).not.toHaveBeenCalled();

    // The fallback's bounded drain times out and fences: the remaining handles must detach
    // although closing was already set by the in-flight shutdown.
    runtime.fence();
    expect(verifierShutdown).toHaveBeenCalledOnce();
    await expect(runtime.eventRegistry.open({
      connectionId: "connection_after_timeout",
      scopeId: collaborationIds.scope,
      actorId: "user_x",
      authorityGeneration: 1,
      afterSequence: 0,
      socket: { send: () => {}, close: () => {}, bufferedAmount: 0 },
    } as never)).rejects.toBeInstanceOf(Error);
    expect(() => runtime.register({ app: new Hono(), upgradeWebSocket: (() => () => new Response()) as unknown as UpgradeWebSocket }))
      .toThrow(/shutting down/);
  });

  it("drains the control client when fenced so no later frame reaches the torn-down dependencies", async () => {
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
        ownerId: "user_owner",
        relayHandle: "owner-handle",
      },
      resolveParticipant: async (actorId) => ({ actorId, displayName: actorId }),
      resolveInvitationIdentifier: async (identifier) => ({ actorId: identifier, displayName: identifier }),
      outboxFetch: async () => new Response(null, { status: 204 }),
      startTimers: false,
    });
    expect(runtime.controlClient).toBeDefined();

    runtime.fence();

    // Control frames drive session revocation, grant cleanup and membership eviction, so the
    // control client must be drained by the synchronous fence, before the fence detaches the
    // registries and shuts the verifier down. A fenced client holds no stream and never dials again.
    await expect(runtime.controlClient!.connectControl("t".repeat(43))).rejects.toThrow(/shutting down/i);
    // Direct sessions are the other registry the fence must drain: ending them is what
    // notifies the event and terminal registries, which the fence detaches immediately after.
    await expect(runtime.directSessions.create({})).rejects.toMatchObject({ code: "unavailable" });

    // Fencing twice stays a no-op.
    expect(() => runtime.fence()).not.toThrow();
    await expect(runtime.controlClient!.connectControl("t".repeat(43))).rejects.toThrow(/shutting down/i);
    await expect(runtime.directSessions.create({})).rejects.toMatchObject({ code: "unavailable" });
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
