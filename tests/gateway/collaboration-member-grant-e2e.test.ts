/**
 * S19 finding 22: a grant addressed to one organization member ("Share with
 * <person>") works end to end. Nothing here seeds an invitation id or stubs a
 * resolver: the grant is created through the home's grant route, published by
 * the real directory outbox through the platform's directory route into the
 * real platform repository, listed by the platform inbox route, turned into an
 * accept-only ticket by the real issuer, accepted on the home through a direct
 * session, and then opened with an ordinary ticket once the platform learns the
 * acceptance.
 */
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  COLLABORATION_DIRECT_PROTOCOL_VERSION,
  CollaborationDiscoveryResponseSchema,
  CollaborationGrantSchema,
} from "@matrix-os/contracts";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { CollaborationActorProofVerifier } from "../../packages/gateway/src/collaboration/actor-proof.js";
import { CollaborationAuthority } from "../../packages/gateway/src/collaboration/authority.js";
import { CollaborationCapabilityEvaluator } from "../../packages/gateway/src/collaboration/capability-evaluator.js";
import { CollaborationCapabilityRepository } from "../../packages/gateway/src/collaboration/capability-repository.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { DirectReplayCache, DirectTicketVerifier } from "../../packages/gateway/src/collaboration/direct-auth.js";
import { requestSigningPayload, sha256Hex } from "../../packages/gateway/src/collaboration/direct-crypto.js";
import { DirectSessionService } from "../../packages/gateway/src/collaboration/direct-sessions.js";
import { CollaborationDirectoryOutbox } from "../../packages/gateway/src/collaboration/directory-outbox.js";
import { createOrganizationPrecondition } from "../../packages/gateway/src/collaboration/organization-precondition.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import { createCollaborationRoutes, type CollaborationRouteOptions } from "../../packages/gateway/src/collaboration/routes.js";
import { bootstrapPlatformCollaborationDatabase } from "../../packages/platform/src/collaboration/database.js";
import { PlatformCollaborationRepository } from "../../packages/platform/src/collaboration/repository.js";
import { createPlatformCollaborationRoutes } from "../../packages/platform/src/collaboration/routes.js";
import { CollaborationTicketIssuer } from "../../packages/platform/src/collaboration/ticket-issuer.js";
import {
  ed25519PrivateKeyFromSeed, ed25519PublicKeyRaw, possessionPayload, proofKeyThumbprint, signEd25519, ticketSigningPayload,
} from "../../packages/platform/src/collaboration/ticket-crypto.js";
import { createCollaborationTestDatabase, type CollaborationTestDatabase } from "./collaboration-test-support.js";
import {
  createPlatformCollaborationTestDatabase,
  destroyPlatformCollaborationTestDatabase,
  type PlatformCollaborationTestDatabase,
} from "../platform/collaboration-test-support.js";

const now = new Date("2026-10-03T12:00:00.000Z");
const machineId = "11111111-1111-4111-8111-111111111111";
const runtimeId = `vps:${machineId}`;
const logicalRuntimeId = `vps-${machineId}`;
const ownerId = "user_member_grant_owner";
const memberId = "user_member_grant_member";
const bystanderId = "user_member_grant_bystander";
const organizationId = "org_member_grant";
const scopeId = "10000000-0000-4000-8000-00000000c022";
const serviceToken = "s".repeat(48);
const ticketSeed = Buffer.alloc(32, 22).toString("base64url");
const clientOrigin = "https://app.matrix-os.com";

