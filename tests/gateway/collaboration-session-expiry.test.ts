import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COLLABORATION_DIRECT_PROTOCOL_VERSION } from "@matrix-os/contracts";
import { ed25519PrivateKeyFromSeed, ed25519PublicKeyRaw, possessionPayload, proofKeyThumbprint,
  signEd25519, ticketSigningPayload } from "../../packages/platform/src/collaboration/ticket-crypto.js";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import { CollaborationAuthority } from "../../packages/gateway/src/collaboration/authority.js";
import { createOrganizationPrecondition } from "../../packages/gateway/src/collaboration/organization-precondition.js";
import { DirectReplayCache, DirectTicketVerifier } from "../../packages/gateway/src/collaboration/direct-auth.js";
import { DirectSessionService } from "../../packages/gateway/src/collaboration/direct-sessions.js";
import { requestSigningPayload, sha256Hex } from "../../packages/gateway/src/collaboration/direct-crypto.js";
import { CollaborationRevocationEnforcer, SandboxRuntimeRegistry } from "../../packages/gateway/src/collaboration/revocation-enforcer.js";
import { subscribeSessionRevocations } from "../../packages/gateway/src/collaboration/session-revocation.js";
import { createCollaborationTestDatabase, createRealCollaborationTestDatabase,
  type CollaborationTestDatabase } from "./collaboration-test-support.js";

const scopeId = "10000000-0000-4000-8000-000000000101";
const machineId = "11111111-1111-4111-8111-111111111111";
const runtimeId = `vps:${machineId}`;
const actorId = "user_expiry_member";
const ownerId = "user_expiry_owner";
const organizationId = "org_expiry_test";
const origin = "https://app.matrix-os.com";
const platformKey = ed25519PrivateKeyFromSeed(Buffer.alloc(32, 17).toString("base64url"));
const runtimeHandle = `runtime_${"b".repeat(32)}`;

