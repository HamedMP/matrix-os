/**
 * A private project's owner prepares it through an owner-runtime session: the client marks those
 * reads and the confirm with `x-matrix-collaboration-owner-runtime`, and the home uses that marker
 * to verify the owner-runtime session instead of a scope session (`route-support.ts`). These tests
 * drive the real direct client through the real relay to a real home (routes, sessions, PGlite),
 * and show the marker grants nothing without a valid owner-runtime session.
 */
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COLLABORATION_DIRECT_PROTOCOL_VERSION } from "@matrix-os/contracts";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { CollaborationActorProofVerifier } from "../../packages/gateway/src/collaboration/actor-proof.js";
import { CollaborationAuthority } from "../../packages/gateway/src/collaboration/authority.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { DirectReplayCache, DirectTicketVerifier } from "../../packages/gateway/src/collaboration/direct-auth.js";
import { requestSigningPayload, sha256Hex } from "../../packages/gateway/src/collaboration/direct-crypto.js";
import { createDirectSessionRoutes } from "../../packages/gateway/src/collaboration/direct-routes.js";
import { DirectSessionService } from "../../packages/gateway/src/collaboration/direct-sessions.js";
import { createOrganizationPrecondition } from "../../packages/gateway/src/collaboration/organization-precondition.js";
import { OwnerRuntimeSessionService } from "../../packages/gateway/src/collaboration/owner-runtime-sessions.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import { createCollaborationRoutes, type CollaborationRouteOptions } from "../../packages/gateway/src/collaboration/routes.js";
import { CollaborationRelay } from "../../packages/platform/src/collaboration/relay.js";
import {
  ed25519PrivateKeyFromSeed, ed25519PublicKeyRaw, possessionPayload, proofKeyThumbprint, signEd25519, ticketSigningPayload,
} from "../../packages/platform/src/collaboration/ticket-crypto.js";
import { createCollaborationDirectClient } from "../../packages/ui/src/collaboration/direct-client.js";
import { createCollaborationTestDatabase, type CollaborationTestDatabase } from "../gateway/collaboration-test-support.js";

const PLATFORM = "https://app.matrix-os.com";
const HOME = "https://203.0.113.10:443";
const OWNER_RUNTIME_HEADER = "x-matrix-collaboration-owner-runtime";
const now = new Date("2026-09-21T15:00:00.000Z");
const runtimeId = "vps:11111111-1111-4111-8111-111111111111";
const logicalRuntimeId = "vps-11111111-1111-4111-8111-111111111111";
const ownerId = "user_relay_project_owner";
const editorId = "user_relay_project_editor";
const organizationId = "org_relay_project";
const privateScopeId = "10000000-0000-4000-8000-00000000c901";
const sharedScopeId = "10000000-0000-4000-8000-00000000c902";
const platformKey = ed25519PrivateKeyFromSeed(Buffer.alloc(32, 23).toString("base64url"));
const hash = (seed: string) => sha256Hex(new TextEncoder().encode(seed));
const inventoryToken = "t".repeat(64);

function signTicket(ticket: Record<string, unknown>) {
  return { ticket, keyId: "platform-1", signature: signEd25519(platformKey, ticketSigningPayload(ticket)) };
}

