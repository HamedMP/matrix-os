/**
 * S05 / T025, T027, T028: the home verifies platform-signed connection
 * tickets and client proof of possession, exchanges each ticket once for a
 * bounded identity session, signs every request against that session, and
 * ends sessions on expiry, evidence loss, revocation or shutdown. No owner
 * cookie or generic gateway login participates.
 */
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COLLABORATION_DIRECT_PROTOCOL_VERSION } from "@matrix-os/contracts";
import {
  ed25519PrivateKeyFromSeed,
  ed25519PublicKeyRaw,
  possessionPayload,
  proofKeyThumbprint,
  signEd25519,
  ticketSigningPayload,
} from "../../packages/platform/src/collaboration/ticket-crypto.js";
import { CollaborationAuthority } from "../../packages/gateway/src/collaboration/authority.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import { createOrganizationPrecondition } from "../../packages/gateway/src/collaboration/organization-precondition.js";
import { DirectAuthError, DirectReplayCache, DirectTicketVerifier } from "../../packages/gateway/src/collaboration/direct-auth.js";
import { DirectSessionService } from "../../packages/gateway/src/collaboration/direct-sessions.js";
import { requestSigningPayload, sha256Hex } from "../../packages/gateway/src/collaboration/direct-crypto.js";
import { CollaborationControlClient, loadDefaultConnector } from "../../packages/gateway/src/collaboration/control-client.js";
import {
  collaborationActors,
  collaborationIds,
  createCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";

const now = new Date("2026-09-21T09:00:00.000Z");
const machineId = "11111111-1111-4111-8111-111111111111";
const runtimeId = `vps:${machineId}`;
const logicalRuntimeId = `vps-${machineId}`;
const organizationId = "org_direct_1";
const scopeId = "10000000-0000-4000-8000-000000000101";
const platformSeed = Buffer.alloc(32, 7).toString("base64url");
const platformKey = ed25519PrivateKeyFromSeed(platformSeed);
const platformPublicKey = ed25519PublicKeyRaw(platformKey);
const clientOrigin = "https://app.matrix-os.com";

function clientKey() {
  const pair = generateKeyPairSync("ed25519");
  const raw = ed25519PublicKeyRaw(pair.publicKey);
  return { pair, raw, thumbprint: proofKeyThumbprint(raw), sign: (payload: string) => signEd25519(pair.privateKey, payload) };
}

function ticketFor(input: { actorId: string; key: ReturnType<typeof clientKey>; purpose?: string; overrides?: Record<string, unknown>; keyId?: string; signer?: typeof platformKey; issuedAt?: Date }) {
  const issuedAt = input.issuedAt ?? now;
  const ticket = {
    protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION,
    ticketId: randomUUID(),
    nonce: randomUUID().replaceAll("-", ""),
    actorId: input.actorId,
    organizationId,
    resource: { scopeId, kind: "chat" },
    purpose: input.purpose ?? "direct_session",
    runtime: { runtimeId: logicalRuntimeId, authorityGeneration: 1 },
    proofKeyThumbprint: input.key.thumbprint,
    maxActions: 1000,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 30_000).toISOString(),
    ...input.overrides,
  };
  return { ticket, keyId: input.keyId ?? "platform-key-1", signature: signEd25519(input.signer ?? platformKey, ticketSigningPayload(ticket)) };
}

function sessionRequest(actorId: string, key = clientKey(), extra: Record<string, unknown> = {}) {
  const signedTicket = ticketFor({ actorId, key, ...extra });
  return {
    key,
    body: {
      clientRequestId: randomUUID(),
      signedTicket,
      proofPublicKey: key.raw,
      possession: key.sign(possessionPayload({ ticketNonce: signedTicket.ticket.nonce, purpose: signedTicket.ticket.purpose })),
      clientOrigin,
    },
  };
}

