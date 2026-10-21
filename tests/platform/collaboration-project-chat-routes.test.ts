/**
 * A shared project's Chats are inherited scopes on the owner's home. The platform routes each one to
 * the same home and admits its tickets from the parent project's membership, so a member who
 * accepted the project can open its Chats, while invitees, pending organization members, revoked
 * members and outsiders cannot.
 */
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COLLABORATION_DIRECT_PROTOCOL_VERSION, CollaborationDirectoryEventSchema } from "@matrix-os/contracts";
import { bootstrapPlatformCollaborationDatabase } from "../../packages/platform/src/collaboration/database.js";
import { PlatformCollaborationRepository } from "../../packages/platform/src/collaboration/repository.js";
import {
  bootstrapPlatformRuntimeEndpointDatabase,
  CollaborationRuntimeEndpointRegistry,
} from "../../packages/platform/src/collaboration/runtime-endpoints.js";
import { CollaborationTicketIssuer } from "../../packages/platform/src/collaboration/ticket-issuer.js";
import { ed25519PublicKeyRaw } from "../../packages/platform/src/collaboration/ticket-crypto.js";
import {
  createPlatformCollaborationTestDatabase,
  destroyPlatformCollaborationTestDatabase,
  platformCollaborationActors,
  type PlatformCollaborationTestDatabase,
} from "./collaboration-test-support.js";

const now = new Date("2026-10-03T12:00:00.000Z");
const machineId = "11111111-1111-4111-8111-111111111111";
const runtimeId = `vps:${machineId}`;
const logicalRuntimeId = `vps-${machineId}`;
const otherRuntimeId = "vps:22222222-2222-4222-8222-222222222222";
const organizationId = "org_project_chats";
const projectScope = "10000000-0000-4000-8000-0000000000a1";
const chatScope = "10000000-0000-4000-8000-0000000000c1";
const grantId = "50000000-0000-4000-8000-0000000000a1";
const owner = platformCollaborationActors.owner;
const accepted = platformCollaborationActors.recipientWithoutComputer;
const invited = "user_project_invited";
const revoked = "user_project_revoked";
const pendingMember = "user_project_org_pending";
const seed = Buffer.alloc(32, 7).toString("base64url");

let eventCounter = 0;
function eventId(): string {
  eventCounter += 1;
  return `20000000-0000-4000-8000-${eventCounter.toString(16).padStart(12, "0")}`;
}

function proofKey(): string {
  return ed25519PublicKeyRaw(generateKeyPairSync("ed25519").publicKey);
}

function chatRoute(overrides: Record<string, unknown> = {}) {
  return {
    eventId: eventId(),
    scopeId: chatScope,
    runtimeId,
    ownerId: owner,
    kind: "chat" as const,
    organizationId,
    authorityGeneration: 1,
    metadataRevision: 1,
    recipients: [],
    parentScopeId: projectScope,
    ...overrides,
  };
}

