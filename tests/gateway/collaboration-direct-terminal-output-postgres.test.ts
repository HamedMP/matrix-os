/**
 * S18 / T090 terminal replacement proof: a member reaches the owner's canonical
 * PTY over the direct route (`/ws/collaboration/direct/scopes/:scopeId/terminal`)
 * with the exact production classes the gateway wires at startup, on a real
 * PostgreSQL owner database. Output flows from the canonical runtime through the
 * bridge into the terminal event registry; workspace-wide resize stays fail-closed;
 * a stale tab incarnation is never served.
 */
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import type { UpgradeWebSocket, WSEvents } from "hono/ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COLLABORATION_DIRECT_PROTOCOL_VERSION } from "@matrix-os/contracts";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { CollaborationAuthority } from "../../packages/gateway/src/collaboration/authority.js";
import { createCanonicalTerminalCollaborationBridge } from "../../packages/gateway/src/collaboration/canonical-terminal-bridge.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { DirectReplayCache, DirectTicketVerifier } from "../../packages/gateway/src/collaboration/direct-auth.js";
import { DirectSessionService } from "../../packages/gateway/src/collaboration/direct-sessions.js";
import { registerCollaborationDirectWebSocketRoutes } from "../../packages/gateway/src/collaboration/direct-websocket.js";
import { CollaborationEventRegistry } from "../../packages/gateway/src/collaboration/events.js";
import { createOrganizationPrecondition } from "../../packages/gateway/src/collaboration/organization-precondition.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import { CollaborationTerminalAdapter } from "../../packages/gateway/src/collaboration/terminal-adapter.js";
import { TerminalControlCoordinator } from "../../packages/gateway/src/collaboration/terminal-control.js";
import { CollaborationTerminalDispatcher } from "../../packages/gateway/src/collaboration/terminal-dispatcher.js";
import { CollaborationTerminalEventRegistry } from "../../packages/gateway/src/collaboration/terminal-events.js";
import {
  ed25519PrivateKeyFromSeed, ed25519PublicKeyRaw, possessionPayload, proofKeyThumbprint,
  signEd25519, ticketSigningPayload,
} from "../../packages/platform/src/collaboration/ticket-crypto.js";
import { createRealCollaborationTestDatabase, type CollaborationTestDatabase } from "./collaboration-test-support.js";

const now = new Date("2026-09-21T18:00:00.000Z");
const machineId = "11111111-1111-4111-8111-111111111111";
const runtimeId = `vps:${machineId}`;
const logicalRuntimeId = `vps-${machineId}`;
const ownerId = "user_direct_terminal_owner";
const memberId = "user_direct_terminal_member";
const organizationId = "org_direct_terminal";
const scopeId = "10000000-0000-4000-8000-00000000d901";
const workspaceId = `tws_${"3".repeat(32)}`;
const tabId = `tt_${"4".repeat(32)}`;
const terminalId = `${workspaceId}:${tabId}`;
const createdAt = "2026-09-21T17:00:00.000Z";
const platformKey = ed25519PrivateKeyFromSeed(Buffer.alloc(32, 23).toString("base64url"));

type Frame = Record<string, unknown> & { type: string };
type FakeWs = { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; raw: { bufferedAmount: number } };

function clientKey() {
  const pair = generateKeyPairSync("ed25519");
  const raw = ed25519PublicKeyRaw(pair.publicKey);
  return { pair, raw, thumbprint: proofKeyThumbprint(raw), sign: (payload: string) => signEd25519(pair.privateKey, payload) };
}

function signedTicket(input: { actorId: string; key: ReturnType<typeof clientKey>; purpose: "direct_session" | "terminal" }) {
  const ticket = {
    protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION, ticketId: randomUUID(), nonce: randomUUID().replaceAll("-", ""),
    actorId: input.actorId, organizationId, resource: { scopeId, kind: "terminal" }, purpose: input.purpose,
    runtime: { runtimeId: logicalRuntimeId, authorityGeneration: 1 }, proofKeyThumbprint: input.key.thumbprint,
    maxActions: 100, issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 30_000).toISOString(),
  };
  return { ticket, keyId: "platform-1", signature: signEd25519(platformKey, ticketSigningPayload(ticket)) };
}

