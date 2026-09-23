import { generateKeyPairSync, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COLLABORATION_DIRECT_PROTOCOL_VERSION } from "@matrix-os/contracts";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { CollaborationActorProofVerifier } from "../../packages/gateway/src/collaboration/actor-proof.js";
import { CollaborationAuthority } from "../../packages/gateway/src/collaboration/authority.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { DirectReplayCache, DirectTicketVerifier } from "../../packages/gateway/src/collaboration/direct-auth.js";
import { requestSigningPayload, sha256Hex } from "../../packages/gateway/src/collaboration/direct-crypto.js";
import { DirectSessionService } from "../../packages/gateway/src/collaboration/direct-sessions.js";
import { OwnerRuntimeSessionService } from "../../packages/gateway/src/collaboration/owner-runtime-sessions.js";
import { createOrganizationPrecondition } from "../../packages/gateway/src/collaboration/organization-precondition.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import { createCollaborationRoutes, type CollaborationRouteOptions } from "../../packages/gateway/src/collaboration/routes.js";
import {
  ed25519PrivateKeyFromSeed, ed25519PublicKeyRaw, possessionPayload, proofKeyThumbprint,
  signEd25519, ticketSigningPayload,
} from "../../packages/platform/src/collaboration/ticket-crypto.js";
import { CollaborationProofSigner } from "../../packages/platform/src/collaboration/proof.js";
import { createRealCollaborationTestDatabase, type CollaborationTestDatabase } from "./collaboration-test-support.js";

