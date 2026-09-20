import { createHmac } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapPlatformOrganizationDatabase, type OrganizationPlatformDatabase } from "../../packages/platform/src/organizations/database.js";
import { PlatformOrganizationRepository } from "../../packages/platform/src/organizations/repository.js";
import { createOrganizationMembershipProjection } from "../../packages/platform/src/organizations/projection.js";
import { createCollaborationControlAuthority } from "../../packages/platform/src/collaboration/control-authority.js";
import { createPlatformOrganizationRoutes } from "../../packages/platform/src/organizations/routes.js";
import { createTestPlatformDb, destroyTestPlatformDb, type TestPlatformDb } from "./platform-db-test-helper.js";

const org = "org_2rout00000000000000000001";
const member = "user_member0000000000000000";
const admin = "user_admin00000000000000000";
const outsider = "user_outsider00000000000000";
const runtimeId = "vps:10000000-0000-4000-8000-000000000001";
const runtimeToken = "r".repeat(40);
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
    members = [admin, member];
    projection = createOrganizationMembershipProjection({
      repository, now: () => clock,
      upstream: { listMembers: async () => ({
        organization: { organizationId: org, name: "Route org", slug: "route-org", aiSubmission: "members", sourceUpdatedAt: new Date(1_000) },
        members: members.map((actorId) => ({ membershipId: `orgmem_${actorId}`, actorId, role: actorId === admin ? "org:admin" : "org:member", sourceUpdatedAt: new Date(1_000) })),
      }) },
    });
    authority = createCollaborationControlAuthority({ repository, now: () => clock, affectedRuntimes: async () => [runtimeId], projection });
    actor = member;
    app = createPlatformOrganizationRoutes({
      repository, projection, controlAuthority: authority, webhookSigningSecret: signingSecret, now: () => clock,
      resolveActor: async () => actor,
      authenticateRuntime: async (input) => input.runtimeId === runtimeId && input.bearerToken === runtimeToken ? { runtimeId, ownerId: admin } : null,
    });
  });

  afterEach(async () => {
    await authority.shutdown();
    await projection.shutdown();
    await destroyTestPlatformDb(fixture.db);
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
    const assertions = await resolve.json() as Array<{ type: string; actorId: string; member: boolean; expiresAt: string; requestStartedAt: string }>;
    expect(assertions.map((a) => [a.type, a.actorId, a.member])).toEqual([["membership_assertion", member, true], ["membership_assertion", outsider, false]]);
    expect(Date.parse(assertions[0]!.expiresAt) - Date.parse(assertions[0]!.requestStartedAt)).toBe(20_000);
    expect((await app.request("/internal/organizations/access/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    expect((await app.request("/internal/organizations/access/resolve", { method: "POST", headers: authHeaders, body: JSON.stringify({ protocolVersion: 1, actors: [] }) })).status).toBe(422);
    const ack = await app.request("/internal/collaboration/control/ack", { method: "POST", headers: authHeaders, body: JSON.stringify({ protocolVersion: 2, runtimeId, authorityGeneration: 1, fenceAt: clock.toISOString() }) });
    expect(ack.status).toBe(204);
    const foreign = await app.request("/internal/collaboration/control/ack", { method: "POST", headers: authHeaders, body: JSON.stringify({ protocolVersion: 2, runtimeId: "vps:10000000-0000-4000-8000-000000000009", authorityGeneration: 1, fenceAt: clock.toISOString() }) });
    expect(foreign.status).toBe(403);
  });
});
