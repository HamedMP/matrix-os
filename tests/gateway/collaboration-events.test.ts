import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import type { AuthorizedCollaborationContext } from "../../packages/gateway/src/collaboration/authority.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { CollaborationEventRegistry } from "../../packages/gateway/src/collaboration/events.js";
import {
  collaborationActors,
  collaborationIds,
  createCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";

const now = new Date("2026-09-07T12:00:00.000Z");

function context(actorId: string): AuthorizedCollaborationContext {
  return {
    actorId,
    ownerId: collaborationActors.owner,
    scopeId: collaborationIds.scope,
    membershipScopeId: collaborationIds.scope,
    resourceKind: "chat",
    resourceId: collaborationIds.chat,
    role: actorId === collaborationActors.owner ? "owner" : "editor",
    authEpoch: 1,
    authorityRuntimeId: collaborationIds.runtime,
    authorityGeneration: 1,
    capability: "read",
  };
}

function socket(fail = false) {
  return {
    send: vi.fn((value: string) => {
      if (fail) throw new Error("socket closed");
      void value;
    }),
    close: vi.fn(),
  };
}

describe("CollaborationEventRegistry", () => {
  let fixture: CollaborationTestDatabase;
  let allowed: Set<string>;
  let registry: CollaborationEventRegistry;

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    await seedEvents(fixture);
    allowed = new Set([collaborationActors.owner, collaborationActors.editor]);
    registry = new CollaborationEventRegistry({
      db: fixture.db,
      authorize: async (scopeId, actorId) => {
        if (scopeId !== collaborationIds.scope || !allowed.has(actorId)) throw new Error("revoked");
        return context(actorId);
      },
      now: () => now,
      startTimers: false,
    });
  });

  afterEach(async () => {
    registry.shutdown();
    await fixture.destroy();
  });

  it("awaits authorization and replays only the requested scope cursor", async () => {
    const ws = socket();
    const session = await registry.open({
      connectionId: "connection_editor",
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.editor,
      authorityGeneration: 1,
      afterSequence: 1,
      socket: ws,
    });
    expect(session.sequence).toBe(2);
    expect(ws.send.mock.calls.map(([value]) => JSON.parse(value as string))).toEqual([
      expect.objectContaining({ type: "changed", scopeId: collaborationIds.scope, sequence: "2" }),
      expect.objectContaining({ type: "ready", scopeId: collaborationIds.scope, sequence: "2" }),
    ]);
    ws.send.mockClear();
    await insertEvent(fixture, 3);
    await session.resume(2, 1);
    expect(ws.send.mock.calls.map(([value]) => JSON.parse(value as string))).toEqual([
      expect.objectContaining({ type: "changed", scopeId: collaborationIds.scope, sequence: "3" }),
    ]);
  });

  it("advances an overflowed replay cursor after requiring a canonical refresh", async () => {
    for (let sequence = 3; sequence <= 103; sequence += 1) await insertEvent(fixture, sequence);
    const ws = socket();
    const session = await registry.open({
      connectionId: "connection_overflow",
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.editor,
      authorityGeneration: 1,
      socket: ws,
    });

    expect(session.sequence).toBe(103);
    expect(ws.send.mock.calls.map(([value]) => JSON.parse(value as string))).toEqual([
      expect.objectContaining({ type: "refresh_required", sequence: "103" }),
      expect.objectContaining({ type: "ready", sequence: "103" }),
    ]);

    ws.send.mockClear();
    await registry.broadcastScope(collaborationIds.scope);
    expect(ws.send).not.toHaveBeenCalled();
    await insertEvent(fixture, 104);
    await registry.broadcastScope(collaborationIds.scope);
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"sequence":"104"'));
  });

  it("rechecks current membership for every broadcast and drains revoked actors", async () => {
    const ownerSocket = socket();
    const editorSocket = socket();
    await registry.open({
      connectionId: "connection_owner",
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.owner,
      authorityGeneration: 1,
      socket: ownerSocket,
    });
    await registry.open({
      connectionId: "connection_editor",
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.editor,
      authorityGeneration: 1,
      socket: editorSocket,
    });
    ownerSocket.send.mockClear();
    editorSocket.send.mockClear();
    allowed.delete(collaborationActors.editor);
    await insertEvent(fixture, 3);

    await registry.broadcastScope(collaborationIds.scope);
    expect(ownerSocket.send).toHaveBeenCalled();
    expect(editorSocket.send).toHaveBeenCalledWith(expect.stringContaining('"type":"unavailable"'));
    expect(editorSocket.close).toHaveBeenCalled();
    expect(registry.connectionCount).toBe(1);
  });

  it("isolates failed sends and evicts the dead sender", async () => {
    const failed = socket();
    const healthy = socket();
    await registry.open({
      connectionId: "connection_failed",
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.owner,
      authorityGeneration: 1,
      socket: failed,
    });
    await registry.open({
      connectionId: "connection_healthy",
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.editor,
      authorityGeneration: 1,
      socket: healthy,
    });
    failed.send.mockImplementation(() => {
      throw new Error("socket closed");
    });
    healthy.send.mockClear();
    await insertEvent(fixture, 3);
    await registry.broadcastScope(collaborationIds.scope);
    expect(healthy.send).toHaveBeenCalled();
    expect(registry.connectionCount).toBe(1);
  });

  it("serializes overlapping resume and broadcast delivery for one connection", async () => {
    const ws = socket();
    const session = await registry.open({
      connectionId: "connection_serialized",
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.editor,
      authorityGeneration: 1,
      afterSequence: 2,
      socket: ws,
    });
    ws.send.mockClear();
    await insertEvent(fixture, 3);

    await Promise.all([
      session.resume(2, 1),
      registry.broadcastScope(collaborationIds.scope),
    ]);

    const changed = ws.send.mock.calls
      .map(([value]) => JSON.parse(value as string) as { type: string; sequence?: string })
      .filter((frame) => frame.type === "changed" && frame.sequence === "3");
    expect(changed).toHaveLength(1);
  });

  it("enforces per-actor caps, evicts stale connections, and drains on shutdown", async () => {
    const sockets = Array.from({ length: 5 }, () => socket());
    for (let index = 0; index < 4; index += 1) {
      await registry.open({
        connectionId: `connection_${index}`,
        scopeId: collaborationIds.scope,
        actorId: collaborationActors.editor,
        authorityGeneration: 1,
        socket: sockets[index]!,
      });
    }
    await expect(registry.open({
      connectionId: "connection_4",
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.editor,
      authorityGeneration: 1,
      socket: sockets[4]!,
    })).rejects.toMatchObject({ code: "capacity" });

    registry.sweep(new Date(now.getTime() + 31_000));
    expect(registry.connectionCount).toBe(0);
    const finalSocket = socket();
    await registry.open({
      connectionId: "connection_final",
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.owner,
      authorityGeneration: 1,
      socket: finalSocket,
    });
    registry.shutdown();
    expect(finalSocket.close).toHaveBeenCalled();
    expect(registry.connectionCount).toBe(0);
  });
});