const now = new Date("2026-09-21T15:00:00.000Z");
const runtimeId = "vps:11111111-1111-4111-8111-111111111111";
const logicalRuntimeId = "vps-11111111-1111-4111-8111-111111111111";
const ownerId = "user_direct_owner_routes";
const memberId = "user_direct_owner_member";
const organizationId = "org_direct_owner_routes";
const scopeId = "10000000-0000-4000-8000-00000000b901";
const invitationId = "30000000-0000-4000-8000-00000000b901";
const platformKey = ed25519PrivateKeyFromSeed(Buffer.alloc(32, 17).toString("base64url"));
const proofKey = generateKeyPairSync("ed25519");
const proofPublicKey = ed25519PublicKeyRaw(proofKey.publicKey);

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("S18 direct owner route retirement", () => {
  let fixture: CollaborationTestDatabase;
  let directSessions: DirectSessionService;
  let ownerRuntimeSessions: OwnerRuntimeSessionService;
  let ownerRuntimeSessionId: string;
  let app: Hono;
  let sessionId: string;
  let proofSigner: CollaborationProofSigner;

  beforeEach(async () => {
    fixture = await createRealCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    await fixture.db.insertInto("collaboration_scopes").values({
      id: scopeId, owner_type: "personal", owner_id: ownerId, organization_id: organizationId,
      kind: "project", resource_id: "project_direct_owner", parent_scope_id: null,
      membership_mode: "direct", lifecycle: "shared", authority_runtime_id: runtimeId,
      authority_generation: 1, revision: 1, auth_epoch: 1, execution_generation: null,
      execution_eligibility: null, deleted_at: null, created_at: now, updated_at: now,
    }).execute();
    for (const [actorId, role, status] of [[ownerId, "owner", "accepted"], [memberId, "editor", "pending"]] as const) {
      await fixture.db.insertInto("collaboration_members").values({
        scope_id: scopeId, actor_id: actorId, role, status, organization_id: organizationId,
        invitation_id: status === "pending" ? invitationId : null, invited_by: ownerId,
        accepted_at: status === "accepted" ? now : null,
        expires_at: status === "pending" ? new Date(now.getTime() + 86_400_000) : null, revision: 1,
        joined_at: status === "accepted" ? now : null, updated_at: now, dispositioned_at: null,
      }).execute();
    }
    // The fixture pins `now` and writes invitation expiries relative to it, so the
    // repository has to read the same clock; on the real clock this suite expires
    // its own invitations a day after the pinned date and fails by calendar.
    const repository = new CollaborationRepository(fixture.db, { now: () => now });
    const precondition = createOrganizationPrecondition({
      source: { async assertMembership({ actorId }) { return actorId === ownerId || actorId === memberId
        ? { member: true, expiresAt: new Date(now.getTime() + 20_000).toISOString() } : { member: false }; } },
      now: () => now,
    });
    const authority = new CollaborationAuthority(repository, { organizationPrecondition: precondition, now: () => now });
    const ticketVerifier = new DirectTicketVerifier({
      runtimeId, platformKeys: () => [{ keyId: "platform-1", algorithm: "ed25519", publicKey: ed25519PublicKeyRaw(platformKey) }],
      controlFresh: () => true, allowedClientOrigins: ["https://app.matrix-os.com"],
      replay: new DirectReplayCache({ now: () => now }), now: () => now,
    });
    directSessions = new DirectSessionService({ verifier: ticketVerifier, authority, repository, now: () => now });
    ownerRuntimeSessions = new OwnerRuntimeSessionService({
      verifier: ticketVerifier, ownerId, runtimeId, organizationPrecondition: precondition, now: () => now,
    });
    const ownerTicket = {
      protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION, ticketId: randomUUID(), nonce: randomUUID().replaceAll("-", ""),
      actorId: ownerId, organizationId, resource: { kind: "owner_runtime" }, purpose: "owner_runtime",
      runtime: { runtimeId: logicalRuntimeId, authorityGeneration: 1 }, proofKeyThumbprint: proofKeyThumbprint(proofPublicKey),
      maxActions: 100, issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 30_000).toISOString(),
    };
    ownerRuntimeSessionId = (await ownerRuntimeSessions.create({
      clientRequestId: randomUUID(), signedTicket: { ticket: ownerTicket, keyId: "platform-1", signature: signEd25519(platformKey, ticketSigningPayload(ownerTicket)) },
      proofPublicKey, possession: signEd25519(proofKey.privateKey, possessionPayload({ ticketNonce: ownerTicket.nonce, purpose: "owner_runtime" })),
      clientOrigin: "https://app.matrix-os.com",
    })).id;
    sessionId = await createSession(ownerId);
    const verifier = new CollaborationActorProofVerifier({ runtimeId, keys: { "legacy-1": "x".repeat(32) }, now: () => now, authority });
    proofSigner = new CollaborationProofSigner({ activeKeyId: "legacy-1", keys: { "legacy-1": "x".repeat(32) }, now: () => now });
    app = new Hono();
    app.route("/", createCollaborationRoutes({
      runtimeId, repository, authority, verifier, directSessions, ownerRuntimeSessions,
      executionPolicies: { resolve: async () => null },
      resolveParticipant: async (actorId: string) => ({ actorId, displayName: actorId }),
    } as unknown as CollaborationRouteOptions));
  });

  async function createSession(actorId: string, pendingGrantId?: string): Promise<string> {
    const ticket = {
      protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION, ticketId: randomUUID(), nonce: randomUUID().replaceAll("-", ""),
      actorId, organizationId,
      resource: { scopeId, kind: "project", ...(pendingGrantId ? { pendingGrantId } : {}) },
      purpose: "direct_session",
      runtime: { runtimeId: logicalRuntimeId, authorityGeneration: 1 }, proofKeyThumbprint: proofKeyThumbprint(proofPublicKey),
      maxActions: 100, issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 30_000).toISOString(),
    };
    const session = await directSessions.create({
      clientRequestId: randomUUID(), signedTicket: { ticket, keyId: "platform-1", signature: signEd25519(platformKey, ticketSigningPayload(ticket)) },
      proofPublicKey, possession: signEd25519(proofKey.privateKey, possessionPayload({ ticketNonce: ticket.nonce, purpose: "direct_session" })),
      clientOrigin: "https://app.matrix-os.com",
    });
    return session.id;
  }

  afterEach(async () => {
    await directSessions?.shutdown();
    await ownerRuntimeSessions?.shutdown();
    await fixture?.destroy();
  });

  function signedRequest(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown, tamper = false): Promise<Response> {
    return signedRequestAs(sessionId, method, path, body, tamper);
  }

  function signedRequestAs(
    session: string, method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown, tamper = false,
  ): Promise<Response> {
    const sessionId = session;
    const bytes = body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(body));
    const signature = {
      protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION, sessionId, method, path, query: "",
      bodyDigest: sha256Hex(bytes), conditionalHeadersDigest: sha256Hex(new Uint8Array()),
      nonce: randomUUID().replaceAll("-", ""), issuedAt: now.toISOString(),
    };
    const proof = signEd25519(proofKey.privateKey, requestSigningPayload(signature));
    return app.request(path, {
      method, headers: {
        "content-type": "application/json", "x-matrix-collaboration-session": sessionId,
        "x-matrix-collaboration-request": Buffer.from(JSON.stringify({ signature, proof: tamper ? "A".repeat(86) : proof })).toString("base64url"),
      },
      ...(body === undefined ? {} : { body: new TextDecoder().decode(bytes) }),
    });
  }

  function ownerSignedRequest(method: "GET" | "POST", path: string, body?: unknown): Promise<Response> {
    const bytes = body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(body));
    const signature = {
      protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION, sessionId: ownerRuntimeSessionId, method, path, query: "",
      bodyDigest: sha256Hex(bytes), conditionalHeadersDigest: sha256Hex(new Uint8Array()),
      nonce: randomUUID().replaceAll("-", ""), issuedAt: now.toISOString(),
    };
    return app.request(path, { method, headers: {
      "content-type": "application/json", "x-matrix-collaboration-owner-runtime": "1",
      "x-matrix-collaboration-session": ownerRuntimeSessionId,
      "x-matrix-collaboration-request": Buffer.from(JSON.stringify({ signature,
        proof: signEd25519(proofKey.privateKey, requestSigningPayload(signature)) })).toString("base64url"),
    }, ...(body === undefined ? {} : { body: new TextDecoder().decode(bytes) }) });
  }

  it("keeps a private project owner on exact owner-runtime read, inventory and confirm paths", async () => {
    await fixture.db.updateTable("collaboration_scopes").set({ lifecycle: "private" }).where("id", "=", scopeId).execute();
    expect((await ownerSignedRequest("GET", `/api/collaboration/scopes/${scopeId}`)).status).toBe(200);
    expect((await ownerSignedRequest("GET", `/api/collaboration/scopes/${scopeId}/members`)).status).toBe(200);
    expect((await ownerSignedRequest("GET", `/api/collaboration/scopes/${scopeId}/project/inventory`)).status).toBe(503);
    expect((await ownerSignedRequest("POST", `/api/collaboration/scopes/${scopeId}/project/confirm`, {})).status).toBe(400);
    expect((await ownerSignedRequest("GET", `/api/collaboration/scopes/${randomUUID()}/project/inventory`)).status).toBe(404);
    await fixture.db.updateTable("collaboration_scopes").set({ authority_generation: 2 }).where("id", "=", scopeId).execute();
    expect((await ownerSignedRequest("GET", `/api/collaboration/scopes/${scopeId}/project/inventory`)).status).toBe(401);
    await fixture.db.updateTable("collaboration_scopes").set({ authority_generation: 1, organization_id: "org_other" }).where("id", "=", scopeId).execute();
    expect((await ownerSignedRequest("GET", `/api/collaboration/scopes/${scopeId}/project/inventory`)).status).toBe(401);
  });

  it.each([
    ["GET", `/api/collaboration/scopes/${scopeId}/execution-policy`, undefined, 404],
    ["PUT", `/api/collaboration/scopes/${scopeId}/execution-policy`, {}, 400],
    ["GET", `/api/collaboration/scopes/${scopeId}/project/inventory`, undefined, 503],
    ["POST", `/api/collaboration/scopes/${scopeId}/project/confirm`, {}, 400],
    ["POST", `/api/collaboration/scopes/${scopeId}/lifecycle`, {}, 400],
    ["GET", `/api/collaboration/scopes/${scopeId}/operations/${randomUUID()}`, undefined, 404],
    ["GET", `/api/collaboration/scopes/${scopeId}/exports/${randomUUID()}`, undefined, 404],
    ["GET", `/api/collaboration/invitations/${invitationId}`, undefined, 200],
    ["POST", `/api/collaboration/invitations/${invitationId}/accept`, { clientRequestId: randomUUID(), expectedRevision: "1" }, 403],
    ["POST", `/api/collaboration/invitations/${invitationId}/decline`, { clientRequestId: randomUUID(), expectedRevision: "1" }, 403],
  ] as const)("uses a signed direct session for %s %s", async (method, path, body, expected) => {
    const response = await signedRequest(method, path, body);
    expect(response.status).toBe(expected);
  });

  it("rejects a forged direct signature and a valid legacy-only proof", async () => {
    const path = `/api/collaboration/scopes/${scopeId}/execution-policy`;
    expect((await signedRequest("GET", path, undefined, true)).status).toBe(401);
    const legacy = proofSigner.signHttp({ actorId: ownerId, ownerId, runtimeId, scopeId,
      method: "GET", path, query: "", body: new Uint8Array() });
    const response = await app.request(path, { headers: {
      "x-matrix-collaboration-proof": Buffer.from(JSON.stringify(legacy)).toString("base64url"),
    } });
    expect(response.status).toBe(401);
  });

  it("authenticates before looking up an invitation identifier", async () => {
    const known = await app.request(`/api/collaboration/invitations/${invitationId}`);
    const unknown = await app.request(`/api/collaboration/invitations/${randomUUID()}`);
    expect(known.status).toBe(401);
    expect(unknown.status).toBe(401);
  });

  it("lets an invited member accept through a signed direct session and checks the exact invitation", async () => {
    sessionId = await createSession(memberId);
    const response = await signedRequest("POST", `/api/collaboration/invitations/${invitationId}/accept`,
      { clientRequestId: randomUUID(), expectedRevision: "1" });
    expect(response.status).toBe(200);
    expect(await fixture.db.selectFrom("collaboration_members").select("status")
      .where("invitation_id", "=", invitationId).executeTakeFirst()).toMatchObject({ status: "accepted" });
  });

  it("admits an invited member's direct session and keeps accept-only grant sessions off the invitation routes", async () => {
    // A personally invited actor is recorded as `invited` in the platform user
    // index, so their ticket never carries pendingGrantId; only an
    // organization-wide grant recipient, who has no invitation at all, gets one.
    const inviteeSession = await createSession(memberId);
    expect((await signedRequestAs(inviteeSession, "GET", `/api/collaboration/invitations/${invitationId}`)).status).toBe(200);

    const grantId = randomUUID();
    await fixture.db.insertInto("collaboration_grants").values({
      id: grantId, scope_id: scopeId, organization_id: organizationId, audience_kind: "organization",
      audience_actor_id: null, preset: "contributor", state: "active", policy_version: 1,
      source_id: null, legacy_ceiling: null, expires_at: null, revision: 1,
      created_by: ownerId, created_at: now, updated_at: now, revoked_at: null,
    }).execute();
    const grantSession = await createSession(memberId, grantId);
    // The accept-only session reaches its own grant route, never the invitation routes.
    expect((await signedRequestAs(grantSession, "GET", `/api/collaboration/invitations/${invitationId}`)).status).toBe(401);

    const accepted = await signedRequestAs(inviteeSession, "POST", `/api/collaboration/invitations/${invitationId}/accept`,
      { clientRequestId: randomUUID(), expectedRevision: "1" });
    expect(accepted.status).toBe(200);
  });
});
