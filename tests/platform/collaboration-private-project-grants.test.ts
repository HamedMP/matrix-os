/**
 * Custom access before sharing: a private project's owner chooses who gets access through the
 * owner setup key, and the choice stays on the home until the project is shared. These tests
 * drive the real direct client through the real relay to a real home (routes, owner-runtime
 * sessions, capability grants on PGlite).
 */
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COLLABORATION_DIRECT_PROTOCOL_VERSION, CollaborationGrantSchema } from "@matrix-os/contracts";
import { z } from "zod/v4";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { CollaborationActorProofVerifier } from "../../packages/gateway/src/collaboration/actor-proof.js";
import { CollaborationAuthority } from "../../packages/gateway/src/collaboration/authority.js";
import { CollaborationCapabilityEvaluator } from "../../packages/gateway/src/collaboration/capability-evaluator.js";
import { CollaborationCapabilityRepository } from "../../packages/gateway/src/collaboration/capability-repository.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { DirectReplayCache, DirectTicketVerifier } from "../../packages/gateway/src/collaboration/direct-auth.js";
import { createDirectSessionRoutes } from "../../packages/gateway/src/collaboration/direct-routes.js";
import { DirectSessionService } from "../../packages/gateway/src/collaboration/direct-sessions.js";
import { createOrganizationPrecondition } from "../../packages/gateway/src/collaboration/organization-precondition.js";
import { OwnerRuntimeSessionService } from "../../packages/gateway/src/collaboration/owner-runtime-sessions.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import { createCollaborationRoutes, type CollaborationRouteOptions } from "../../packages/gateway/src/collaboration/routes.js";
import { CollaborationRelay } from "../../packages/platform/src/collaboration/relay.js";
import {
  ed25519PrivateKeyFromSeed, ed25519PublicKeyRaw, proofKeyThumbprint, signEd25519, ticketSigningPayload,
} from "../../packages/platform/src/collaboration/ticket-crypto.js";
import { createCollaborationDirectClient } from "../../packages/ui/src/collaboration/direct-client.js";
import { createCollaborationTestDatabase, type CollaborationTestDatabase } from "../gateway/collaboration-test-support.js";

const PLATFORM = "https://app.matrix-os.com";
const HOME = "https://203.0.113.10:443";
const now = new Date("2026-10-03T15:00:00.000Z");
const runtimeId = "vps:11111111-1111-4111-8111-111111111111";
const logicalRuntimeId = "vps-11111111-1111-4111-8111-111111111111";
const ownerId = "user_private_grants_owner";
const memberId = "user_private_grants_member";
const organizationId = "org_private_grants";
const privateScopeId = "10000000-0000-4000-8000-00000000e901";
const sharedScopeId = "10000000-0000-4000-8000-00000000e902";
const platformKey = ed25519PrivateKeyFromSeed(Buffer.alloc(32, 29).toString("base64url"));
const GrantListSchema = z.array(CollaborationGrantSchema);