describe("member-addressed grants end to end", () => {
  let home: CollaborationTestDatabase;
  let platform: PlatformCollaborationTestDatabase;
  let directSessions: DirectSessionService;
  let outbox: CollaborationDirectoryOutbox;
  let homeApp: Hono;
  let platformApp: Hono;
  let issuer: CollaborationTicketIssuer;
  let platformRepository: PlatformCollaborationRepository;

  beforeEach(async () => {
    home = await createCollaborationTestDatabase();
    platform = await createPlatformCollaborationTestDatabase();
    await bootstrapChatDatabase(home.db);
    await bootstrapCollaborationDatabase(home.db);
    await bootstrapPlatformCollaborationDatabase(platform.collaborationDb);
    await home.db.insertInto("collaboration_scopes").values({
      id: scopeId, owner_type: "personal", owner_id: ownerId, organization_id: organizationId,
      kind: "project", resource_id: "project_member_grant", parent_scope_id: null,
      membership_mode: "direct", lifecycle: "shared", authority_runtime_id: runtimeId,
      authority_generation: 1, revision: 1, auth_epoch: 1, execution_generation: null,
      execution_eligibility: null, deleted_at: null, created_at: now, updated_at: now,
    }).execute();
    await home.db.insertInto("collaboration_members").values({
      scope_id: scopeId, actor_id: ownerId, role: "owner", status: "accepted", organization_id: organizationId,
      invitation_id: null, invited_by: ownerId, accepted_at: now, expires_at: null, revision: 1,
      joined_at: now, updated_at: now, dispositioned_at: null,
    }).execute();

    platformRepository = new PlatformCollaborationRepository(platform.collaborationDb, { now: () => now });
    issuer = new CollaborationTicketIssuer({
      keyring: { activeKeyId: "ticket-key-1", keys: { "ticket-key-1": ticketSeed } },
      repository: platformRepository,
      endpoints: { resolveEnrolled: async (id: string) => (id === runtimeId || id === logicalRuntimeId ? {
        runtimeId: logicalRuntimeId, ownerId, authorityGeneration: 1, lastControlAt: now.toISOString(),
      } : null) } as never,
      resolveOrganization: async (id) => (await platformRepository.getDirectoryRoute(id))?.organizationId ?? null,
      projection: { isCurrentMember: async ({ actorId }) => [ownerId, memberId, bystanderId].includes(actorId) },
      relayOrigin: clientOrigin,
      now: () => now,
    });
    platformApp = createPlatformCollaborationRoutes({
      repository: platformRepository,
      resolveActor: async (c) => c.req.header("x-test-actor") ?? null,
      authenticateRuntime: async (input) => (input.runtimeId === runtimeId && input.bearerToken === serviceToken
        ? { runtimeId, ownerId } : null),
      resolveParticipant: async (actorId) => ({ actorId, displayName: actorId }),
      resolveInvitationIdentifier: async () => null,
      listOrganizationIds: async () => [organizationId],
      now: () => now,
    });

    const precondition = createOrganizationPrecondition({
      source: { async assertMembership({ actorId }) {
        return [ownerId, memberId, bystanderId].includes(actorId)
          ? { member: true, expiresAt: new Date(now.getTime() + 20_000).toISOString(), membershipEpoch: "1" }
          : { member: false };
      } },
      now: () => now,
    });
    const repository = new CollaborationRepository(home.db, { now: () => now });
    const capabilities = new CollaborationCapabilityRepository(home.db, { now: () => now, createId: randomUUID });
    const authority = new CollaborationAuthority(repository, { organizationPrecondition: precondition, capabilities, now: () => now });
    const verifier = new DirectTicketVerifier({
      runtimeId, platformKeys: () => issuer.publicKeys(), controlFresh: () => true,
      allowedClientOrigins: [clientOrigin], replay: new DirectReplayCache({ now: () => now }), now: () => now,
    });
    directSessions = new DirectSessionService({ verifier, authority, repository, now: () => now, startTimers: false });
    outbox = new CollaborationDirectoryOutbox({
      db: home.db, runtimeId, platformBaseUrl: "https://platform.internal", serviceToken,
      startTimer: false, now: () => now,
      // The real platform directory route, so the published event is parsed by the platform's own schema.
      fetchImpl: async (url, init) => platformApp.request(new URL(String(url)).pathname, init),
    });
    homeApp = new Hono();
    homeApp.route("/", createCollaborationRoutes({
      runtimeId, repository, authority, directSessions,
      verifier: new CollaborationActorProofVerifier({ runtimeId, keys: { "legacy-1": "x".repeat(32) }, now: () => now, authority }),
      capabilities,
      capabilityEvaluator: new CollaborationCapabilityEvaluator({ db: home.db, grants: capabilities, organizationPrecondition: precondition, now: () => now }),
      executionPolicies: { resolve: async () => null },
      resolveParticipant: async (actorId: string) => ({ actorId, displayName: actorId }),
    } as unknown as CollaborationRouteOptions));
  });

  afterEach(async () => {
    await outbox.shutdown();
    await directSessions.shutdown();
    await home.destroy();
    await destroyPlatformCollaborationTestDatabase(platform);
  });

  /** A direct session the way a client opens one: a platform-issued ticket exchanged on the home. */
  async function openSession(actorId: string) {
    const key = generateKeyPairSync("ed25519");
    const proofPublicKey = ed25519PublicKeyRaw(key.publicKey);
    const { signedTicket } = await issuer.issue({ actorId, request: {
      clientRequestId: randomUUID(), scopeId, purpose: "direct_session", proofPublicKey,
    } });
    const session = await directSessions.create({
      clientRequestId: randomUUID(), signedTicket, proofPublicKey, clientOrigin,
      possession: signEd25519(key.privateKey, possessionPayload({ ticketNonce: signedTicket.ticket.nonce, purpose: "direct_session" })),
    });
    const request = (method: "GET" | "POST" | "PATCH", path: string, body?: unknown) => {
      const bytes = body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(body));
      const signature = {
        protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION, sessionId: session.id, method, path, query: "",
        bodyDigest: sha256Hex(bytes), conditionalHeadersDigest: sha256Hex(new Uint8Array()),
        nonce: randomUUID().replaceAll("-", ""), issuedAt: now.toISOString(),
      };
      return homeApp.request(path, { method, headers: {
        "content-type": "application/json", "x-matrix-collaboration-session": session.id,
        "x-matrix-collaboration-request": Buffer.from(JSON.stringify({ signature,
          proof: signEd25519(key.privateKey, requestSigningPayload(signature)) })).toString("base64url"),
      }, ...(body === undefined ? {} : { body: new TextDecoder().decode(bytes) }) });
    };
    return { session, ticket: signedTicket.ticket, request };
  }

  async function discovery(actorId: string, kind: "inbox" | "shared") {
    const response = await platformApp.request(`/api/collaboration/${kind}`, { headers: { "x-test-actor": actorId } });
    expect(response.status).toBe(200);
    return CollaborationDiscoveryResponseSchema.parse(await response.json()).items;
  }

  it("lists, accepts and opens a grant addressed to one member, and to nobody else", async () => {
    // The owner is a directory participant once the project is shared; seed that the same way.
    await platformRepository.applyDirectoryEvent({
      eventId: randomUUID(), scopeId, runtimeId, ownerId, kind: "project", organizationId,
      authorityGeneration: 1, metadataRevision: 1, recipients: [{ actorId: ownerId, status: "accepted" }],
    });
    const owner = await openSession(ownerId);
    const created = await owner.request("POST", `/api/collaboration/scopes/${scopeId}/grants`, {
      clientRequestId: randomUUID(), expectedRevision: "1", audience: { kind: "member", actorId: memberId }, preset: "contributor",
    });
    expect(created.status).toBe(201);
    const grant = CollaborationGrantSchema.parse(await created.json());
    expect(grant.state).toBe("pending");
    expect(await outbox.runOnce()).toBe(1);
    const pendingEntry = {
      scopeId, runtimeId, ownerId, kind: "project", authorityGeneration: 1,
      status: "organization_pending", organizationId, grantId: grant.id,
    };
    expect(await discovery(memberId, "inbox")).toEqual([pendingEntry]);
    // Changing the preset before the member opens it keeps it pending in their inbox.
    const patched = await owner.request("PATCH", `/api/collaboration/scopes/${scopeId}/grants/${grant.id}`, {
      clientRequestId: randomUUID(), expectedRevision: "2", expectedGrantRevision: "1", preset: "viewer",
    });
    expect(patched.status).toBe(200);
    expect(await outbox.runOnce()).toBe(1);

    // The member sees exactly one pending entry carrying the grant; nobody else sees anything.
    expect(await discovery(memberId, "inbox")).toEqual([pendingEntry]);
    expect(await discovery(bystanderId, "inbox")).toEqual([]);

    // A pending member is not yet a participant: the accept-only session opens nothing else.
    const pending = await openSession(memberId);
    expect(pending.ticket.resource).toEqual({ scopeId, kind: "project", pendingGrantId: grant.id });
    expect((await pending.request("GET", `/api/collaboration/scopes/${scopeId}`)).status).toBe(401);
    // A bystander gets no ticket at all for the member's grant.
    await expect(openSession(bystanderId)).rejects.toMatchObject({ code: "not_found" });

    const accepted = await pending.request("POST", `/api/collaboration/scopes/${scopeId}/grants/${grant.id}/accept`, {});
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ state: "active" });
    expect(await outbox.runOnce()).toBe(1);

    expect(await discovery(memberId, "inbox")).toEqual([]);
    // The accepted row keeps no grant pointer, so nothing can sign another accept-only ticket from it.
    expect(await platform.collaborationDb.selectFrom("collaboration_user_index").select(["status", "grant_id"])
      .where("actor_id", "=", memberId).execute()).toEqual([{ status: "accepted", grant_id: null }]);
    expect(await discovery(memberId, "shared")).toEqual([expect.objectContaining({ scopeId, status: "accepted" })]);
    const opened = await openSession(memberId);
    expect(opened.ticket.resource).toEqual({ scopeId, kind: "project" });
    const scope = await opened.request("GET", `/api/collaboration/scopes/${scopeId}`);
    expect(scope.status).toBe(200);
  });

  /** Publishes one directory event the way the legacy invitation paths do: an outbox row with explicit recipients. */
  async function publishLegacy(recipients: Array<{ actorId: string; invitationId?: string }>, discoveryState: "invited" | "accepted") {
    const scope = await home.db.selectFrom("collaboration_scopes").select(["revision", "kind", "resource_id"])
      .where("id", "=", scopeId).executeTakeFirstOrThrow();
    const latest = await home.db.selectFrom("collaboration_events").select(({ fn }) => fn.max("scope_seq").as("sequence"))
      .where("scope_id", "=", scopeId).executeTakeFirst();
    const eventId = randomUUID();
    const revision = Number(scope.revision) + 1;
    await home.db.updateTable("collaboration_scopes").set({ revision }).where("id", "=", scopeId).execute();
    await home.db.insertInto("collaboration_events").values({
      scope_id: scopeId, scope_seq: Number(latest?.sequence ?? 0) + 1, event_id: eventId, resource_kind: scope.kind,
      resource_id: scope.resource_id, revision, authority_generation: 1, event_type: "member.invited", payload: {}, created_at: now,
    } as never).execute();
    await home.db.insertInto("collaboration_directory_outbox").values({
      event_id: eventId, scope_id: scopeId, recipient_actor_ids: JSON.stringify(recipients), authority_runtime_id: runtimeId,
      authority_generation: 1, resource_kind: scope.kind, discovery_state: discoveryState, retry_after: now, delivered_at: null, created_at: now,
    } as never).execute();
    expect(await outbox.runOnce()).toBe(1);
  }

  it("keeps a member's pending grant reachable across a legacy invitation for the same project", async () => {
    await platformRepository.applyDirectoryEvent({
      eventId: randomUUID(), scopeId, runtimeId, ownerId, kind: "project", organizationId,
      authorityGeneration: 1, metadataRevision: 1, recipients: [{ actorId: ownerId, status: "accepted" }],
    });
    const owner = await openSession(ownerId);
    const created = await owner.request("POST", `/api/collaboration/scopes/${scopeId}/grants`, {
      clientRequestId: randomUUID(), expectedRevision: "1", audience: { kind: "member", actorId: memberId }, preset: "viewer",
    });
    const grant = CollaborationGrantSchema.parse(await created.json());
    expect(await outbox.runOnce()).toBe(1);

    // An older invitation for the same member: it is listed as the invitation, and its accept-only
    // session must stay an invitation session (a grant-only session cannot accept invitations).
    const invitationId = randomUUID();
    await home.db.insertInto("collaboration_members").values({
      scope_id: scopeId, actor_id: memberId, role: "viewer", status: "pending", organization_id: organizationId,
      invitation_id: invitationId, invited_by: ownerId, accepted_at: null, expires_at: new Date(now.getTime() + 86_400_000),
      revision: 1, joined_at: null, updated_at: now, dispositioned_at: null,
    }).execute();
    await publishLegacy([{ actorId: memberId, invitationId }], "invited");
    expect(await discovery(memberId, "inbox")).toEqual([expect.objectContaining({ status: "invited", invitationId })]);
    expect((await openSession(memberId)).ticket.resource).toEqual({ scopeId, kind: "project" });

    // Settling the invitation does not hide the grant the member still has to open.
    await home.db.updateTable("collaboration_members").set({ status: "accepted", accepted_at: now, joined_at: now })
      .where("scope_id", "=", scopeId).where("actor_id", "=", memberId).execute();
    // The acceptance event still names the invitation it settled.
    await publishLegacy([{ actorId: memberId, invitationId }], "accepted");
    expect(await discovery(memberId, "inbox")).toEqual([expect.objectContaining({ status: "organization_pending", grantId: grant.id })]);
    expect((await openSession(memberId)).ticket.resource).toEqual({ scopeId, kind: "project", pendingGrantId: grant.id });
  });

  it("withdraws an expired member grant from the member's inbox", async () => {
    await platformRepository.applyDirectoryEvent({
      eventId: randomUUID(), scopeId, runtimeId, ownerId, kind: "project", organizationId,
      authorityGeneration: 1, metadataRevision: 1, recipients: [{ actorId: ownerId, status: "accepted" }],
    });
    const owner = await openSession(ownerId);
    const created = await owner.request("POST", `/api/collaboration/scopes/${scopeId}/grants`, {
      clientRequestId: randomUUID(), expectedRevision: "1", audience: { kind: "member", actorId: memberId }, preset: "viewer",
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    });
    expect(created.status).toBe(201);
    expect(await outbox.runOnce()).toBe(1);
    expect(await discovery(memberId, "inbox")).toHaveLength(1);
    // The home's expiry sweep, an hour later, ends the grant and tells the platform.
    const hourLater = () => new Date(now.getTime() + 3_600_000);
    const later = new CollaborationCapabilityRepository(home.db, { now: hourLater, createId: randomUUID });
    expect(await later.expireGrants()).toBe(1);
    const laterOutbox = new CollaborationDirectoryOutbox({
      db: home.db, runtimeId, platformBaseUrl: "https://platform.internal", serviceToken, startTimer: false, now: hourLater,
      fetchImpl: async (url, init) => platformApp.request(new URL(String(url)).pathname, init),
    });
    try {
      expect(await laterOutbox.runOnce()).toBe(1);
    } finally {
      await laterOutbox.shutdown();
    }
    expect(await discovery(memberId, "inbox")).toEqual([]);
    await expect(openSession(memberId)).rejects.toMatchObject({ code: "not_found" });
  });

  it("keeps a member's other access listed when their member grant expires", async () => {
    await platformRepository.applyDirectoryEvent({
      eventId: randomUUID(), scopeId, runtimeId, ownerId, kind: "project", organizationId,
      authorityGeneration: 1, metadataRevision: 1, recipients: [{ actorId: ownerId, status: "accepted" }],
    });
    const owner = await openSession(ownerId);
    // The member already opened the organization-wide share.
    const organizationGrant = CollaborationGrantSchema.parse(await (await owner.request("POST", `/api/collaboration/scopes/${scopeId}/grants`, {
      clientRequestId: randomUUID(), expectedRevision: "1", audience: { kind: "organization" }, preset: "viewer",
    })).json());
    expect(await outbox.runOnce()).toBe(1);
    const joining = await openSession(memberId);
    expect(joining.ticket.resource).toEqual({ scopeId, kind: "project", pendingGrantId: organizationGrant.id });
    expect((await joining.request("POST", `/api/collaboration/scopes/${scopeId}/grants/${organizationGrant.id}/accept`, {})).status).toBe(200);
    expect(await outbox.runOnce()).toBe(1);
    // A temporary upgrade addressed to them lapses.
    const scopeRevision = (await home.db.selectFrom("collaboration_scopes").select("revision").where("id", "=", scopeId).executeTakeFirstOrThrow()).revision;
    expect((await owner.request("POST", `/api/collaboration/scopes/${scopeId}/grants`, {
      clientRequestId: randomUUID(), expectedRevision: String(scopeRevision), audience: { kind: "member", actorId: memberId },
      preset: "contributor", expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    })).status).toBe(201);
    expect(await outbox.runOnce()).toBe(1);
    const hourLater = () => new Date(now.getTime() + 3_600_000);
    expect(await new CollaborationCapabilityRepository(home.db, { now: hourLater, createId: randomUUID }).expireGrants()).toBe(1);
    const laterOutbox = new CollaborationDirectoryOutbox({
      db: home.db, runtimeId, platformBaseUrl: "https://platform.internal", serviceToken, startTimer: false, now: hourLater,
      fetchImpl: async (url, init) => platformApp.request(new URL(String(url)).pathname, init),
    });
    try {
      expect(await laterOutbox.runOnce()).toBe(1);
    } finally {
      await laterOutbox.shutdown();
    }
    // The organization-wide access they still hold keeps the project listed and openable.
    expect(await discovery(memberId, "shared")).toEqual([expect.objectContaining({ scopeId, status: "accepted" })]);
    expect((await openSession(memberId)).ticket.resource).toEqual({ scopeId, kind: "project" });
  });

  it("admits an accept-only session for a member grant only to its addressee", async () => {
    await platformRepository.applyDirectoryEvent({
      eventId: randomUUID(), scopeId, runtimeId, ownerId, kind: "project", organizationId,
      authorityGeneration: 1, metadataRevision: 1, recipients: [{ actorId: ownerId, status: "accepted" }],
    });
    const owner = await openSession(ownerId);
    const created = await owner.request("POST", `/api/collaboration/scopes/${scopeId}/grants`, {
      clientRequestId: randomUUID(), expectedRevision: "1", audience: { kind: "member", actorId: memberId }, preset: "viewer",
    });
    const grant = CollaborationGrantSchema.parse(await created.json());
    // The platform never signs this, but the home must not rely on that: a correctly signed
    // accept-only ticket naming someone else's member grant is still refused at admission.
    const exchange = (actorId: string) => {
      const key = generateKeyPairSync("ed25519");
      const proofPublicKey = ed25519PublicKeyRaw(key.publicKey);
      const ticket = {
        protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION, ticketId: randomUUID(), nonce: randomUUID().replaceAll("-", ""),
        actorId, organizationId, resource: { scopeId, kind: "project", pendingGrantId: grant.id }, purpose: "direct_session",
        runtime: { runtimeId: logicalRuntimeId, authorityGeneration: 1 }, proofKeyThumbprint: proofKeyThumbprint(proofPublicKey),
        maxActions: 10, issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 30_000).toISOString(),
      };
      return directSessions.create({
        clientRequestId: randomUUID(), proofPublicKey, clientOrigin,
        signedTicket: { ticket, keyId: "ticket-key-1", signature: signEd25519(ed25519PrivateKeyFromSeed(ticketSeed), ticketSigningPayload(ticket)) },
        possession: signEd25519(key.privateKey, possessionPayload({ ticketNonce: ticket.nonce, purpose: "direct_session" })),
      });
    };
    await expect(exchange(bystanderId)).rejects.toMatchObject({ code: "denied" });
    await expect(exchange(memberId)).resolves.toMatchObject({ actorId: memberId, pendingGrantId: grant.id });
    await home.db.updateTable("collaboration_grants").set({ state: "revoked" }).where("id", "=", grant.id).execute();
    await expect(exchange(memberId)).rejects.toMatchObject({ code: "denied" });
  });
});