describe("shared project Chat routes", () => {
  let fixture: PlatformCollaborationTestDatabase;
  let repository: PlatformCollaborationRepository;
  let endpoints: CollaborationRuntimeEndpointRegistry;
  let members: Set<string>;
  let issuer: CollaborationTicketIssuer;

  beforeEach(async () => {
    fixture = await createPlatformCollaborationTestDatabase();
    await bootstrapPlatformCollaborationDatabase(fixture.collaborationDb);
    await bootstrapPlatformRuntimeEndpointDatabase(fixture.collaborationDb as never);
    repository = new PlatformCollaborationRepository(fixture.collaborationDb, { now: () => now });
    await repository.applyDirectoryEvent({
      eventId: eventId(),
      scopeId: projectScope,
      runtimeId,
      ownerId: owner,
      kind: "project",
      organizationId,
      audience: "organization",
      organizationGrantId: grantId,
      authorityGeneration: 1,
      metadataRevision: 3,
      recipients: [
        { actorId: owner, status: "accepted" },
        { actorId: accepted, status: "accepted" },
        { actorId: invited, status: "invited", invitationId: "30000000-0000-4000-8000-0000000000a1" },
        { actorId: revoked, status: "revoked" },
      ],
    });
    endpoints = new CollaborationRuntimeEndpointRegistry(fixture.collaborationDb as never, { now: () => now, keyOverlapMs: 10 * 60_000 });
    await endpoints.register({
      authenticated: { runtimeId, ownerId: owner, relayHandle: "owner-handle" },
      registration: {
        protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION,
        runtimeId: logicalRuntimeId,
        ownerId: owner,
        relayHandle: "owner-handle",
        authorityGeneration: 1,
        publicKeys: [{ keyId: "home-key-1", algorithm: "ed25519", publicKey: proofKey() }],
      },
    });
    await endpoints.heartbeat(logicalRuntimeId);
    members = new Set([owner, accepted, invited, revoked, pendingMember]);
    issuer = new CollaborationTicketIssuer({
      keyring: { activeKeyId: "ticket-key-1", keys: { "ticket-key-1": seed } },
      repository,
      endpoints,
      resolveOrganization: async (id) => (await repository.getDirectoryRoute(id))?.organizationId ?? null,
      projection: { isCurrentMember: async ({ actorId }) => members.has(actorId) },
      relayOrigin: "https://app.matrix-os.com",
      now: () => now,
    });
  });

  afterEach(async () => {
    await destroyPlatformCollaborationTestDatabase(fixture);
  });

  const issue = (actorId: string, purpose: "direct_session" | "events" = "direct_session", scopeId = chatScope) => issuer.issue({
    actorId,
    request: { clientRequestId: "40000000-0000-4000-8000-0000000000c1", scopeId, purpose, proofPublicKey: proofKey() },
  });

  it("only accepts a Chat route that names its project and carries nothing else", () => {
    expect(CollaborationDirectoryEventSchema.safeParse(chatRoute()).success).toBe(true);
    for (const invalid of [
      chatRoute({ recipients: [{ actorId: accepted, status: "accepted" }] }),
      chatRoute({ audience: "organization", organizationGrantId: grantId }),
      chatRoute({ kind: "terminal" }),
      chatRoute({ organizationId: undefined }),
      chatRoute({ parentScopeId: chatScope }),
    ]) {
      expect(CollaborationDirectoryEventSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("routes a project Chat to its project's home and records the parent", async () => {
    await repository.applyDirectoryEvent(chatRoute());
    expect(await repository.getDirectoryRoute(chatScope)).toMatchObject({
      scopeId: chatScope,
      runtimeId,
      ownerId: owner,
      kind: "chat",
      organizationId,
      audience: null,
      organizationGrantId: null,
      parentScopeId: projectScope,
    });
    expect((await repository.getDirectoryRoute(projectScope))?.parentScopeId).toBeNull();
  });

  it("refuses a Chat route whose project is unknown or belongs to another home, owner or organization", async () => {
    const unknownParent = "10000000-0000-4000-8000-0000000000ff";
    await expect(repository.applyDirectoryEvent(chatRoute({ parentScopeId: unknownParent })))
      .rejects.toMatchObject({ code: "conflict" });
    const foreignProject = "10000000-0000-4000-8000-0000000000a2";
    await repository.applyDirectoryEvent({
      eventId: eventId(), scopeId: foreignProject, runtimeId: otherRuntimeId, ownerId: owner, kind: "project",
      organizationId, authorityGeneration: 1, metadataRevision: 1, recipients: [{ actorId: owner, status: "accepted" }],
    });
    await expect(repository.applyDirectoryEvent(chatRoute({ parentScopeId: foreignProject })))
      .rejects.toMatchObject({ code: "conflict" });
    await expect(repository.applyDirectoryEvent(chatRoute({ organizationId: "org_other" })))
      .rejects.toMatchObject({ code: "conflict" });
    const chatParent = "10000000-0000-4000-8000-0000000000a3";
    await repository.applyDirectoryEvent({
      eventId: eventId(), scopeId: chatParent, runtimeId, ownerId: owner, kind: "chat",
      organizationId, authorityGeneration: 1, metadataRevision: 1, recipients: [{ actorId: owner, status: "accepted" }],
    });
    await expect(repository.applyDirectoryEvent(chatRoute({ parentScopeId: chatParent })))
      .rejects.toMatchObject({ code: "conflict" });
    expect(await repository.getDirectoryRoute(chatScope)).toBeNull();
  });

  it("absorbs a directly shared Chat into its project: only the project's membership applies", async () => {
    await repository.applyDirectoryEvent(chatRoute({
      parentScopeId: undefined,
      recipients: [{ actorId: owner, status: "accepted" }, { actorId: revoked, status: "accepted" }, { actorId: accepted, status: "revoked" }],
    }));
    await repository.applyDirectoryEvent(chatRoute({ metadataRevision: 2 }));
    expect((await repository.getDirectoryRoute(chatScope))?.parentScopeId).toBe(projectScope);
    expect((await repository.listForActorPage(revoked, "accepted", { limit: 50 })).items).toEqual([]);
    await expect(issue(revoked)).rejects.toMatchObject({ code: "not_found" });
    await expect(issue(accepted)).resolves.toBeTruthy();
  });

  it("never moves a project Chat to another project or out of its project, and ignores stale events", async () => {
    await repository.applyDirectoryEvent(chatRoute({ metadataRevision: 5 }));
    const otherProject = "10000000-0000-4000-8000-0000000000a4";
    await repository.applyDirectoryEvent({
      eventId: eventId(), scopeId: otherProject, runtimeId, ownerId: owner, kind: "project",
      organizationId, authorityGeneration: 1, metadataRevision: 1, recipients: [{ actorId: owner, status: "accepted" }],
    });
    await expect(repository.applyDirectoryEvent(chatRoute({ metadataRevision: 6, parentScopeId: otherProject })))
      .rejects.toMatchObject({ code: "conflict" });
    await expect(repository.applyDirectoryEvent(chatRoute({ metadataRevision: 6, parentScopeId: undefined, recipients: [{ actorId: owner, status: "accepted" }] })))
      .rejects.toMatchObject({ code: "conflict" });
    await expect(repository.applyDirectoryEvent(chatRoute({ metadataRevision: 4, parentScopeId: undefined, recipients: [{ actorId: invited, status: "accepted" }] })))
      .resolves.toBeUndefined();
    expect(await repository.getDirectoryRoute(chatScope)).toMatchObject({ parentScopeId: projectScope });
    expect((await repository.listForActorPage(invited, "accepted", { limit: 50 })).items).toEqual([]);
  });

  it("issues a project Chat ticket to a member who accepted the project, for sessions and live events", async () => {
    await repository.applyDirectoryEvent(chatRoute());
    for (const purpose of ["direct_session", "events"] as const) {
      const issued = await issue(accepted, purpose);
      expect(issued.signedTicket.ticket).toMatchObject({
        actorId: accepted,
        organizationId,
        resource: { scopeId: chatScope, kind: "chat" },
        purpose,
        runtime: { runtimeId: logicalRuntimeId, authorityGeneration: 1 },
      });
      expect(issued.signedTicket.ticket.resource).not.toHaveProperty("pendingGrantId");
    }
    await expect(issue(owner)).resolves.toBeTruthy();
  });

  it("denies a project Chat to invitees, pending organization members, revoked members, outsiders and former organization members", async () => {
    await repository.applyDirectoryEvent(chatRoute());
    // The organization member may open the project itself to accept it, but not its Chats before accepting.
    await expect(issue(pendingMember, "direct_session", projectScope)).resolves.toBeTruthy();
    for (const actorId of [invited, pendingMember, revoked, "user_outsider"]) {
      await expect(issue(actorId)).rejects.toMatchObject({ code: "not_found" });
    }
    members.delete(accepted);
    await expect(issue(accepted)).rejects.toMatchObject({ code: "not_found" });
  });

  it("follows the project's membership as it changes", async () => {
    await repository.applyDirectoryEvent(chatRoute());
    await expect(issue(accepted)).resolves.toBeTruthy();
    await repository.applyDirectoryEvent({
      eventId: eventId(), scopeId: projectScope, runtimeId, ownerId: owner, kind: "project",
      organizationId, authorityGeneration: 1, metadataRevision: 4, recipients: [{ actorId: accepted, status: "revoked" }],
    });
    await expect(issue(accepted)).rejects.toMatchObject({ code: "not_found" });
  });

  it("keeps project Chats out of Shared with me and removes them with their project", async () => {
    await repository.applyDirectoryEvent(chatRoute());
    const shared = await repository.listForActorPage(accepted, "accepted", { limit: 50 });
    expect(shared.items.map((item) => item.scopeId)).toEqual([projectScope]);
    await fixture.collaborationDb.deleteFrom("collaboration_directory").where("scope_id", "=", projectScope).execute();
    expect(await repository.getDirectoryRoute(chatScope)).toBeNull();
  });
});