describe("choosing access on a private project before sharing it", () => {
  let fixture: CollaborationTestDatabase;
  let directSessions: DirectSessionService;
  let ownerRuntimeSessions: OwnerRuntimeSessionService;
  let relay: CollaborationRelay;
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
      await fixture.db.insertInto("collaboration_members").values({
        scope_id: scopeId, actor_id: ownerId, role: "owner", status: "accepted", organization_id: organizationId,
        invitation_id: null, invited_by: ownerId, accepted_at: now, expires_at: null, revision: 1,
        joined_at: now, updated_at: now, dispositioned_at: null,
      }).execute();
    }
    const repository = new CollaborationRepository(fixture.db, { now: () => now });
    const precondition = createOrganizationPrecondition({
      source: { async assertMembership({ actorId }) {
        return actorId === ownerId || actorId === memberId
          ? { member: true, expiresAt: new Date(now.getTime() + 20_000).toISOString(), membershipEpoch: "1" } : { member: false };
      } },
      now: () => now,
    });
    const capabilities = new CollaborationCapabilityRepository(fixture.db, { now: () => now, createId: randomUUID });
    const authority = new CollaborationAuthority(repository, { organizationPrecondition: precondition, capabilities, now: () => now });
    const ticketVerifier = new DirectTicketVerifier({
      runtimeId, platformKeys: () => [{ keyId: "platform-1", algorithm: "ed25519", publicKey: ed25519PublicKeyRaw(platformKey) }],
      controlFresh: () => true, allowedClientOrigins: [PLATFORM],
      replay: new DirectReplayCache({ now: () => now }), now: () => now,
    });
    directSessions = new DirectSessionService({ verifier: ticketVerifier, authority, repository, now: () => now, startTimers: false });
    ownerRuntimeSessions = new OwnerRuntimeSessionService({
      verifier: ticketVerifier, ownerId, runtimeId, organizationPrecondition: precondition, now: () => now,
    });
    const home = new Hono();
    home.route("/", createDirectSessionRoutes({ sessions: directSessions, ownerRuntimeSessions }));
    home.route("/", createCollaborationRoutes({
      runtimeId, repository, authority, directSessions, ownerRuntimeSessions, capabilities,
      capabilityEvaluator: new CollaborationCapabilityEvaluator({ db: fixture.db, grants: capabilities, organizationPrecondition: precondition, now: () => now }),
      verifier: new CollaborationActorProofVerifier({ runtimeId, keys: { "legacy-1": "x".repeat(32) }, now: () => now, authority }),
      executionPolicies: { resolve: async () => null },
      resolveParticipant: async (actorId: string) => ({ actorId, displayName: actorId }),
    } as unknown as CollaborationRouteOptions));
    relay = new CollaborationRelay({
      // A private project is not in the directory; only the shared one has a scope route.
      resolveScopeHome: async (id) => (id === sharedScopeId ? { runtimeId: logicalRuntimeId, origin: HOME } : null),
      resolveInvitationHome: async () => null,
      resolveRuntimeHome: async () => null,
      resolveSessionHome: async (id) => (id === logicalRuntimeId ? { runtimeId: logicalRuntimeId, origin: HOME } : null),
      resolveOwnerRuntimeHome: async (actorId, id) => (actorId === ownerId && id === logicalRuntimeId ? { runtimeId: logicalRuntimeId, origin: HOME } : null),
      fetchImpl: (async (input: string, init: RequestInit) => {
        const url = new URL(input);
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

  /** The platform: issues the owner-runtime ticket for the signed-in actor and relays everything else. */
  const client = (actorId: string) => createCollaborationDirectClient({
    platformBaseUrl: PLATFORM, clientOrigin: PLATFORM, now: () => now,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
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
        return Response.json({
          signedTicket: { ticket, keyId: "platform-1", signature: signEd25519(platformKey, ticketSigningPayload(ticket)) },
          endpoint: { origin: PLATFORM, protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION },
        }, { status: 201 });
      }
      return relay.forward({
        actorId, method: (init?.method ?? "GET").toUpperCase(), path: url.pathname, query: url.search.slice(1),
        headers: new Headers(init?.headers), body: body ? new TextEncoder().encode(body) : null,
      });
    }) as typeof fetch,
  });

  const outboxRows = () => fixture.db.selectFrom("collaboration_directory_outbox").select("event_id")
    .where("scope_id", "=", privateScopeId).execute();

  it("lists, creates, changes and revokes grants with the owner setup key and publishes none of them", async () => {
    const direct = client(ownerId);
    const grants = `/api/collaboration/scopes/${privateScopeId}/grants`;
    expect(await direct.requestOwnerProject(runtimeId, organizationId, "GET", grants)).toEqual([]);
    const created = CollaborationGrantSchema.parse(await direct.requestOwnerProject(runtimeId, organizationId, "POST", grants, {
      clientRequestId: randomUUID(), expectedRevision: "1", audience: { kind: "member", actorId: memberId }, preset: "viewer",
    }));
    expect(created).toMatchObject({ scopeId: privateScopeId, audience: { kind: "member", actorId: memberId }, state: "pending" });
    const patched = CollaborationGrantSchema.parse(await direct.requestOwnerProject(runtimeId, organizationId, "PATCH", `${grants}/${created.id}`, {
      clientRequestId: randomUUID(), expectedRevision: "2", expectedGrantRevision: "1", preset: "contributor",
    }));
    expect(patched).toMatchObject({ id: created.id, preset: "contributor" });
    const organization = CollaborationGrantSchema.parse(await direct.requestOwnerProject(runtimeId, organizationId, "POST", grants, {
      clientRequestId: randomUUID(), expectedRevision: "3", audience: { kind: "organization" }, preset: "viewer",
    }));
    const revoked = CollaborationGrantSchema.parse(await direct.requestOwnerProject(runtimeId, organizationId, "DELETE", `${grants}/${organization.id}`,
      undefined, { clientRequestId: randomUUID(), expectedRevision: "4", expectedMemberRevision: "1" }));
    expect(revoked).toMatchObject({ id: organization.id, state: "revoked" });
    expect(GrantListSchema.parse(await direct.requestOwnerProject(runtimeId, organizationId, "GET", grants))
      .map((grant) => [grant.id, grant.state]).sort()).toEqual([[created.id, "pending"], [organization.id, "revoked"]].sort());
    // Recorded and audited on the home, but the platform learns nothing until the project is shared.
    expect(await outboxRows()).toEqual([]);
    expect(await fixture.db.selectFrom("collaboration_audit").select("action").where("scope_id", "=", privateScopeId)
      .orderBy("id").execute()).toEqual([
      { action: "grant.created" }, { action: "grant.preset_changed" }, { action: "grant.created" }, { action: "grant.revoked" },
    ]);
  });

  it("never manages grants of a shared project with the owner setup key", async () => {
    const direct = client(ownerId);
    await expect(direct.requestOwnerProject(runtimeId, organizationId, "POST", `/api/collaboration/scopes/${sharedScopeId}/grants`, {
      clientRequestId: randomUUID(), expectedRevision: "1", audience: { kind: "member", actorId: memberId }, preset: "viewer",
    })).rejects.toMatchObject({ code: "denied" });
    expect(await fixture.db.selectFrom("collaboration_grants").select("id").execute()).toEqual([]);
  });

  it("gives another member no grant management on the owner's private project", async () => {
    // The member holds a valid owner-runtime ticket for nothing: the home serves only its own owner.
    await expect(client(memberId).requestOwnerProject(runtimeId, organizationId, "GET", `/api/collaboration/scopes/${privateScopeId}/grants`))
      .rejects.toMatchObject({ code: expect.stringMatching(/denied|not_found/) });
  });
});
