import { Hono, type Context } from "hono";
import type { UpgradeWebSocket, WSEvents } from "hono/ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { CollaborationActorProofVerifier } from "../../packages/gateway/src/collaboration/actor-proof.js";
import { CollaborationAuthority } from "../../packages/gateway/src/collaboration/authority.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { registerCollaborationEventWebSocketRoute } from "../../packages/gateway/src/collaboration/event-websocket-route.js";
import { CollaborationEventRegistry } from "../../packages/gateway/src/collaboration/events.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import { CollaborationProofSigner } from "../../packages/platform/src/collaboration/proof.js";
import {
  collaborationActors,
  collaborationIds,
  createCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";

const now = new Date("2026-09-07T12:00:00.000Z");
const key = "0123456789abcdef0123456789abcdef";
const path = `/ws/collaboration/scopes/${collaborationIds.scope}/events`;

describe("shared Chat event WebSocket", () => {
  let fixture: CollaborationTestDatabase;
  let registry: CollaborationEventRegistry;

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    await seed(fixture);
  });

  afterEach(async () => {
    registry?.shutdown();
    await fixture.destroy();
  });

  it("attaches only after scoped proof authorization and resumes without duplicate history", async () => {
    const repository = new CollaborationRepository(fixture.db, { now: () => now });
    const authority = new CollaborationAuthority(repository, { now: () => now });
    registry = new CollaborationEventRegistry({
      db: fixture.db,
      authorize: (scopeId, actorId) => authority.authorize({ scopeId, actorId, action: "read" }),
      now: () => now,
      startTimers: false,
    });
    let socketEvents: WSEvents<unknown> | undefined;
    const upgradeWebSocket = ((factory: (context: Context) => WSEvents<unknown>) => (
      async (context: Context) => {
        socketEvents = factory(context);
        return context.text("upgrade captured");
      }
    )) as unknown as UpgradeWebSocket;
    const app = new Hono();
    registerCollaborationEventWebSocketRoute({
      app,
      upgradeWebSocket,
      verifier: new CollaborationActorProofVerifier({
        runtimeId: collaborationIds.runtime,
        keys: { "collaboration-key-1": key },
        now: () => now,
      }),
      authority,
      registry,
      createConnectionId: () => "connection_editor",
    });
    const signer = new CollaborationProofSigner({
      activeKeyId: "collaboration-key-1",
      keys: { "collaboration-key-1": key },
      now: () => now,
      createNonce: () => "a".repeat(32),
    });
    const signed = signer.signSocket({
      actorId: collaborationActors.editor,
      ownerId: collaborationActors.owner,
      runtimeId: collaborationIds.runtime,
      scopeId: collaborationIds.scope,
      purpose: "events",
      path,
      query: "after=1",
    });
    await app.request(`${path}?after=1`, {
      headers: { "x-matrix-collaboration-proof": Buffer.from(JSON.stringify(signed)).toString("base64url") },
    });
    const ws = { send: vi.fn(), close: vi.fn() };
    socketEvents!.onOpen?.({} as never, ws as never);
    await vi.waitFor(() => expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"type":"ready"')));
    expect(ws.send.mock.calls.map(([value]) => JSON.parse(value as string)))
      .not.toContainEqual(expect.objectContaining({ type: "changed", sequence: "1" }));

    await insertEvent(fixture, 2);
    await registry.broadcastScope(collaborationIds.scope);
    expect(ws.send.mock.calls.map(([value]) => JSON.parse(value as string)))
      .toContainEqual(expect.objectContaining({ type: "changed", sequence: "2" }));
    ws.send.mockClear();
    socketEvents!.onMessage?.({ data: JSON.stringify({
      version: 1,
      type: "resume",
      scopeId: collaborationIds.scope,
      authorityGeneration: "1",
      sequence: "2",
    }) } as never, ws as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ws.send).not.toHaveBeenCalledWith(expect.stringContaining('"type":"changed"'));
  });
});

async function seed(fixture: CollaborationTestDatabase): Promise<void> {
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
  await fixture.db.insertInto("collaboration_members").values({
    scope_id: collaborationIds.scope,
    actor_id: collaborationActors.editor,
    role: "editor",
    status: "accepted",
    invitation_id: null,
    invited_by: collaborationActors.owner,
    accepted_at: now.toISOString(),
    expires_at: null,
    revision: 1,
    joined_at: now.toISOString(),
    updated_at: now.toISOString(),
  }).execute();
  await insertEvent(fixture, 1);
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