describe("S05 direct sessions on the home", () => {
  let fixture: CollaborationTestDatabase;
  let clock: Date;
  let members: Set<string>;
  let service: DirectSessionService;
  let authority: CollaborationAuthority;
  let controlFresh: boolean;
  let admitted: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    clock = new Date(now);
    controlFresh = true;
    fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db as never);
    await bootstrapCollaborationDatabase(fixture.db);
    await fixture.db.insertInto("collaboration_scopes").values({
      id: scopeId, owner_type: "personal", owner_id: collaborationActors.owner, organization_id: organizationId, kind: "chat",
      resource_id: "chat_direct", parent_scope_id: null, membership_mode: "direct", lifecycle: "shared",
      authority_runtime_id: runtimeId, execution_generation: null, execution_eligibility: null, deleted_at: null, created_at: now, updated_at: now,
    }).execute();
    for (const [actorId, role, status] of [[collaborationActors.owner, "owner", "accepted"], [collaborationActors.editor, "editor", "accepted"], [collaborationActors.viewer, "viewer", "pending"]] as const) {
      await fixture.db.insertInto("collaboration_members").values({
        scope_id: scopeId, actor_id: actorId, role, status, organization_id: organizationId, invitation_id: status === "pending" ? randomUUID() : null,
        invited_by: collaborationActors.owner, accepted_at: status === "accepted" ? now : null, expires_at: status === "pending" ? new Date(now.getTime() + 86_400_000) : null, revision: 1,
        joined_at: status === "accepted" ? now : null, updated_at: now, dispositioned_at: null,
      }).execute();
    }
    members = new Set([collaborationActors.owner, collaborationActors.editor, collaborationActors.viewer]);
    const precondition = createOrganizationPrecondition({
      source: { assertMembership: async ({ actorId }) => (members.has(actorId) ? { member: true, expiresAt: new Date(clock.getTime() + 20_000).toISOString() } : { member: false }) },
      now: () => clock,
    });
    const repository = new CollaborationRepository(fixture.db, { chatRepository: undefined as never });
    authority = new CollaborationAuthority(repository, { organizationPrecondition: precondition, now: () => clock });
    const verifier = new DirectTicketVerifier({
      runtimeId,
      platformKeys: () => [{ keyId: "platform-key-1", algorithm: "ed25519", publicKey: platformPublicKey }],
      controlFresh: () => controlFresh,
      allowedClientOrigins: [clientOrigin],
      replay: new DirectReplayCache({ maxEntries: 4, now: () => clock }),
      now: () => clock,
    });
    admitted = vi.fn();
    service = new DirectSessionService({ verifier, authority, repository, now: () => clock, limits: { perHome: 6, perScope: 5, perActorScope: 2 }, onAdmitted: admitted });
  });

  afterEach(async () => {
    await service.shutdown();
    await fixture.destroy();
  });

  it("exchanges a valid ticket once for a bounded identity session with fresh organization evidence", async () => {
    const { body } = sessionRequest(collaborationActors.editor);
    const session = await service.create(body);
    expect(session).toMatchObject({ protocolVersion: 2, actorId: collaborationActors.editor, organizationId, scopeId, runtimeId: logicalRuntimeId, authorityGeneration: 1, purpose: "direct_session" });
    expect(Date.parse(session.expiresAt) - Date.parse(session.issuedAt)).toBe(300_000);
    expect(Date.parse(session.evidenceExpiresAt) - Date.parse(session.issuedAt)).toBeLessThanOrEqual(20_000);
    await expect(service.create(body)).rejects.toMatchObject({ code: "replayed" });
  });

  it("notifies revocation enforcement only after a fresh session creation or renewal succeeds", async () => {
    const { body, key } = sessionRequest(collaborationActors.editor);
    const session = await service.create(body);
    expect(admitted).toHaveBeenCalledTimes(1);
    expect(admitted).toHaveBeenLastCalledWith(session);
    await expect(service.create(body)).rejects.toMatchObject({ code: "replayed" });
    expect(admitted).toHaveBeenCalledTimes(1);
    const fresh = sessionRequest(collaborationActors.editor, key);
    const renewed = await service.renew(session.id, { clientRequestId: randomUUID(), signedTicket: fresh.body.signedTicket });
    expect(admitted).toHaveBeenCalledTimes(2);
    expect(admitted).toHaveBeenLastCalledWith(renewed);
  });

  it("rejects tampering: audience, unknown key, wrong runtime, stale generation, bad origin, wrong proof key, old protocol", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ keyId: "platform-key-9" }, "invalid_ticket"],
      [{ overrides: { runtime: { runtimeId: "vps-22222222-2222-4222-8222-222222222222", authorityGeneration: 1 } } }, "invalid_ticket"],
      [{ overrides: { runtime: { runtimeId: logicalRuntimeId, authorityGeneration: 7 } } }, "stale_generation"],
      [{ overrides: { protocolVersion: 1 } }, "upgrade_required"],
      [{ issuedAt: new Date(now.getTime() - 60_000) }, "invalid_ticket"],
    ];
    for (const [extra, code] of cases) {
      const key = clientKey();
      const signedTicket = ticketFor({ actorId: collaborationActors.editor, key, ...(extra as object) });
      const body = {
        clientRequestId: randomUUID(), signedTicket, proofPublicKey: key.raw,
        possession: key.sign(possessionPayload({ ticketNonce: signedTicket.ticket.nonce, purpose: "direct_session" })), clientOrigin,
      };
      await expect(service.create(body), code).rejects.toMatchObject({ code });
    }
    const { body } = sessionRequest(collaborationActors.editor);
    // Audience tampering after signing: the signature no longer covers the ticket.
    const swapped = { ...body.signedTicket, ticket: { ...body.signedTicket.ticket, actorId: collaborationActors.owner } };
    await expect(service.create({ ...body, signedTicket: swapped })).rejects.toMatchObject({ code: "invalid_ticket" });
    await expect(service.create({ ...body, clientOrigin: "https://evil.example" })).rejects.toMatchObject({ code: "invalid_origin" });
    const other = clientKey();
    await expect(service.create({ ...body, proofPublicKey: other.raw, possession: other.sign(possessionPayload({ ticketNonce: body.signedTicket.ticket.nonce, purpose: "direct_session" })) }))
      .rejects.toMatchObject({ code: "invalid_ticket" });
    const forged = ticketFor({ actorId: collaborationActors.editor, key: clientKey(), signer: ed25519PrivateKeyFromSeed(Buffer.alloc(32, 9).toString("base64url")) });
    await expect(service.create({ ...body, signedTicket: forged })).rejects.toMatchObject({ code: "invalid_ticket" });
  });

  it("denies outsiders, revoked evidence and unknown scopes generically, but admits an invited member for direct_session only", async () => {
    members.delete(collaborationActors.editor);
    await expect(service.create(sessionRequest(collaborationActors.editor).body)).rejects.toMatchObject({ code: "denied" });
    await expect(service.create(sessionRequest("user_outsider").body)).rejects.toMatchObject({ code: "denied" });
    await expect(service.create(sessionRequest(collaborationActors.owner, clientKey(), { overrides: { resource: { scopeId: "10000000-0000-4000-8000-0000000000ff", kind: "chat" } } }).body)).rejects.toMatchObject({ code: "denied" });
    await expect(service.create(sessionRequest(collaborationActors.viewer).body)).resolves.toMatchObject({ actorId: collaborationActors.viewer });
    // A non-session purpose never opens a session, whoever presents it; invitees get no events ticket from the platform at all.
    await expect(service.create(sessionRequest(collaborationActors.viewer, clientKey(), { purpose: "events" }).body)).rejects.toMatchObject({ code: "invalid_ticket" });
  });

  it("authenticates signed requests, refuses digest mismatch and nonce replay, and stops at expiry", async () => {
    const { body, key } = sessionRequest(collaborationActors.editor);
    const session = await service.create(body);
    const bodyBytes = new TextEncoder().encode(JSON.stringify({ text: "hello" }));
    const signature = {
      protocolVersion: 2, sessionId: session.id, method: "POST", path: `/api/collaboration/scopes/${scopeId}/discussion/messages`, query: "",
      bodyDigest: sha256Hex(bodyBytes), conditionalHeadersDigest: sha256Hex(new Uint8Array()), nonce: randomUUID().replaceAll("-", ""), issuedAt: clock.toISOString(),
    };
    const proof = key.sign(requestSigningPayload(signature));
    const request = { sessionId: session.id, signature, proof, method: "POST" as const, path: signature.path, query: "", body: bodyBytes };
    const context = await service.authorize({ ...request, action: "discuss" });
    expect(context).toMatchObject({ actorId: collaborationActors.editor, scopeId, role: "editor" });
    await expect(service.authorize({ ...request, action: "discuss" })).rejects.toMatchObject({ code: "replayed" });
    const tampered = { ...request, signature: { ...signature, nonce: randomUUID().replaceAll("-", "") }, body: new TextEncoder().encode("{}") };
    await expect(service.authorize({ ...tampered, proof: key.sign(requestSigningPayload(tampered.signature)), action: "discuss" })).rejects.toMatchObject({ code: "invalid_signature" });
    await expect(service.authorize({ ...request, signature: { ...signature, nonce: randomUUID().replaceAll("-", "") }, action: "manage_members" })).rejects.toMatchObject({ code: "invalid_signature" });
    clock = new Date(clock.getTime() + 301_000);
    const late = { ...signature, nonce: randomUUID().replaceAll("-", ""), issuedAt: clock.toISOString() };
    await expect(service.authorize({ ...request, signature: late, proof: key.sign(requestSigningPayload(late)), action: "discuss" })).rejects.toMatchObject({ code: "expired" });
  });

  it("refreshes organization evidence at its fixed deadline and denies when membership ended", async () => {
    const { body, key } = sessionRequest(collaborationActors.editor);
    const session = await service.create(body);
    const sign = () => {
      const signature = {
        protocolVersion: 2, sessionId: session.id, method: "GET", path: `/api/collaboration/scopes/${scopeId}`, query: "",
        bodyDigest: sha256Hex(new Uint8Array()), conditionalHeadersDigest: sha256Hex(new Uint8Array()), nonce: randomUUID().replaceAll("-", ""), issuedAt: clock.toISOString(),
      };
      return { sessionId: session.id, signature, proof: key.sign(requestSigningPayload(signature)), method: "GET" as const, path: signature.path, query: "", body: new Uint8Array(), action: "read" as const };
    };
    clock = new Date(clock.getTime() + 21_000);
    await expect(service.authorize(sign())).resolves.toMatchObject({ actorId: collaborationActors.editor });
    members.delete(collaborationActors.editor);
    clock = new Date(clock.getTime() + 21_000);
    await expect(service.authorize(sign())).rejects.toMatchObject({ code: "denied" });
    expect(service.describe(session.id)).toBeNull();
  });

  it("ends sessions on a platform denial and renews only with a fresh ticket", async () => {
    const editor = await service.create(sessionRequest(collaborationActors.editor).body);
    const ownerKey = clientKey();
    const owner = await service.create(sessionRequest(collaborationActors.owner, ownerKey).body);
    const ended = service.revoke({ actorId: collaborationActors.editor, generation: 2, fencedAt: clock.toISOString(), ackDeadline: new Date(clock.getTime() + 25_000).toISOString(), state: "pending" });
    expect(ended).toEqual([editor.id]);
    expect(service.describe(owner.id)).not.toBeNull();
    // Renewal needs a fresh ticket for the same actor, scope and proof key; another key never renews this session.
    const foreign = sessionRequest(collaborationActors.owner).body;
    await expect(service.renew(owner.id, { clientRequestId: randomUUID(), signedTicket: foreign.signedTicket })).rejects.toMatchObject({ code: "invalid_ticket" });
    const { body } = sessionRequest(collaborationActors.owner, ownerKey);
    const renewed = await service.renew(owner.id, { clientRequestId: randomUUID(), signedTicket: body.signedTicket });
    expect(renewed.id).toBe(owner.id);
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.parse(owner.expiresAt) - 1);
    await expect(service.renew(owner.id, { clientRequestId: randomUUID(), signedTicket: body.signedTicket })).rejects.toMatchObject({ code: "replayed" });
    service.close(owner.id);
    expect(service.describe(owner.id)).toBeNull();
  });

  it("bounds connections per actor, scope and home and refuses admission when replay retention cannot be kept", async () => {
    const session = await service.create(sessionRequest(collaborationActors.editor).body);
    const first = service.connections.open({ sessionId: session.id });
    service.connections.open({ sessionId: session.id });
    expect(() => service.connections.open({ sessionId: session.id })).toThrow(DirectAuthError);
    first.release();
    expect(() => service.connections.open({ sessionId: session.id })).not.toThrow();
    // Replay cache holds four entries; once full with unexpired nonces, admission is refused rather than forgetting one.
    await service.create(sessionRequest(collaborationActors.owner).body);
    await service.create(sessionRequest(collaborationActors.owner).body);
    await service.create(sessionRequest(collaborationActors.owner).body);
    await expect(service.create(sessionRequest(collaborationActors.owner).body)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("denies every exchange while the control snapshot is stale, and resource generations are checked against the scope", async () => {
    controlFresh = false;
    await expect(service.create(sessionRequest(collaborationActors.editor).body)).rejects.toMatchObject({ code: "unavailable" });
    controlFresh = true;
    await fixture.db.updateTable("collaboration_scopes").set({ authority_generation: 4 }).where("id", "=", scopeId).execute();
    await expect(service.create(sessionRequest(collaborationActors.editor).body)).rejects.toMatchObject({ code: "stale_generation" });
    await expect(service.create(sessionRequest(collaborationActors.editor, clientKey(), { overrides: { runtime: { runtimeId: logicalRuntimeId, authorityGeneration: 4 } } }).body)).resolves.toMatchObject({ authorityGeneration: 4 });
  });

  it("spends the ticket's signed maxActions per authorized request and stream input, then denies and ends the session", async () => {
    const { body, key } = sessionRequest(collaborationActors.editor, clientKey(), { overrides: { maxActions: 2 } });
    const session = await service.create(body);
    const sign = () => {
      const signature = { protocolVersion: 2, sessionId: session.id, method: "GET", path: `/api/collaboration/scopes/${scopeId}`, query: "", bodyDigest: sha256Hex(new Uint8Array()), conditionalHeadersDigest: sha256Hex(new Uint8Array()), nonce: randomUUID().replaceAll("-", ""), issuedAt: clock.toISOString() };
      return { sessionId: session.id, signature, proof: key.sign(requestSigningPayload(signature)), method: "GET" as const, path: signature.path, query: "", body: new Uint8Array(), action: "read" as const };
    };
    expect(service.actionsRemaining(session.id)).toBe(2);
    await expect(service.authorize(sign())).resolves.toBeTruthy();
    expect(() => service.spendStreamInput(session.id)).not.toThrow();
    expect(service.actionsRemaining(session.id)).toBe(0);
    const ended: string[] = [];
    service.subscribeEnded((s, reason) => { ended.push(`${s.id}:${reason}`); });
    await expect(service.authorize(sign())).rejects.toMatchObject({ code: "limit" });
    expect(ended).toEqual([`${session.id}:exhausted`]);
    expect(service.describe(session.id)).toBeNull();
  });

  it("re-checks the stream ticket's expiry when the possession frame is consumed and notifies subscribers on denial", async () => {
    const { body, key } = sessionRequest(collaborationActors.editor);
    const session = await service.create(body);
    const streamTicket = ticketFor({ actorId: collaborationActors.editor, key, purpose: "events" });
    const verified = service["options"].verifier.verifyTicket(streamTicket);
    clock = new Date(clock.getTime() + 31_000);
    await expect(service.openStream({ ticket: verified, handshake: { sessionId: session.id, ticketNonce: verified.nonce, possession: key.sign(possessionPayload({ ticketNonce: verified.nonce, purpose: "events", sessionId: session.id })) } }))
      .rejects.toMatchObject({ code: "invalid_ticket" });
    const fresh = service["options"].verifier.verifyTicket(ticketFor({ actorId: collaborationActors.editor, key, purpose: "events", issuedAt: clock }));
    const opened = await service.openStream({ ticket: fresh, handshake: { sessionId: session.id, ticketNonce: fresh.nonce, possession: key.sign(possessionPayload({ ticketNonce: fresh.nonce, purpose: "events", sessionId: session.id })) } });
    const ended: string[] = [];
    const unsubscribe = service.subscribeEnded((s, reason) => { ended.push(`${s.id}:${reason}`); });
    service.revoke({ actorId: collaborationActors.editor });
    expect(ended).toEqual([`${session.id}:revoked`]);
    unsubscribe();
    opened.release();
  });

  it("resolves the ws-backed control connector under ESM", async () => {
    const connector = await loadDefaultConnector();
    expect(typeof connector).toBe("function");
  });

  it("drains every session and connection on shutdown", async () => {
    const session = await service.create(sessionRequest(collaborationActors.editor).body);
    service.connections.open({ sessionId: session.id });
    await service.shutdown();
    expect(service.describe(session.id)).toBeNull();
    await expect(service.create(sessionRequest(collaborationActors.owner).body)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("registers with the platform, applies pushed denials and acknowledges fences (control client)", async () => {
    const sent: unknown[] = [];
    const fetches: Array<{ url: string; init: RequestInit }> = [];
    const editor = await service.create(sessionRequest(collaborationActors.editor).body);
    const client = new CollaborationControlClient({
      platformBaseUrl: "https://platform.internal",
      runtimeId,
      ownerId: collaborationActors.owner,
      relayHandle: "owner-handle",
      serviceToken: "s".repeat(40),
      identity: { keyId: "home-key-1", publicKey: clientKey().raw },
      sessions: service,
      fetchImpl: (async (url: string, init: RequestInit) => {
        fetches.push({ url, init });
        return new Response(JSON.stringify({ protocolVersion: 2, runtime: { runtimeId: logicalRuntimeId, authorityGeneration: 1, registeredAt: clock.toISOString() }, platformSigningKeys: [{ keyId: "platform-key-1", algorithm: "ed25519", publicKey: platformPublicKey }], controlTicket: "t".repeat(43), relay: { origin: clientOrigin } }), { status: 200, headers: { "content-type": "application/json" } });
      }) as never,
      connect: () => ({ send: (value: string) => { sent.push(JSON.parse(value)); }, close: () => undefined }),
      now: () => clock,
      startTimers: false,
    });
    const registration = await client.register();
    expect(registration.platformSigningKeys).toEqual([{ keyId: "platform-key-1", algorithm: "ed25519", publicKey: platformPublicKey }]);
    expect(JSON.parse(String(fetches[0]!.init.body))).toMatchObject({ protocolVersion: 2, runtimeId: logicalRuntimeId, ownerId: collaborationActors.owner, relayHandle: "owner-handle", publicKeys: [{ keyId: "home-key-1" }] });
    expect(new Headers(fetches[0]!.init.headers).get("x-matrix-runtime-id")).toBe(runtimeId);
    const stream = await client.connectControl(registration.controlTicket);
    await stream.receive(JSON.stringify({ protocolVersion: 2, type: "denial", denial: { actorId: collaborationActors.editor, generation: 2, fencedAt: clock.toISOString(), ackDeadline: new Date(clock.getTime() + 25_000).toISOString(), state: "pending" } }));
    expect(service.describe(editor.id)).toBeNull();
    expect(sent.at(-1)).toMatchObject({ protocolVersion: 2, runtimeId: logicalRuntimeId, authorityGeneration: 2 });
    await stream.receive(JSON.stringify({ protocolVersion: 2, type: "generation", runtimeId: logicalRuntimeId, authorityGeneration: 3 }));
    expect(client.authorityGeneration()).toBe(3);
    await expect(stream.receive("{\"protocolVersion\":1}")).rejects.toThrow();
    await client.shutdown();
  });
});