function frames(ws: FakeWs): Frame[] {
  return ws.send.mock.calls.map(([raw]) => JSON.parse(String(raw)) as Frame);
}

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("S18 direct terminal output on real Postgres", () => {
  let fixture: CollaborationTestDatabase;
  let sessions: DirectSessionService;
  let events: CollaborationEventRegistry;
  let terminalRegistry: CollaborationTerminalEventRegistry;
  let control: TerminalControlCoordinator;
  let app: Hono;
  let socketEvents: WSEvents<unknown> | undefined;
  let connections = 0;
  let tab: { id: string; workspaceId: string; createdAt: string; incarnation: string; status: string; revision: number };
  let runtime: {
    listWorkspaces: ReturnType<typeof vi.fn>;
    writeInput: ReturnType<typeof vi.fn>;
    terminateTab: ReturnType<typeof vi.fn>;
    attach: ReturnType<typeof vi.fn>;
  };
  let incarnation: string;

  beforeEach(async () => {
    fixture = await createRealCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    tab = { id: tabId, workspaceId, createdAt, incarnation: `ti_${"c".repeat(32)}`, status: "running", revision: 7 };
    runtime = {
      listWorkspaces: vi.fn(async () => [{ id: workspaceId, scope: "main", canonicalSize: { cols: 80, rows: 24 }, tabs: [tab] }]),
      writeInput: vi.fn(async () => undefined),
      terminateTab: vi.fn(async () => undefined),
      attach: vi.fn((input: { ref: unknown; onFrame(frame: unknown): void }) => {
        queueMicrotask(() => input.onFrame({
          type: "attached", terminalRef: input.ref, canonicalSize: { cols: 80, rows: 24 }, revision: 7, nextSeq: 0,
        }));
        return { close: vi.fn(), send: vi.fn() };
      }),
    };
    const repository = new CollaborationRepository(fixture.db);
    const precondition = createOrganizationPrecondition({
      source: { async assertMembership({ actorId }) { return actorId === ownerId || actorId === memberId
        ? { member: true, expiresAt: new Date(now.getTime() + 20_000).toISOString() } : { member: false }; } },
      now: () => now,
    });
    const authority = new CollaborationAuthority(repository, { organizationPrecondition: precondition, now: () => now });
    // Exactly the production composition from packages/gateway/src/startup/collaboration.ts + wiring.enableSharedTerminal.
    const bridge = createCanonicalTerminalCollaborationBridge({ db: fixture.db, ownerId, runtime: runtime as never });
    const adapter = new CollaborationTerminalAdapter({
      repository, registry: bridge.registry, runtime: bridge.runtime, runtimeId,
      executionEligibility: {
        profileId: "scope-runtime-terminal-v1", profileVersion: 1, profileDigest: "a".repeat(64), adapterId: "terminal", harnessVersion: "1.0.0",
      },
      preflightSecret: "0123456789abcdef0123456789abcdef",
      createScopeId: () => scopeId,
    });
    const preflight = await adapter.preflight({ ownerId, organizationId, terminalId });
    expect(preflight).toMatchObject({ eligible: true });
    await adapter.shareTerminal({
      ownerId, organizationId, terminalId, clientRequestId: randomUUID(), payloadHash: "b".repeat(64),
      expectedResourceRevision: preflight.resourceRevision, confirmationToken: preflight.confirmationToken!,
    });
    incarnation = (await adapter.get(scopeId, terminalId))!.incarnation;
    await fixture.db.insertInto("collaboration_members").values({
      scope_id: scopeId, actor_id: memberId, role: "viewer", status: "accepted", organization_id: organizationId,
      invitation_id: null, invited_by: ownerId, accepted_at: now, expires_at: null, revision: 1,
      joined_at: now, updated_at: now, dispositioned_at: null,
    }).execute();
    control = new TerminalControlCoordinator({ startTimer: false });
    const dispatcher = new CollaborationTerminalDispatcher({
      authority, terminal: adapter, control, resolveParticipant: async (actorId) => ({ actorId, displayName: actorId }),
    });
    terminalRegistry = new CollaborationTerminalEventRegistry({
      authorize: (id, actorId) => authority.authorize({ scopeId: id, actorId, action: "read" }),
      getTerminal: (id, terminal) => adapter.get(id, terminal),
      projectTerminal: (metadata) => dispatcher.project(metadata),
      connectOutput: bridge.connectOutput,
      now: () => now, startTimers: false,
    });
    events = new CollaborationEventRegistry({
      db: fixture.db, authorize: (id, actorId) => authority.authorize({ scopeId: id, actorId, action: "read" }), now: () => now, startTimers: false,
    });
    const verifier = new DirectTicketVerifier({
      runtimeId, platformKeys: () => [{ keyId: "platform-1", algorithm: "ed25519", publicKey: ed25519PublicKeyRaw(platformKey) }],
      controlFresh: () => true, allowedClientOrigins: ["https://app.matrix-os.com"],
      replay: new DirectReplayCache({ now: () => now }), now: () => now,
    });
    sessions = new DirectSessionService({ verifier, authority, repository, now: () => now });
    app = new Hono();
    connections = 0;
    const upgradeWebSocket = ((factory: (context: Context) => WSEvents<unknown>) => (
      async (context: Context) => { socketEvents = factory(context); return context.text("upgrade captured"); }
    )) as unknown as UpgradeWebSocket;
    registerCollaborationDirectWebSocketRoutes({
      app, upgradeWebSocket, verifier, sessions, authority, events,
      terminal: { dispatcher, registry: terminalRegistry, control },
      createConnectionId: () => `connection_${++connections}`,
    });
  });

  afterEach(async () => {
    terminalRegistry?.shutdown();
    events?.shutdown();
    control?.close();
    await sessions?.shutdown();
    await fixture?.destroy();
  });

  async function openStream(actorId: string): Promise<{ ws: FakeWs; connectionId: string }> {
    const key = clientKey();
    const sessionTicket = signedTicket({ actorId, key, purpose: "direct_session" });
    const session = await sessions.create({
      clientRequestId: randomUUID(), signedTicket: sessionTicket, proofPublicKey: key.raw,
      possession: key.sign(possessionPayload({ ticketNonce: sessionTicket.ticket.nonce, purpose: "direct_session" })),
      clientOrigin: "https://app.matrix-os.com",
    });
    const streamTicket = signedTicket({ actorId, key, purpose: "terminal" });
    socketEvents = undefined;
    const response = await app.request(`/ws/collaboration/direct/scopes/${scopeId}/terminal?ticket=${
      Buffer.from(JSON.stringify(streamTicket)).toString("base64url")}`);
    expect(response.status).toBe(200);
    const ws: FakeWs = { send: vi.fn(), close: vi.fn(), raw: { bufferedAmount: 0 } };
    socketEvents!.onOpen?.({} as never, ws as never);
    socketEvents!.onMessage?.({ data: JSON.stringify({
      protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION, type: "handshake", sessionId: session.id,
      ticketNonce: streamTicket.ticket.nonce,
      possession: key.sign(possessionPayload({ ticketNonce: streamTicket.ticket.nonce, purpose: "terminal", sessionId: session.id })),
    }) } as never, ws as never);
    return { ws, connectionId: `connection_${connections + 1}` };
  }

  it("streams canonical PTY output to a member over the direct route and drains the source with the last viewer", async () => {
    const { ws } = await openStream(memberId);
    await vi.waitFor(() => expect(frames(ws)).toContainEqual(expect.objectContaining({
      type: "terminal.ready", scopeId, resourceId: terminalId, incarnation,
    })));
    expect(runtime.attach).toHaveBeenCalledOnce();
    expect(runtime.attach).toHaveBeenCalledWith(expect.objectContaining({
      ref: { workspaceId, tabId }, expectedIncarnation: tab.incarnation, mode: "soft", size: { cols: 80, rows: 24 },
    }));
    const callbacks = runtime.attach.mock.calls[0]![0] as { onFrame(frame: unknown): void };
    callbacks.onFrame({ type: "output", terminalRef: { workspaceId, tabId }, revision: 7, seq: 1, data: "owner output" });
    await vi.waitFor(() => expect(frames(ws)).toContainEqual(expect.objectContaining({
      type: "terminal.output", scopeId, incarnation, data: "owner output",
    })));
    // A viewer cannot take control over the direct route.
    socketEvents!.onMessage?.({ data: JSON.stringify({
      type: "acquire", clientRequestId: randomUUID(), incarnation, connectionId: "connection_1",
    }) } as never, ws as never);
    await vi.waitFor(() => expect(ws.close).toHaveBeenCalledWith(1008, "Invalid frame"));
    socketEvents!.onClose?.({} as never, ws as never);
    const stream = runtime.attach.mock.results[0]!.value as { close: ReturnType<typeof vi.fn> };
    await vi.waitFor(() => expect(stream.close).toHaveBeenCalledOnce());
    expect(terminalRegistry.connectionCount).toBe(0);
  });

  it("lets the owner hold the controller and write input, but keeps workspace-wide resize fail-closed", async () => {
    const { ws } = await openStream(ownerId);
    await vi.waitFor(() => expect(frames(ws)).toContainEqual(expect.objectContaining({ type: "terminal.ready", connectionId: "connection_1" })));
    socketEvents!.onMessage?.({ data: JSON.stringify({
      type: "acquire", clientRequestId: randomUUID(), incarnation, connectionId: "connection_1",
    }) } as never, ws as never);
    await vi.waitFor(() => expect(frames(ws)).toContainEqual(expect.objectContaining({
      type: "terminal.state", terminal: expect.objectContaining({ controller: expect.objectContaining({ leaseEpoch: "1" }) }),
    })));
    socketEvents!.onMessage?.({ data: JSON.stringify({
      type: "input", clientRequestId: randomUUID(), incarnation, connectionId: "connection_1", leaseEpoch: "1", data: "echo hi\n",
    }) } as never, ws as never);
    await vi.waitFor(() => expect(runtime.writeInput).toHaveBeenCalledWith({ workspaceId, tabId }, "echo hi\n", tab.incarnation));
    expect(ws.close).not.toHaveBeenCalled();
    socketEvents!.onMessage?.({ data: JSON.stringify({
      type: "resize", clientRequestId: randomUUID(), incarnation, connectionId: "connection_1", leaseEpoch: "1", cols: 90, rows: 30,
    }) } as never, ws as never);
    await vi.waitFor(() => expect(ws.close).toHaveBeenCalledWith(1008, "Invalid frame"));
    expect(runtime.writeInput).toHaveBeenCalledOnce();
    expect(runtime.terminateTab).not.toHaveBeenCalled();
  });

  it("never serves a replaced tab: a stale incarnation closes the direct stream before any output", async () => {
    tab = { ...tab, incarnation: `ti_${"d".repeat(32)}` };
    const { ws } = await openStream(memberId);
    await vi.waitFor(() => expect(ws.close).toHaveBeenCalledWith(1008, "Invalid frame"));
    expect(frames(ws).some((frame) => frame.type === "terminal.ready")).toBe(false);
    expect(runtime.attach).not.toHaveBeenCalled();
  });
});