describe("shared execution across identity session rollover", () => {
  let fixture: CollaborationTestDatabase;
  let clock: Date;
  let members: Set<string>;
  let sessions: DirectSessionService;
  let runtimes: SandboxRuntimeRegistry;
  let enforcer: CollaborationRevocationEnforcer;
  let stopRuntime: ReturnType<typeof vi.fn>;
  let inference: AbortController;
  let unsubscribe: () => void;

  beforeEach(async () => {
    clock = new Date("2026-11-20T10:00:00.000Z");
    fixture = process.env.MATRIX_TEST_POSTGRES_URL
      ? await createRealCollaborationTestDatabase() : await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db as never);
    await bootstrapCollaborationDatabase(fixture.db);
    await fixture.db.insertInto("collaboration_scopes").values({
      id: scopeId, owner_type: "personal", owner_id: ownerId, organization_id: organizationId,
      kind: "chat", resource_id: "chat_expiry", membership_mode: "direct", lifecycle: "shared",
      authority_runtime_id: runtimeId, created_at: clock, updated_at: clock,
    }).execute();
    for (const [id, role] of [[ownerId, "owner"], [actorId, "editor"]] as const) {
      await fixture.db.insertInto("collaboration_members").values({
        scope_id: scopeId, actor_id: id, role, status: "accepted", organization_id: organizationId,
        invited_by: ownerId, accepted_at: clock, revision: 1, joined_at: clock, updated_at: clock,
      }).execute();
    }
    members = new Set([ownerId, actorId]);
    const organizationPrecondition = createOrganizationPrecondition({ now: () => clock,
      source: { assertMembership: async ({ actorId: id }) => members.has(id)
        ? { member: true, expiresAt: new Date(clock.getTime() + 20_000).toISOString() } : { member: false } } });
    const repository = new CollaborationRepository(fixture.db, { chatRepository: undefined as never });
    const authority = new CollaborationAuthority(repository, { organizationPrecondition, now: () => clock });
    const verifier = new DirectTicketVerifier({ runtimeId, now: () => clock, controlFresh: () => true,
      allowedClientOrigins: [origin], replay: new DirectReplayCache({ now: () => clock }),
      platformKeys: () => [{ keyId: "test-key", algorithm: "ed25519", publicKey: ed25519PublicKeyRaw(platformKey) }] });
    stopRuntime = vi.fn(async () => ({}));
    inference = new AbortController();
    runtimes = new SandboxRuntimeRegistry({ client: { stopRuntime }, now: () => clock, startTimer: false });
    enforcer = new CollaborationRevocationEnforcer({ runtimes, now: () => clock,
      control: { invalidateActor: vi.fn() } });
    sessions = new DirectSessionService({ verifier, authority, repository, now: () => clock,
      onAdmitted: session => enforcer.admit(session.scopeId, session.actorId) });
    unsubscribe = subscribeSessionRevocations(sessions, () => enforcer);
  });
  afterEach(async () => {
    unsubscribe?.();
    await sessions?.shutdown();
    runtimes?.close();
    await enforcer?.settle();
    await fixture?.destroy();
  });
  async function admit(id = actorId) {
    const key = generateKeyPairSync("ed25519");
    const raw = ed25519PublicKeyRaw(key.publicKey);
    const ticket = { protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION, ticketId: randomUUID(),
      nonce: randomUUID().replaceAll("-", ""), actorId: id, organizationId, resource: { scopeId, kind: "chat" },
      purpose: "direct_session", runtime: { runtimeId: `vps-${machineId}`, authorityGeneration: 1 },
      proofKeyThumbprint: proofKeyThumbprint(raw), maxActions: 100,
      issuedAt: clock.toISOString(), expiresAt: new Date(clock.getTime() + 30_000).toISOString() };
    const session = await sessions.create({ clientRequestId: randomUUID(), signedTicket: { ticket, keyId: "test-key",
      signature: signEd25519(platformKey, ticketSigningPayload(ticket)) }, proofPublicKey: raw,
      possession: signEd25519(key.privateKey, possessionPayload({ ticketNonce: ticket.nonce, purpose: ticket.purpose })),
      clientOrigin: origin });
    return { session, authorize: () => {
      const body = new Uint8Array();
      const signature = { protocolVersion: 2, sessionId: session.id, method: "GET",
        path: `/api/collaboration/scopes/${scopeId}`, query: "", bodyDigest: sha256Hex(body),
        conditionalHeadersDigest: sha256Hex(body), nonce: randomUUID().replaceAll("-", ""), issuedAt: clock.toISOString() };
      return sessions.authorize({ sessionId: session.id, signature,
        proof: signEd25519(key.privateKey, requestSigningPayload(signature)), method: "GET", path: signature.path,
        query: "", body, action: "read" });
    } };
  }
  function bindRun() {
    runtimes.bind({ scopeId, actorId, runtimeHandle, onStop: () => inference.abort() });
  }

  it.each(["sweep", "request"] as const)(
    "keeps a newer verified member's run when the older session expires through %s", async path => {
      const old = await admit();
      clock = new Date(clock.getTime() + 290_000);
      const fresh = await admit();
      const endedReasons: string[] = [];
      const unsubscribeEnded = sessions.subscribeEnded((_session, reason) => endedReasons.push(reason));
      bindRun();
      clock = new Date(clock.getTime() + 10_001);
      if (path === "sweep") sessions.sweep();
      else await expect(sessions.keepEvidenceFresh(old.session.id)).rejects.toMatchObject({ code: "expired" });
      await enforcer.settle();
      expect(sessions.describe(old.session.id)).toBeNull();
      expect(sessions.describe(fresh.session.id)).not.toBeNull();
      expect(endedReasons).toEqual(["expired"]);
      unsubscribeEnded();
      expect(inference.signal.aborted).toBe(false);
      expect(stopRuntime).not.toHaveBeenCalled();
      expect(enforcer.isRevoked(scopeId, actorId)).toBe(false);
    });
  it("does not use another actor's session to preserve an expired actor's run", async () => {
    await admit(); clock = new Date(clock.getTime() + 290_000); await admit(ownerId); bindRun();
    clock = new Date(clock.getTime() + 10_001); sessions.sweep(); await enforcer.settle();
    expect(inference.signal.aborted).toBe(true);
    expect(stopRuntime).toHaveBeenCalledWith({ runtimeHandle });
  });
  it.each(["membership denial", "explicit revocation"] as const)(
    "still stops the run on %s even with a newer verified session", async reason => {
      await admit(); clock = new Date(clock.getTime() + 290_000); const fresh = await admit(); bindRun();
      if (reason === "explicit revocation") sessions.revoke({ scopeId, actorId });
      else {
        members.delete(actorId); clock = new Date(clock.getTime() + 25_000);
        await expect(sessions.keepEvidenceFresh(fresh.session.id)).rejects.toThrow();
      }
      await enforcer.settle();
      expect(inference.signal.aborted).toBe(true);
      expect(stopRuntime).toHaveBeenCalledWith({ runtimeHandle });
      expect(enforcer.isRevoked(scopeId, actorId)).toBe(true);
    });
  it("does not preserve a run using stale membership evidence in a newer identity", async () => {
    await admit(); clock = new Date(clock.getTime() + 290_000); const fresh = await admit(); bindRun();
    clock = new Date(clock.getTime() + 30_001); sessions.sweep(); await enforcer.settle();
    expect(sessions.describe(fresh.session.id)).not.toBeNull();
    expect(inference.signal.aborted).toBe(true);
    expect(stopRuntime).toHaveBeenCalledWith({ runtimeHandle });
  });
  it("still stops on an expired authority generation while another identity is fresh", async () => {
    const old = await admit(); clock = new Date(clock.getTime() + 290_000); await admit(); bindRun();
    await fixture.db.updateTable("collaboration_scopes").set({ authority_generation: 2 }).where("id", "=", scopeId).execute();
    await expect(old.authorize()).rejects.toMatchObject({ code: "expired" });
    await enforcer.settle();
    expect(inference.signal.aborted).toBe(true);
    expect(stopRuntime).toHaveBeenCalledWith({ runtimeHandle });
  });
});
