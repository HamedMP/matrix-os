import { Hono, type Context } from "hono";
import type { UpgradeWebSocket, WSEvents } from "hono/ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { CollaborationActorProofVerifier } from "../../packages/gateway/src/collaboration/actor-proof.js";
import { CollaborationAuthority } from "../../packages/gateway/src/collaboration/authority.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import { TerminalControlCoordinator } from "../../packages/gateway/src/collaboration/terminal-control.js";
import { CollaborationTerminalDispatcher } from "../../packages/gateway/src/collaboration/terminal-dispatcher.js";
import { CollaborationTerminalEventRegistry } from "../../packages/gateway/src/collaboration/terminal-events.js";
import { registerCollaborationTerminalWebSocketRoute } from "../../packages/gateway/src/collaboration/terminal-websocket-route.js";
import { CollaborationProofSigner } from "../../packages/platform/src/collaboration/proof.js";
import {
  collaborationActors,
  collaborationIds,
  createCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";

const now = new Date("2026-09-11T12:00:00.000Z");
const key = "0123456789abcdef0123456789abcdef";
const path = `/ws/collaboration/scopes/${collaborationIds.scope}/terminal`;
const terminalId = "terminal_release";
const incarnation = `terminal-${"a".repeat(32)}`;

describe("shared terminal WebSocket", () => {
  let fixture: CollaborationTestDatabase;
  let registry: CollaborationTerminalEventRegistry;
  let control: TerminalControlCoordinator;

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    await seed(fixture);
  });

  afterEach(async () => {
    registry?.shutdown();
    control?.close();
    await fixture.destroy();
  });

  it("opens after M3 authorization and dispatches actions with the issued connection identity", async () => {
    const repository = new CollaborationRepository(fixture.db, { now: () => now });
    const authority = new CollaborationAuthority(repository, { now: () => now });
    const metadata = {
      scopeId: collaborationIds.scope,
      terminalId,
      incarnation,
      executionGeneration: 4,
      creatorActorId: collaborationActors.owner,
      createdAt: now.toISOString(),
      status: "active" as const,
    };
    const terminal = {
      get: vi.fn(async () => metadata),
      input: vi.fn(async () => undefined),
      paste: vi.fn(async () => undefined),
      resize: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    control = new TerminalControlCoordinator({ startTimer: false });
    const dispatcher = new CollaborationTerminalDispatcher({
      authority,
      terminal,
      control,
      resolveParticipant: async (actorId) => ({ actorId, displayName: "Ada" }),
    });
    registry = new CollaborationTerminalEventRegistry({
      authorize: (scopeId, actorId) => authority.authorize({ scopeId, actorId, action: "read" }),
      getTerminal: terminal.get,
      projectTerminal: (value) => dispatcher.project(value),
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
    const verifier = new CollaborationActorProofVerifier({
      runtimeId: collaborationIds.runtime,
      keys: { "collaboration-key-1": key },
      now: () => now,
      authority,
    });
    const app = new Hono();
    registerCollaborationTerminalWebSocketRoute({
      app,
      upgradeWebSocket,
      verifier,
      authority,
      dispatcher,
      registry,
      control,
      createConnectionId: () => "connection_editor",
      now: () => now,
    });
    const signer = new CollaborationProofSigner({
      activeKeyId: "collaboration-key-1",
      keys: { "collaboration-key-1": key },
      now: () => now,
      createNonce: () => "a".repeat(32),
    });
    const proof = signer.signSocket({
      actorId: collaborationActors.editor,
      ownerId: collaborationActors.owner,
      runtimeId: collaborationIds.runtime,
      scopeId: collaborationIds.scope,
      purpose: "terminal",
      path,
    });
    const policy = signer.signPolicy({
      milestone: "m3",
      revision: "1",
      mode: "enabled",
      cohort: [],
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 30_000).toISOString(),
    });
    await app.request(path, { headers: {
      "x-matrix-collaboration-proof": encoded(proof),
      "x-matrix-collaboration-policy": encoded(policy),
    } });
    const ws = { send: vi.fn(), close: vi.fn(), bufferedAmount: 0 };
    socketEvents!.onOpen?.({} as never, ws as never);
    await vi.waitFor(() => expect(parsedFrames(ws)).toContainEqual(expect.objectContaining({
      type: "terminal.ready",
      connectionId: "connection_editor",
    })));

    socketEvents!.onMessage?.({ data: JSON.stringify({
      type: "acquire",
      clientRequestId: "50000000-0000-4000-8000-000000000001",
      incarnation,
      connectionId: "connection_editor",
    }) } as never, ws as never);
    await vi.waitFor(() => expect(parsedFrames(ws)).toContainEqual(expect.objectContaining({
      type: "terminal.state",
      terminal: expect.objectContaining({
        controller: expect.objectContaining({
          actor: expect.objectContaining({ actorId: collaborationActors.editor }),
          leaseEpoch: "1",
        }),
      }),
    })));

    socketEvents!.onMessage?.({ data: JSON.stringify({
      type: "input",
      clientRequestId: "50000000-0000-4000-8000-000000000002",
      incarnation,
      connectionId: "connection_forged",
      leaseEpoch: "1",
      data: "blocked",
    }) } as never, ws as never);
    await vi.waitFor(() => expect(ws.close).toHaveBeenCalledWith(1008, "Invalid frame"));
    expect(terminal.input).not.toHaveBeenCalled();
  });
});

async function seed(fixture: CollaborationTestDatabase): Promise<void> {
  await fixture.db.insertInto("collaboration_scopes").values({
    id: collaborationIds.scope,
    owner_type: "personal",
    owner_id: collaborationActors.owner,
    kind: "terminal",
    resource_id: terminalId,
    parent_scope_id: null,
    membership_mode: "direct",
    lifecycle: "shared",
    revision: 1,
    auth_epoch: 1,
    authority_runtime_id: collaborationIds.runtime,
    authority_generation: 1,
    execution_generation: 4,
    execution_eligibility: { profileId: "scope-runtime-terminal-v1" },
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
}

function encoded(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function parsedFrames(ws: { send: ReturnType<typeof vi.fn> }): unknown[] {
  return ws.send.mock.calls.map(([value]) => JSON.parse(value as string) as unknown);
}