async function seedEvents(fixture: CollaborationTestDatabase): Promise<void> {
  await fixture.db.insertInto("collaboration_scopes").values({
    id: collaborationIds.scope,
    owner_type: "personal",
    owner_id: collaborationActors.owner,
    kind: "chat",
    resource_id: collaborationIds.chat,
    parent_scope_id: null,
    membership_mode: "direct",
    lifecycle: "shared",
    revision: 1,
    auth_epoch: 1,
    authority_runtime_id: collaborationIds.runtime,
    authority_generation: 1,
    execution_generation: null,
    execution_eligibility: null,
    deleted_at: null,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  }).execute();
  await fixture.db.insertInto("collaboration_events").values([1, 2].map((sequence) => ({
    scope_id: collaborationIds.scope,
    scope_seq: sequence,
    event_id: `60000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`,
    resource_kind: "chat" as const,
    resource_id: collaborationIds.chat,
    revision: sequence,
    authority_generation: 1,
    event_type: "chat.discussion_appended",
    payload: JSON.stringify({}),
    created_at: now.toISOString(),
  }))).execute();
}

async function insertEvent(fixture: CollaborationTestDatabase, sequence: number): Promise<void> {
  await fixture.db.insertInto("collaboration_events").values({
    scope_id: collaborationIds.scope,
    scope_seq: sequence,
    event_id: `60000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`,
    resource_kind: "chat",
    resource_id: collaborationIds.chat,
    revision: sequence,
    authority_generation: 1,
    event_type: "chat.discussion_appended",
    payload: JSON.stringify({}),
    created_at: now.toISOString(),
  }).execute();
}
