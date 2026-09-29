import { createHmac } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapPlatformOrganizationDatabase, type OrganizationPlatformDatabase } from "../../packages/platform/src/organizations/database.js";
import { PlatformOrganizationRepository } from "../../packages/platform/src/organizations/repository.js";
import { createOrganizationMembershipProjection } from "../../packages/platform/src/organizations/projection.js";
import { createCollaborationControlAuthority } from "../../packages/platform/src/collaboration/control-authority.js";
import { createPlatformOrganizationRoutes } from "../../packages/platform/src/organizations/routes.js";
import { OrganizationAdminRepository } from "../../packages/platform/src/organizations/admin-repository.js";
import { createTestPlatformDb, destroyTestPlatformDb, type TestPlatformDb } from "./platform-db-test-helper.js";

const org = "org_2rout00000000000000000001";
const member = "user_member0000000000000000";
const admin = "user_admin00000000000000000";
const outsider = "user_outsider00000000000000";
const runtimeId = "vps:10000000-0000-4000-8000-000000000001";
const logicalRuntimeId = "vps-10000000-0000-4000-8000-000000000001";
const runtimeToken = "r".repeat(40);
const foreignRuntimeId = "vps:10000000-0000-4000-8000-000000000002";
const foreignRuntimeToken = "f".repeat(40);
const secretBytes = Buffer.from("0123456789abcdef0123456789abcdef");
const signingSecret = `whsec_${secretBytes.toString("base64")}`;

function signed(id: string, body: string, at: Date) {
  const timestamp = Math.floor(at.getTime() / 1000);
  return {
    "content-type": "application/json",
    "svix-id": id,
    "svix-timestamp": String(timestamp),
    "svix-signature": `v1,${createHmac("sha256", secretBytes).update(`${id}.${timestamp}.${body}`).digest("base64")}`,
  };
}

function clerkMembershipEvent(type: string, actorId: string, role: string, updatedAt: number, aiSubmission?: string) {
  return JSON.stringify({
    type,
    data: {
      id: `orgmem_${actorId}`,
      role,
      created_at: updatedAt,
      updated_at: updatedAt,
      organization: { id: org, name: "Route org", slug: "route-org", public_metadata: aiSubmission ? { collaboration: { aiSubmission } } : {}, created_at: 1, updated_at: updatedAt },
      public_user_data: { user_id: actorId, identifier: "x@example.com" },
    },
  });
}