describe("relaying a private project owner's setup requests", () => {
  let fixture: CollaborationTestDatabase;
  let directSessions: DirectSessionService;
  let ownerRuntimeSessions: OwnerRuntimeSessionService;
  let home: Hono;
  let relay: CollaborationRelay;
  let forwarded: Headers[];
  let projectSharing: { preview: ReturnType<typeof vi.fn>; confirm: ReturnType<typeof vi.fn> };
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    for (const [scopeId, lifecycle] of [[privateScopeId, "private"], [sharedScopeId, "shared"]] as const) {
      await fixture.db.insertInto("collaboration_scopes").values({
        id: scopeId, owner_type: "personal", owner_id: ownerId, organization_id: organizationId,
        kind: "project", resource_id: `project_${lifecycle}`, parent_scope_id: null,
        membership_mode: "direct", lifecycle, authority_runtime_id: runtimeId,
        authority_generation: 1, revision: 1, auth_epoch: 1, execution_generation: null,
        execution_eligibility: null, deleted_at: null, created_at: now, updated_at: now,
      }).execute();
    }
    for (const [scopeId, actorId, role] of [
      [privateScopeId, ownerId, "owner"], [sharedScopeId, ownerId, "owner"], [sharedScopeId, editorId, "editor"],
    ] as const) {
      await fixture.db.insertInto("collaboration_members").values({
        scope_id: scopeId, actor_id: actorId, role, status: "accepted", organization_id: organizationId,
        invitation_id: null, invited_by: ownerId, accepted_at: now, expires_at: null, revision: 1,
        joined_at: now, updated_at: now, dispositioned_at: null,
      }).execute();
    }
    const repository = new CollaborationRepository(fixture.db, { now: () => now });
    const precondition = createOrganizationPrecondition({
      source: { async assertMembership({ actorId }) {
        return actorId === ownerId || actorId === editorId
          ? { member: true, expiresAt: new Date(now.getTime() + 20_000).toISOString() } : { member: false };
      } },
      now: () => now,
    });
    const authority = new CollaborationAuthority(repository, { organizationPrecondition: precondition, now: () => now });
    const ticketVerifier = new DirectTicketVerifier({
      runtimeId, platformKeys: () => [{ keyId: "platform-1", algorithm: "ed25519", publicKey: ed25519PublicKeyRaw(platformKey) }],
      controlFresh: () => true, allowedClientOrigins: [PLATFORM],
      replay: new DirectReplayCache({ now: () => now }), now: () => now,
    });
    directSessions = new DirectSessionService({ verifier: ticketVerifier, authority, repository, now: () => now });
    ownerRuntimeSessions = new OwnerRuntimeSessionService({
      verifier: ticketVerifier, ownerId, runtimeId, organizationPrecondition: precondition, now: () => now,
    });
    projectSharing = {
      preview: vi.fn(async ({ scopeId }: { scopeId: string }) => ({
        scopeId, projectId: "project_private", projectRevision: 1, scopeRevision: 1, ownedItems: [], externalReferences: [],
        blockers: [], membershipEffects: [], inventoryHash: hash("inventory"), membershipHash: hash("members"), inventoryToken,
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      })),
      confirm: vi.fn(async ({ scopeId }: { scopeId: string }) => ({
        id: "20000000-0000-4000-8000-00000000c901", scopeId, status: "prepared", inventoryRevision: 1,
        createdAt: now.toISOString(), updatedAt: now.toISOString(),
      })),
    };
    home = new Hono();
    home.route("/", createDirectSessionRoutes({ sessions: directSessions, ownerRuntimeSessions }));
    home.route("/", createCollaborationRoutes({
      runtimeId, repository, authority, directSessions, ownerRuntimeSessions, projectSharing,
      verifier: new CollaborationActorProofVerifier({ runtimeId, keys: { "legacy-1": "x".repeat(32) }, now: () => now, authority }),
      executionPolicies: { resolve: async () => null },
      resolveParticipant: async (actorId: string) => ({ actorId, displayName: actorId }),
    } as unknown as CollaborationRouteOptions));
    forwarded = [];
    relay = new CollaborationRelay({
      // As in production: a private project is never published to the platform directory until it
      // becomes active (project-scope.ts writes no outbox row), so only the shared scope has a route.
      // Stubbing a route for the private scope here is what hid the owner-setup 404 in production.
      resolveScopeHome: async (id) => (id === sharedScopeId ? { runtimeId: logicalRuntimeId, origin: HOME } : null),
      resolveInvitationHome: async () => null,
      resolveRuntimeHome: async () => null,
      resolveSessionHome: async (id) => (id === logicalRuntimeId ? { runtimeId: logicalRuntimeId, origin: HOME } : null),
      // Only the runtime's own owner may be routed to it by runtime id.
      resolveOwnerRuntimeHome: async (actorId, id) => (actorId === ownerId && id === logicalRuntimeId ? { runtimeId: logicalRuntimeId, origin: HOME } : null),
      fetchImpl: (async (input: string, init: RequestInit) => {
        const url = new URL(input);
        forwarded.push(new Headers(init.headers));
        return home.request(`${url.pathname}${url.search}`, init);
      }) as typeof fetch,
    });
  });

  afterEach(async () => {
    relay.close();
    await directSessions.shutdown();
    await ownerRuntimeSessions.shutdown();
    await fixture.destroy();
    warn.mockRestore();
  });

  /** The platform: issues the owner-runtime ticket itself and relays everything else to the home. */
  const platformFetch = (actorId: string) => vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = typeof init?.body === "string" ? init.body : "";
    if (url.pathname === "/api/collaboration/owner-runtime/connections") {
      const request = JSON.parse(body) as { proofPublicKey: string };
      const ticket = {
        protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION, ticketId: randomUUID(), nonce: randomUUID().replaceAll("-", ""),
        actorId, organizationId, resource: { kind: "owner_runtime" }, purpose: "owner_runtime",
        runtime: { runtimeId: logicalRuntimeId, authorityGeneration: 1 }, proofKeyThumbprint: proofKeyThumbprint(request.proofPublicKey),
        maxActions: 32, issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 30_000).toISOString(),
      };
      return Response.json({ signedTicket: signTicket(ticket), endpoint: { origin: PLATFORM, protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION } }, { status: 201 });
    }
    return relay.forward({
      actorId, method: (init?.method ?? "GET").toUpperCase(), path: url.pathname, query: url.search.slice(1),
      headers: new Headers(init?.headers), body: body ? new TextEncoder().encode(body) : null,
    });
  });

  const ownerClient = () => createCollaborationDirectClient({ platformBaseUrl: PLATFORM, fetchImpl: platformFetch(ownerId), clientOrigin: PLATFORM, now: () => now });

  it("carries the owner's private project reads, inventory and confirm to owner-runtime verification", async () => {
    const direct = ownerClient();
    const base = `/api/collaboration/scopes/${privateScopeId}`;
    await expect(direct.requestOwnerProject(runtimeId, organizationId, "GET", base))
      .resolves.toMatchObject({ id: privateScopeId, lifecycle: "private" });
    await expect(direct.requestOwnerProject(runtimeId, organizationId, "GET", `${base}/members`)).resolves.toBeDefined();
    await expect(direct.requestOwnerProject(runtimeId, organizationId, "GET", `${base}/project/inventory`))
      .resolves.toMatchObject({ scopeId: privateScopeId, inventoryToken });
    await expect(direct.requestOwnerProject(runtimeId, organizationId, "POST", `${base}/project/confirm`, {
      clientRequestId: "30000000-0000-4000-8000-00000000c901", expectedScopeRevision: "1", expectedProjectRevision: "1",
      inventoryHash: hash("inventory"), membershipHash: hash("members"), inventoryToken,
    })).resolves.toMatchObject({ scopeId: privateScopeId, status: "prepared" });
    expect(projectSharing.preview).toHaveBeenCalledWith(expect.objectContaining({ scopeId: privateScopeId, actorId: ownerId }));
    expect(projectSharing.confirm).toHaveBeenCalledWith(expect.objectContaining({ scopeId: privateScopeId, actorId: ownerId }));
    // One owner-runtime session served all four signed requests; the marker reached the home on each.
    const signed = forwarded.filter((headers) => headers.has("x-matrix-collaboration-session"));
    expect(signed).toHaveLength(4);
    for (const headers of signed) expect(headers.get(OWNER_RUNTIME_HEADER)).toBe("1");
  });

  function signedHeaders(sessionId: string, key: ReturnType<typeof generateKeyPairSync>, method: string, path: string) {
    const signature = {
      protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION, sessionId, method, path, query: "",
      bodyDigest: sha256Hex(new Uint8Array()), conditionalHeadersDigest: sha256Hex(new Uint8Array()),
      nonce: randomUUID().replaceAll("-", ""), issuedAt: now.toISOString(),
    };
    return {
      "x-matrix-collaboration-session": sessionId,
      "x-matrix-collaboration-request": Buffer.from(JSON.stringify({ signature, proof: signEd25519(key.privateKey, requestSigningPayload(signature)) })).toString("base64url"),
    };
  }

  const relayed = (actorId: string, path: string, headers: Record<string, string>) =>
    relay.forward({ actorId, method: "GET", path, query: "", headers: new Headers(headers), body: null });

  it("grants nothing for a forged owner-runtime marker without an owner-runtime session", async () => {
    const inventory = `/api/collaboration/scopes/${sharedScopeId}/project/inventory`;
    // A collaborator's own valid scope session, relayed with the marker, is refused owner inventory.
    const key = generateKeyPairSync("ed25519");
    const publicKey = ed25519PublicKeyRaw(key.publicKey);
    const ticket = {
      protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION, ticketId: randomUUID(), nonce: randomUUID().replaceAll("-", ""),
      actorId: editorId, organizationId, resource: { scopeId: sharedScopeId, kind: "project" }, purpose: "direct_session",
      runtime: { runtimeId: logicalRuntimeId, authorityGeneration: 1 }, proofKeyThumbprint: proofKeyThumbprint(publicKey),
      maxActions: 32, issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 30_000).toISOString(),
    };
    const session = await directSessions.create({
      clientRequestId: randomUUID(), signedTicket: signTicket(ticket), proofPublicKey: publicKey,
      possession: signEd25519(key.privateKey, possessionPayload({ ticketNonce: ticket.nonce, purpose: "direct_session" })),
      clientOrigin: PLATFORM,
    });
    // Without the marker the home judges it as the editor it is (not the owner); with it, as an
    // owner-runtime session it is not. Neither reaches the owner's project inventory.
    expect((await relayed(editorId, inventory, signedHeaders(session.id, key, "GET", inventory))).status).toBe(403);
    expect((await relayed(editorId, inventory, { ...signedHeaders(session.id, key, "GET", inventory), [OWNER_RUNTIME_HEADER]: "1" })).status).toBe(401);
    // The same session reads the scope it was granted, so the refusals above are about ownership, not a broken session.
    const read = `/api/collaboration/scopes/${sharedScopeId}`;
    expect((await relayed(editorId, read, signedHeaders(session.id, key, "GET", read))).status).toBe(200);
    // No session at all, or a made-up one, is refused before any project data is touched.
    expect((await relayed(editorId, inventory, { [OWNER_RUNTIME_HEADER]: "1" })).status).toBe(401);
    expect((await relayed(editorId, inventory, { ...signedHeaders(randomUUID(), key, "GET", inventory), [OWNER_RUNTIME_HEADER]: "1" })).status).toBe(401);
    // The owner's valid owner-runtime session does not open a scope that is no longer private.
    const direct = ownerClient();
    await expect(direct.requestOwnerProject(runtimeId, organizationId, "GET", inventory)).rejects.toMatchObject({ code: "denied" });
    expect(projectSharing.preview).not.toHaveBeenCalled();
  });
});
