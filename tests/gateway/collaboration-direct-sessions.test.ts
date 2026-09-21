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
import { CollaborationCapabilityRepository } from "../../packages/gateway/src/collaboration/capability-repository.js";
import { CollaborationCapabilityEvaluator } from "../../packages/gateway/src/collaboration/capability-evaluator.js";
import { OrganizationMembershipClient } from "../../packages/gateway/src/collaboration/organization-membership-client.js";
import {
  collaborationActors,
  collaborationIds,
  createRealCollaborationTestDatabase,
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
    fixture = process.env.MATRIX_TEST_POSTGRES_URL
      ? await createRealCollaborationTestDatabase()
      : await createCollaborationTestDatabase();
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

  it("fences synchronously: live sessions end once, their end hooks fire and new work is refused", async () => {
    const ended: Array<[string, string]> = [];
    const unsubscribe = service.subscribeEnded((session, reason) => { ended.push([session.id, reason]); });
    const editor = await service.create(sessionRequest(collaborationActors.editor).body);
    const owner = await service.create(sessionRequest(collaborationActors.owner).body);

    service.fence();

    // Ending every live session is what drives notifyRevoked and invalidateActor into the
    // event and terminal registries, so it must happen before the fence detaches them.
    expect(ended.map(([, reason]) => reason)).toEqual(["shutdown", "shutdown"]);
    expect(new Set(ended.map(([id]) => id))).toEqual(new Set([editor.id, owner.id]));
    expect(service.describe(editor.id)).toBeNull();
    expect(service.describe(owner.id)).toBeNull();
    await expect(service.create(sessionRequest(collaborationActors.editor).body)).rejects.toMatchObject({ code: "unavailable" });

    // A second fence ends nothing twice.
    service.fence();
    expect(ended).toHaveLength(2);
    unsubscribe();
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
    await expect(service.runStreamInput(session.id, async () => undefined)).resolves.toBeUndefined();
    expect(service.actionsRemaining(session.id)).toBe(0);
    const ended: string[] = [];
    service.subscribeEnded((s, reason) => { ended.push(`${s.id}:${reason}`); });
    await expect(service.authorize(sign())).rejects.toMatchObject({ code: "limit" });
    expect(ended).toEqual([`${session.id}:exhausted`]);
    expect(service.describe(session.id)).toBeNull();
  });

  it("keeps the signed action budget when a correctly signed request fails local authorization", async () => {
    const { body, key } = sessionRequest(collaborationActors.editor, clientKey(), { overrides: { maxActions: 1 } });
    const session = await service.create(body);
    const sign = (action: "read" | "manage_members") => {
      const signature = { protocolVersion: 2, sessionId: session.id, method: "GET", path: `/api/collaboration/scopes/${scopeId}`, query: "",
        bodyDigest: sha256Hex(new Uint8Array()), conditionalHeadersDigest: sha256Hex(new Uint8Array()),
        nonce: randomUUID().replaceAll("-", ""), issuedAt: clock.toISOString() };
      return { sessionId: session.id, signature, proof: key.sign(requestSigningPayload(signature)), method: "GET" as const,
        path: signature.path, query: "", body: new Uint8Array(), action };
    };
    await expect(service.authorize(sign("manage_members"))).rejects.toMatchObject({ code: "invalid_signature" });
    expect(service.actionsRemaining(session.id)).toBe(1);
    await expect(service.authorize(sign("read"))).resolves.toMatchObject({ actorId: collaborationActors.editor });
    expect(service.actionsRemaining(session.id)).toBe(0);
  });

  it("does not spend stream admission when local authorization rejects it", async () => {
    const { body, key } = sessionRequest(collaborationActors.editor, clientKey(), { overrides: { maxActions: 3 } });
    const session = await service.create(body);
    const open = async () => {
      const ticket = service["options"].verifier.verifyTicket(ticketFor({ actorId: collaborationActors.editor, key, purpose: "events" }));
      return service.openStream({ ticket, handshake: { sessionId: session.id, ticketNonce: ticket.nonce,
        possession: key.sign(possessionPayload({ ticketNonce: ticket.nonce, purpose: "events", sessionId: session.id })) } });
    };
    await fixture.db.updateTable("collaboration_members").set({ status: "revoked" })
      .where("scope_id", "=", scopeId).where("actor_id", "=", collaborationActors.editor).execute();
    await expect(open()).rejects.toMatchObject({ code: "denied" });
    expect(service.actionsRemaining(session.id)).toBe(3);
  });

  it("does not spend stream admission when the connection limit rejects it or a downstream open fails", async () => {
    const { body, key } = sessionRequest(collaborationActors.editor, clientKey(), { overrides: { maxActions: 3 } });
    const session = await service.create(body);
    const open = async () => {
      const ticket = service["options"].verifier.verifyTicket(ticketFor({ actorId: collaborationActors.editor, key, purpose: "events" }));
      return service.openStream({ ticket, handshake: { sessionId: session.id, ticketNonce: ticket.nonce,
        possession: key.sign(possessionPayload({ ticketNonce: ticket.nonce, purpose: "events", sessionId: session.id })) } });
    };
    const first = await open();
    const second = await open();
    expect(service.actionsRemaining(session.id)).toBe(1);
    await expect(open()).rejects.toMatchObject({ code: "limit" });
    expect(service.actionsRemaining(session.id)).toBe(1);
    first.commitAdmission();
    first.release();
    second.release();
    expect(service.actionsRemaining(session.id)).toBe(2);
  });

  it("reserves concurrent stream inputs and refunds a rejected operation without ending the session", async () => {
    const session = await service.create(sessionRequest(collaborationActors.editor, clientKey(), { overrides: { maxActions: 1 } }).body);
    let rejectFirst!: (error: Error) => void;
    const work = new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
    const first = service.runStreamInput(session.id, () => work);
    expect(service.actionsRemaining(session.id)).toBe(0);
    await expect(service.runStreamInput(session.id, async () => undefined)).rejects.toMatchObject({ code: "limit" });
    expect(service.describe(session.id)).not.toBeNull();
    rejectFirst(new Error("local authorization denied"));
    await expect(first).rejects.toThrow("local authorization denied");
    expect(service.actionsRemaining(session.id)).toBe(1);
    await expect(service.runStreamInput(session.id, async () => undefined)).resolves.toBeUndefined();
    expect(service.actionsRemaining(session.id)).toBe(0);
  });

  it("does not refund an old pending action into a renewed ticket budget", async () => {
    const { body, key } = sessionRequest(collaborationActors.editor, clientKey(), { overrides: { maxActions: 1 } });
    const session = await service.create(body);
    let rejectFirst!: (error: Error) => void;
    const pending = service.runStreamInput(session.id, () => new Promise<void>((_resolve, reject) => { rejectFirst = reject; }));
    expect(service.actionsRemaining(session.id)).toBe(0);
    const fresh = sessionRequest(collaborationActors.editor, key, { overrides: { maxActions: 1 } });
    await service.renew(session.id, { clientRequestId: randomUUID(), signedTicket: fresh.body.signedTicket });
    rejectFirst(new Error("old action rejected"));
    await expect(pending).rejects.toThrow("old action rejected");
    expect(service.actionsRemaining(session.id)).toBe(1);
    await service.runStreamInput(session.id, async () => undefined);
    expect(service.actionsRemaining(session.id)).toBe(0);
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

  function controlClient(extra: Partial<ConstructorParameters<typeof CollaborationControlClient>[0]> = {}) {
    const sent: Array<Record<string, unknown>> = [];
    const client = new CollaborationControlClient({
      platformBaseUrl: "https://platform.internal",
      runtimeId,
      ownerId: collaborationActors.owner,
      relayHandle: "owner-handle",
      serviceToken: "s".repeat(40),
      identity: { keyId: "home-key-1", publicKey: clientKey().raw },
      sessions: service,
      fetchImpl: (async () => new Response(JSON.stringify({ protocolVersion: 2, runtime: { runtimeId: logicalRuntimeId, authorityGeneration: 1, registeredAt: clock.toISOString() }, platformSigningKeys: [{ keyId: "platform-key-1", algorithm: "ed25519", publicKey: platformPublicKey }], controlTicket: "t".repeat(43), relay: { origin: clientOrigin } }), { status: 200, headers: { "content-type": "application/json" } })) as never,
      connect: () => ({ send: (value: string) => { sent.push(JSON.parse(value) as Record<string, unknown>); }, close: () => undefined }),
      now: () => clock,
      startTimers: false,
      ...extra,
    });
    return { client, sent };
  }

  it("refuses a plaintext platform origin unless it is loopback, like the other collaboration clients", async () => {
    const base = { runtimeId, ownerId: collaborationActors.owner, relayHandle: "owner-handle", serviceToken: "s".repeat(40), identity: { keyId: "home-key-1", publicKey: clientKey().raw }, sessions: service, startTimers: false };
    expect(() => new CollaborationControlClient({ ...base, platformBaseUrl: "http://platform.internal" })).toThrow(/unavailable/i);
    expect(() => new CollaborationControlClient({ ...base, platformBaseUrl: "http://10.0.0.5:8080" })).toThrow(/unavailable/i);
    expect(() => new CollaborationControlClient({ ...base, platformBaseUrl: "https://user:pw@platform.internal" })).toThrow(/unavailable/i);
    expect(() => new CollaborationControlClient({ ...base, platformBaseUrl: "http://127.0.0.1:3100" })).not.toThrow();
    expect(() => new CollaborationControlClient({ ...base, platformBaseUrl: "https://platform.internal" })).not.toThrow();
  });

  it("bounds the session-ended listener registry and frees a slot on unsubscribe", () => {
    const unsubscribes: Array<() => void> = [];
    for (let index = 0; index < DirectSessionService.MAX_ENDED_LISTENERS; index += 1) unsubscribes.push(service.subscribeEnded(() => undefined));
    expect(() => service.subscribeEnded(() => undefined)).toThrow(expect.objectContaining({ code: "limit" }));
    unsubscribes[0]!();
    expect(() => service.subscribeEnded(() => undefined)).not.toThrow();
    for (const unsubscribe of unsubscribes) unsubscribe();
  });

  it("applies control frames in order: a later denial or keepalive never acknowledges before an earlier denial's cleanup finishes", async () => {
    let releaseFirst!: () => void;
    const firstCleanup = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const cleanups: string[] = [];
    const capabilities = {
      endActorGrants: async ({ actorId }: { organizationId: string; actorId: string }) => {
        cleanups.push(actorId);
        if (actorId === collaborationActors.editor) await firstCleanup;
        return { ended: 0, scopes: 0 };
      },
    };
    const { client, sent } = controlClient({ capabilities: capabilities as never });
    const stream = await client.connectControl((await client.register()).controlTicket);
    const denial = (actorId: string, generation: number) => JSON.stringify({ protocolVersion: 2, type: "denial", denial: { organizationId, actorId, generation, fencedAt: clock.toISOString(), ackDeadline: new Date(clock.getTime() + 25_000).toISOString(), state: "pending" } });
    const first = stream.receive(denial(collaborationActors.editor, 2));
    const second = stream.receive(denial(collaborationActors.viewer, 3));
    const keepalive = stream.receive(JSON.stringify({ protocolVersion: 2, type: "generation", runtimeId: logicalRuntimeId, authorityGeneration: 3 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Nothing may be acknowledged while the first denial's grant cleanup is still pending.
    expect(sent).toEqual([]);
    expect(cleanups).toEqual([collaborationActors.editor]);
    releaseFirst();
    await Promise.all([first, second, keepalive]);
    expect(cleanups).toEqual([collaborationActors.editor, collaborationActors.viewer]);
    expect(sent.map((ack) => ack.authorityGeneration)).toEqual([2, 3, 3]);
    await client.shutdown();
  });

  it("stops applying queued control frames once a frame fails and refuses frames after termination", async () => {
    const revoked: Array<{ actorId?: string; generation: number }> = [];
    const sent: Array<Record<string, unknown>> = [];
    let closes = 0;
    let releaseFirst!: () => void;
    const firstCleanup = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const capabilities = {
      endActorGrants: async ({ actorId }: { organizationId: string; actorId: string }) => {
        if (actorId === collaborationActors.editor) await firstCleanup;
        return { ended: 0, scopes: 0 };
      },
    };
    const { client } = controlClient({
      capabilities: capabilities as never,
      sessions: { revoke: (denial: { actorId?: string; generation: number }) => { revoked.push(denial); } } as never,
      connect: () => ({ send: (value: string) => { sent.push(JSON.parse(value) as Record<string, unknown>); }, close: () => { closes += 1; } }),
    });
    const stream = await client.connectControl((await client.register()).controlTicket);
    const denial = (actorId: string, generation: number) => JSON.stringify({ protocolVersion: 2, type: "denial", denial: { organizationId, actorId, generation, fencedAt: clock.toISOString(), ackDeadline: new Date(clock.getTime() + 25_000).toISOString(), state: "pending" } });
    const first = stream.receive(denial(collaborationActors.editor, 2));
    const invalid = stream.receive("{\"protocolVersion\":1}");
    const queued = stream.receive(denial(collaborationActors.viewer, 5));
    releaseFirst();
    await first;
    await expect(invalid).rejects.toThrow();
    // The invalid frame terminated the stream, so the frame queued behind it is never applied.
    await expect(queued).rejects.toThrow();
    expect(closes).toBeGreaterThan(0);
    expect(revoked.map((entry) => entry.actorId)).toEqual([collaborationActors.editor]);
    expect(sent.map((ack) => ack.authorityGeneration)).toEqual([2]);
    expect(client.authorityGeneration()).toBe(2);
    // Frames arriving after termination are refused outright: no revoke, no fence move, no acknowledgement.
    await expect(stream.receive(denial(collaborationActors.viewer, 6))).rejects.toThrow();
    expect(revoked).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(client.authorityGeneration()).toBe(2);
    await client.shutdown();
  });

  it("abandons in-flight acknowledgement work when it drains mid-cleanup", async () => {
    const sent: Array<Record<string, unknown>> = [];
    let closes = 0;
    let releaseCleanup!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const revoked: string[] = [];
    const { client } = controlClient({
      capabilities: { endActorGrants: async () => { await blocked; return { ended: 1, scopes: 1 }; } } as never,
      sessions: { revoke: (denial: { actorId?: string }) => { revoked.push(denial.actorId ?? ""); } } as never,
      connect: () => ({ send: (value: string) => { sent.push(JSON.parse(value) as Record<string, unknown>); }, close: () => { closes += 1; } }),
    });
    const stream = await client.connectControl((await client.register()).controlTicket);
    const inFlight = stream.receive(JSON.stringify({ protocolVersion: 2, type: "denial", denial: { organizationId, actorId: collaborationActors.editor, generation: 2, fencedAt: clock.toISOString(), ackDeadline: new Date(clock.getTime() + 25_000).toISOString(), state: "pending" } }));
    // Let the frame reach its pending grant cleanup before the drain starts.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(revoked).toEqual([collaborationActors.editor]);

    await client.shutdown();
    expect(closes).toBe(1);
    releaseCleanup();
    await inFlight.catch(() => undefined);

    // The drain has already torn down the dependencies this frame would touch, so the resumed
    // frame must not acknowledge a fence for a runtime that has stopped serving.
    expect(sent).toEqual([]);
  });

  it("fences synchronously: the stream closes, the reconnect never rearms and a second fence is a no-op", async () => {
    vi.useFakeTimers();
    try {
      let connects = 0;
      let closes = 0;
      let onClose!: () => void;
      const { client } = controlClient({
        startTimers: true,
        sessions: { revoke: () => undefined } as never,
        connect: (_url: string, _headers: Record<string, string>, _onMessage: (raw: string) => void, close: () => void) => {
          connects += 1;
          onClose = close;
          return { send: () => undefined, close: () => { closes += 1; } };
        },
      });
      await client.start();
      expect(connects).toBe(1);

      // The gateway fence is synchronous, so the control client's drain must be too.
      client.fence();
      expect(closes).toBe(1);

      // A socket that drops after the fence must not schedule another dial.
      onClose();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(connects).toBe(1);

      client.fence();
      expect(closes).toBe(1);
      await expect(client.connectControl("t".repeat(43))).rejects.toThrow(/shutting down/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds the pending control frame queue and terminates the stream instead of acknowledging a backlog late", async () => {
    const sent: Array<Record<string, unknown>> = [];
    let closes = 0;
    let releaseFirst!: () => void;
    const firstCleanup = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const capabilities = { endActorGrants: async () => { await firstCleanup; return { ended: 0, scopes: 0 }; } };
    const { client } = controlClient({
      capabilities: capabilities as never,
      sessions: { revoke: () => undefined } as never,
      connect: () => ({ send: (value: string) => { sent.push(JSON.parse(value) as Record<string, unknown>); }, close: () => { closes += 1; } }),
    });
    const stream = await client.connectControl((await client.register()).controlTicket);
    const keepalive = JSON.stringify({ protocolVersion: 2, type: "generation", runtimeId: logicalRuntimeId, authorityGeneration: 1 });
    const blocking = stream.receive(JSON.stringify({ protocolVersion: 2, type: "denial", denial: { organizationId, actorId: collaborationActors.editor, generation: 2, fencedAt: clock.toISOString(), ackDeadline: new Date(clock.getTime() + 25_000).toISOString(), state: "pending" } }));
    // Let the first frame reach its pending cleanup so the queue behind it is genuinely backed up.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const queued: Array<Promise<void>> = [];
    for (let index = 0; index < CollaborationControlClient.MAX_PENDING_CONTROL_FRAMES - 1; index += 1) queued.push(stream.receive(keepalive));
    await expect(stream.receive(keepalive)).rejects.toThrow(/backlog/i);
    expect(closes).toBeGreaterThan(0);
    releaseFirst();
    await blocking;
    // Only the frame already in flight is acknowledged; the bounded backlog is dropped with the stream.
    const settled = await Promise.allSettled(queued);
    expect(settled.every((entry) => entry.status === "rejected")).toBe(true);
    expect(sent.map((ack) => ack.authorityGeneration)).toEqual([2]);
    await client.shutdown();
  });

  it("acknowledges platform generation keepalives with its unchanged fence and stays control-fresh past the snapshot lifetime", async () => {
    const { client, sent } = controlClient();
    const registration = await client.register();
    const stream = await client.connectControl(registration.controlTicket);
    const verifier = new DirectTicketVerifier({
      runtimeId, platformKeys: () => client.platformKeys(), controlFresh: () => client.controlFresh(),
      allowedClientOrigins: [clientOrigin], replay: new DirectReplayCache({ now: () => clock }), now: () => clock,
    });
    expect(client.controlFresh()).toBe(true);
    // Idle for longer than the fixed snapshot lifetime: every exchange is unavailable.
    clock = new Date(clock.getTime() + 21_000);
    expect(client.controlFresh()).toBe(false);
    expect(() => verifier.verifyTicket(ticketFor({ actorId: collaborationActors.editor, key: clientKey(), issuedAt: clock }))).toThrow(expect.objectContaining({ code: "unavailable" }));
    // A keepalive generation frame refreshes the snapshot and is acknowledged; no denial was applied, so the fence is the epoch.
    await stream.receive(JSON.stringify({ protocolVersion: 2, type: "generation", runtimeId: logicalRuntimeId, authorityGeneration: 1 }));
    expect(client.controlFresh()).toBe(true);
    expect(sent.at(-1)).toEqual({ protocolVersion: 2, runtimeId: logicalRuntimeId, authorityGeneration: 1, fenceAt: "1970-01-01T00:00:00.000Z" });
    expect(verifier.verifyTicket(ticketFor({ actorId: collaborationActors.editor, key: clientKey(), issuedAt: clock }))).toMatchObject({ actorId: collaborationActors.editor });
    // After a denial the fence moves to that acknowledgement and later keepalive acks repeat it, never a fresher time.
    await stream.receive(JSON.stringify({ protocolVersion: 2, type: "denial", denial: { actorId: collaborationActors.viewer, generation: 2, fencedAt: clock.toISOString(), ackDeadline: new Date(clock.getTime() + 25_000).toISOString(), state: "pending" } }));
    const fenceAt = clock.toISOString();
    expect(sent.at(-1)).toMatchObject({ authorityGeneration: 2, fenceAt });
    clock = new Date(clock.getTime() + 5_000);
    await stream.receive(JSON.stringify({ protocolVersion: 2, type: "generation", runtimeId: logicalRuntimeId, authorityGeneration: 3 }));
    expect(sent.at(-1)).toEqual({ protocolVersion: 2, runtimeId: logicalRuntimeId, authorityGeneration: 3, fenceAt });
    // A generation frame for another runtime still refreshes liveness but never moves this home's generation.
    await stream.receive(JSON.stringify({ protocolVersion: 2, type: "generation", runtimeId: "vps-22222222-2222-4222-8222-222222222222", authorityGeneration: 9 }));
    expect(client.authorityGeneration()).toBe(3);
    await client.shutdown();
  });

  it("ends the actor's grants and activations, evicts cached membership and denies REST authorization at once on a pushed denial", async () => {
    const grantee = "user_grantee0000000000000000";
    const grants = new CollaborationCapabilityRepository(fixture.db, { now: () => clock, createId: () => randomUUID() });
    let platformMember = true;
    const fetchImpl = async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { actors: Array<{ organizationId: string; actorId: string }> };
      return new Response(JSON.stringify(body.actors.map(({ organizationId: org, actorId }) => ({
        protocolVersion: 2, type: "membership_assertion", organizationId: org, actorId, membershipEpoch: "1",
        member: actorId === grantee ? platformMember : true, aiSubmission: "owner_only",
        requestStartedAt: clock.toISOString(), expiresAt: new Date(clock.getTime() + 20_000).toISOString(),
      }))), { status: 200, headers: { "content-type": "application/json" } });
    };
    const membership = new OrganizationMembershipClient({ platformBaseUrl: "https://platform.internal", runtimeId, serviceToken: "s".repeat(40), fetchImpl: fetchImpl as never, now: () => clock });
    const precondition = createOrganizationPrecondition({ source: membership, now: () => clock });
    const repository = new CollaborationRepository(fixture.db, { chatRepository: undefined as never });
    const grantAuthority = new CollaborationAuthority(repository, { organizationPrecondition: precondition, capabilities: grants, now: () => clock });
    const evaluator = new CollaborationCapabilityEvaluator({ db: fixture.db, grants, organizationPrecondition: precondition, now: () => clock });
    const hash = "a".repeat(64);
    const scopeRevision = async () => Number((await fixture.db.selectFrom("collaboration_scopes").select("revision").where("id", "=", scopeId).executeTakeFirstOrThrow()).revision);
    const orgWide = await grants.createGrant({ scopeId, actorId: collaborationActors.owner, clientRequestId: randomUUID(), expectedRevision: await scopeRevision(), payloadHash: hash, audience: { kind: "organization" }, preset: "viewer", policyVersion: "v1" });
    await evaluator.acceptGrant({ grantId: orgWide.grantId, actorId: grantee });
    const direct = await grants.createGrant({ scopeId, actorId: collaborationActors.owner, clientRequestId: randomUUID(), expectedRevision: await scopeRevision(), payloadHash: hash, audience: { kind: "member", actorId: grantee }, preset: "contributor", policyVersion: "v1" });
    await expect(grantAuthority.authorize({ scopeId, actorId: grantee, action: "read" })).resolves.toMatchObject({ actorId: grantee });
    expect(membership.describe().cacheEntries).toBeGreaterThan(0);

    const { client } = controlClient({ capabilities: grants, membership });
    const stream = await client.connectControl((await client.register()).controlTicket);
    // The platform now reports the departure, but the home's cache would still serve the old evidence for 20 s.
    platformMember = false;
    await stream.receive(JSON.stringify({ protocolVersion: 2, type: "denial", denial: { organizationId, actorId: grantee, generation: 2, fencedAt: clock.toISOString(), ackDeadline: new Date(clock.getTime() + 25_000).toISOString(), state: "pending" } }));

    expect((await grants.getGrant(direct.grantId))?.state).toBe("revoked");
    expect(await grants.listActivations(orgWide.grantId)).toEqual([]);
    expect((await grants.getGrant(orgWide.grantId))?.state).toBe("active");
    await expect(grantAuthority.authorize({ scopeId, actorId: grantee, action: "read" })).rejects.toMatchObject({ code: "not_found" });
    await client.shutdown();
  });
});