describe("platform organization routes (T018)", () => {
  let fixture: TestPlatformDb;
  let repository: PlatformOrganizationRepository;
  let adminRepository: OrganizationAdminRepository;
  let clock: Date;
  let app: ReturnType<typeof createPlatformOrganizationRoutes>;
  let projection: ReturnType<typeof createOrganizationMembershipProjection>;
  let authority: ReturnType<typeof createCollaborationControlAuthority>;
  let actor: string | null;
  let members: string[];

  beforeEach(async () => {
    fixture = await createTestPlatformDb();
    const db = fixture.db.kysely as unknown as Kysely<OrganizationPlatformDatabase>;
    await bootstrapPlatformOrganizationDatabase(db);
    clock = new Date("2026-09-20T12:00:00.000Z");
    repository = new PlatformOrganizationRepository(db, { now: () => clock });
    adminRepository = new OrganizationAdminRepository(db, { now: () => clock });
    members = [admin, member];
    projection = createOrganizationMembershipProjection({
      repository, now: () => clock,
      upstream: { listMembers: async () => ({
        organization: { organizationId: org, name: "Route org", slug: "route-org", aiSubmission: "members", sourceUpdatedAt: new Date(1_000) },
        members: members.map((actorId) => ({ membershipId: `orgmem_${actorId}`, actorId, role: actorId === admin ? "org:admin" : "org:member", sourceUpdatedAt: new Date(1_000) })),
      }) },
    });
    authority = createCollaborationControlAuthority({ repository, now: () => clock, affectedRuntimes: async () => [logicalRuntimeId], projection });
    actor = member;
    app = createPlatformOrganizationRoutes({
      repository, adminRepository, projection, controlAuthority: authority, webhookSigningSecret: signingSecret, now: () => clock,
      resolveActor: async () => actor,
      authenticateRuntime: async (input) => {
        if (input.runtimeId === runtimeId && input.bearerToken === runtimeToken) return { runtimeId, ownerId: admin };
        if (input.runtimeId === foreignRuntimeId && input.bearerToken === foreignRuntimeToken) return { runtimeId: foreignRuntimeId, ownerId: outsider };
        return null;
      },
    });
  });

  afterEach(async () => {
    await authority.shutdown();
    await projection.shutdown();
    await destroyTestPlatformDb(fixture.db);
  });

  it("removes an invitation ledger row only after a signed accepted or revoked event", async () => {
    const addressDigest = adminRepository.invitationDigest("member@example.com", "test-secret");
    const begun = await adminRepository.beginInvitation({ organizationId: org, actorId: admin, addressDigest,
      clientRequestId: "a77b8e1c-6112-4250-93d8-650d6fca8174", role: "org:member" });
    await adminRepository.completeInvitation(begun.record, "orginv_accepted000000000000", new Date(clock.getTime() + 60_000));
    const body = JSON.stringify({ type: "organizationInvitation.accepted", data: { id: "orginv_accepted000000000000", organization_id: org }, timestamp: clock.getTime() });
    expect((await app.request("/webhooks/clerk/organizations", { method: "POST", headers: signed("msg_invite_bad", body + " ", clock), body })).status).toBe(400);
    expect(await adminRepository.getInvitation(org, addressDigest)).not.toBeNull();
    expect((await app.request("/webhooks/clerk/organizations", { method: "POST", headers: signed("msg_invite_ok", body, clock), body })).status).toBe(200);
    expect(await adminRepository.getInvitation(org, addressDigest)).toBeNull();

    const pendingDigest = adminRepository.invitationDigest("pending@example.com", "test-secret");
    const pending = await adminRepository.beginInvitation({ organizationId: org, actorId: admin, addressDigest: pendingDigest,
      clientRequestId: "a77b8e1c-6112-4250-93d8-650d6fca8175", role: "org:member" });
    const early = JSON.stringify({ type: "organizationInvitation.revoked", data: {
      id: "orginv_early0000000000000000", organization_id: org,
      private_metadata: { matrixInviteRequestId: pending.record.attemptRequestId },
    }, timestamp: clock.getTime() });
    expect((await app.request("/webhooks/clerk/organizations", { method: "POST", headers: signed("msg_invite_early", early, clock), body: early })).status).toBe(200);
    expect(await adminRepository.getInvitation(org, pendingDigest)).toBeNull();
  });

  it("lists only organizations where the actor is a fresh current member", async () => {
    await projection.reconcile(org);
    const response = await app.request("/api/organizations");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ organizations: [{ organizationId: org, name: "Route org", slug: "route-org", role: "org:member", aiSubmission: "members", membershipEpoch: expect.any(Number) }] });
    actor = outsider;
    expect(await (await app.request("/api/organizations")).json()).toEqual({ organizations: [] });
    actor = null;
    expect((await app.request("/api/organizations")).status).toBe(401);
  });

  it("serves paginated members only to current members and validates the page request", async () => {
    await projection.reconcile(org);
    const first = await app.request(`/api/organizations/${org}/members?limit=1`);
    expect(first.status).toBe(200);
    const page = await first.json() as { members: Array<{ actorId: string; role: string }>; nextCursor?: string };
    expect(page.members).toHaveLength(1);
    expect(page.nextCursor).toBeTypeOf("string");
    const second = await (await app.request(`/api/organizations/${org}/members?limit=1&cursor=${encodeURIComponent(page.nextCursor!)}`)).json() as { members: Array<{ actorId: string }>; nextCursor?: string };
    expect(second.members).toHaveLength(1);
    expect(new Set([...page.members, ...second.members].map((m) => m.actorId))).toEqual(new Set([admin, member]));
    expect((await app.request(`/api/organizations/${org}/members?limit=1000`)).status).toBe(422);
    expect((await app.request(`/api/organizations/not%20an%20org/members`)).status).toBe(422);
    actor = outsider;
    expect((await app.request(`/api/organizations/${org}/members`)).status).toBe(404);
  });

  it("verifies, deduplicates and applies Clerk organization webhooks with the correct status codes", async () => {
    const body = clerkMembershipEvent("organizationMembership.created", member, "org:member", 5_000, "members");
    const headers = signed("msg_route_1", body, clock);
    const first = await app.request("/webhooks/clerk/organizations", { method: "POST", headers, body });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ received: true, outcome: "applied" });
    const dup = await app.request("/webhooks/clerk/organizations", { method: "POST", headers, body });
    expect(await dup.json()).toEqual({ received: true, outcome: "duplicate" });
    const tampered = await app.request("/webhooks/clerk/organizations", { method: "POST", headers, body: body.replace("org:member", "org:admin") });
    expect(tampered.status).toBe(400);
    const unsigned = await app.request("/webhooks/clerk/organizations", { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(unsigned.status).toBe(400);
    const oversized = await app.request("/webhooks/clerk/organizations", { method: "POST", headers: signed("msg_big", "x", clock), body: "x".repeat(300 * 1024) });
    expect(oversized.status).toBe(413);
    const ignored = JSON.stringify({ type: "user.created", data: { id: "user_x" } });
    const other = await app.request("/webhooks/clerk/organizations", { method: "POST", headers: signed("msg_route_2", ignored, clock), body: ignored });
    expect(await other.json()).toEqual({ received: true, outcome: "ignored" });
    expect((await repository.getMembership({ organizationId: org, actorId: member }))?.state).toBe("active");
  });

  it("keeps a durable revocation intent when fencing fails after the membership write, and a later drain completes it", async () => {
    await projection.reconcile(org);
    let discoveryFails = true;
    const failing = createCollaborationControlAuthority({
      repository, now: () => clock, projection,
      affectedRuntimes: async () => { if (discoveryFails) throw new Error("directory unavailable"); return [runtimeId]; },
    });
    const failingApp = createPlatformOrganizationRoutes({
      repository, projection, controlAuthority: failing, webhookSigningSecret: signingSecret, now: () => clock,
      resolveActor: async () => actor, authenticateRuntime: async () => null,
    });
    try {
      const body = clerkMembershipEvent("organizationMembership.deleted", member, "org:member", 9_500);
      const headers = signed("msg_remove_fail", body, clock);
      const first = await failingApp.request("/webhooks/clerk/organizations", { method: "POST", headers, body });
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ received: true, outcome: "applied" });
      expect((await repository.getMembership({ organizationId: org, actorId: member }))?.state).toBe("removed");
      expect(await failing.listPending()).toEqual([]);
      const intents = await repository.describeRevocationIntents({ organizationId: org, actorId: member });
      expect(intents).toHaveLength(1);
      expect(intents[0]).toMatchObject({ denialId: null, attempts: 1, deadLetter: false });
      // A redelivery is a duplicate and must not lose the pending intent.
      const retry = await failingApp.request("/webhooks/clerk/organizations", { method: "POST", headers, body });
      expect(await retry.json()).toEqual({ received: true, outcome: "duplicate" });
      discoveryFails = false;
      clock = new Date(clock.getTime() + 5_000);
      const drained = await failing.sweep();
      expect(drained.fenced).toBe(1);
      const pending = await failing.listPending();
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ organizationId: org, actorId: member, state: "pending" });
      expect((await repository.describeRevocationIntents({ organizationId: org, actorId: member }))[0]?.denialId).toBe(pending[0]!.denialId);
    } finally {
      await failing.shutdown();
    }
  });

  it("fences a denial when a webhook ends a membership", async () => {
    await projection.reconcile(org);
    const body = clerkMembershipEvent("organizationMembership.deleted", member, "org:member", 9_000);
    const response = await app.request("/webhooks/clerk/organizations", { method: "POST", headers: signed("msg_remove", body, clock), body });
    expect(response.status).toBe(200);
    const pending = await authority.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ organizationId: org, actorId: member, state: "pending" });
  });

  it("resolves batched membership assertions and accepts control acks only from the authenticated runtime", async () => {
    await projection.reconcile(org);
    const authHeaders = { authorization: `Bearer ${runtimeToken}`, "x-matrix-runtime-id": runtimeId, "content-type": "application/json" };
    const resolve = await app.request("/internal/organizations/access/resolve", {
      method: "POST", headers: authHeaders,
      body: JSON.stringify({ protocolVersion: 2, actors: [{ organizationId: org, actorId: member }, { organizationId: org, actorId: outsider }] }),
    });
    expect(resolve.status).toBe(200);
    const assertions = await resolve.json() as Array<{ type: string; actorId: string; member: boolean; aiSubmission: string; expiresAt: string; requestStartedAt: string }>;
    expect(assertions.map((a) => [a.type, a.actorId, a.member, a.aiSubmission])).toEqual([["membership_assertion", member, true, "members"], ["membership_assertion", outsider, false, "members"]]);
    expect(Date.parse(assertions[0]!.expiresAt) - Date.parse(assertions[0]!.requestStartedAt)).toBe(20_000);
    expect((await app.request("/internal/organizations/access/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    expect((await app.request("/internal/organizations/access/resolve", { method: "POST", headers: authHeaders, body: JSON.stringify({ protocolVersion: 1, actors: [] }) })).status).toBe(422);
    const ack = await app.request("/internal/collaboration/control/ack", { method: "POST", headers: authHeaders, body: JSON.stringify({ protocolVersion: 2, runtimeId: logicalRuntimeId, authorityGeneration: 1, fenceAt: clock.toISOString() }) });
    expect(ack.status).toBe(204);
    const foreign = await app.request("/internal/collaboration/control/ack", { method: "POST", headers: authHeaders, body: JSON.stringify({ protocolVersion: 2, runtimeId: "vps-10000000-0000-4000-8000-000000000009", authorityGeneration: 1, fenceAt: clock.toISOString() }) });
    expect(foreign.status).toBe(403);
  });

  it("never resolves membership for a runtime whose owner is outside the organization (no cross-tenant oracle)", async () => {
    await projection.reconcile(org);
    const foreignHeaders = { authorization: `Bearer ${foreignRuntimeToken}`, "x-matrix-runtime-id": foreignRuntimeId, "content-type": "application/json" };
    const resolve = await app.request("/internal/organizations/access/resolve", {
      method: "POST", headers: foreignHeaders,
      body: JSON.stringify({ protocolVersion: 2, actors: [{ organizationId: org, actorId: member }, { organizationId: org, actorId: admin }] }),
    });
    expect(resolve.status).toBe(200);
    const assertions = await resolve.json() as Array<{ type: string; actorId: string; member: boolean; membershipEpoch: string; aiSubmission?: string }>;
    // The outsider's home learns nothing: every actor reads as a non-member with no epoch or policy detail.
    expect(assertions.map((a) => [a.type, a.actorId, a.member, a.membershipEpoch, a.aiSubmission]))
      .toEqual([["membership_assertion", member, false, "0", "owner_only"], ["membership_assertion", admin, false, "0", "owner_only"]]);
    // The member's own home still resolves the same actors truthfully.
    const own = await app.request("/internal/organizations/access/resolve", {
      method: "POST", headers: { authorization: `Bearer ${runtimeToken}`, "x-matrix-runtime-id": runtimeId, "content-type": "application/json" },
      body: JSON.stringify({ protocolVersion: 2, actors: [{ organizationId: org, actorId: member }] }),
    });
    expect((await own.json() as Array<{ member: boolean }>)[0]!.member).toBe(true);
  });

  it("never tracks or evaluates a foreign organization before the owner-membership gate", async () => {
    await projection.reconcile(org);
    const foreignOrganization = "org_2gwforeign000000000000000";
    const touch = vi.spyOn(projection, "touch");
    const assert = vi.spyOn(projection, "assert");
    const trackedBefore = projection.describe().tracked;
    const resolve = await app.request("/internal/organizations/access/resolve", {
      method: "POST",
      headers: { authorization: `Bearer ${foreignRuntimeToken}`, "x-matrix-runtime-id": foreignRuntimeId, "content-type": "application/json" },
      body: JSON.stringify({ protocolVersion: 2, actors: [
        { organizationId: org, actorId: member },
        { organizationId: foreignOrganization, actorId: admin },
      ] }),
    });
    expect(resolve.status).toBe(200);
    expect((await resolve.json() as Array<{ member: boolean }>).map((a) => a.member)).toEqual([false, false]);
    // Neither organization was scheduled for reconciliation or evaluated through the projection.
    expect(touch).not.toHaveBeenCalled();
    expect(assert).not.toHaveBeenCalled();
    expect(projection.describe().tracked).toBe(trackedBefore);
    touch.mockRestore();
    assert.mockRestore();
  });
});
