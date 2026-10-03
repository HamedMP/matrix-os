import { createHmac } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapPlatformOrganizationDatabase, type OrganizationPlatformDatabase } from "../../packages/platform/src/organizations/database.js";
import { PlatformOrganizationRepository } from "../../packages/platform/src/organizations/repository.js";
import { createOrganizationMembershipProjection } from "../../packages/platform/src/organizations/projection.js";
import { createCollaborationControlAuthority } from "../../packages/platform/src/collaboration/control-authority.js";
import { createPlatformOrganizationRoutes } from "../../packages/platform/src/organizations/routes.js";
import type { OrganizationManagementUpstream } from "../../packages/platform/src/organizations/management.js";
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

function clerkMembershipEvent(type: string, actorId: string, role: string, updatedAt: number, aiSubmission?: string,
  publicUserData: Record<string, unknown> = { identifier: "x@example.com" }, occurredAt?: number) {
  return JSON.stringify({
    type,
    ...(occurredAt === undefined ? {} : { timestamp: occurredAt }),
    data: {
      id: `orgmem_${actorId}`,
      role,
      created_at: updatedAt,
      updated_at: updatedAt,
      organization: { id: org, name: "Route org", slug: "route-org", public_metadata: aiSubmission ? { collaboration: { aiSubmission } } : {}, created_at: 1, updated_at: updatedAt },
      public_user_data: { user_id: actorId, ...publicUserData },
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
  let managementUpstream: OrganizationManagementUpstream;

  beforeEach(async () => {
    fixture = await createTestPlatformDb();
    const db = fixture.db.kysely as unknown as Kysely<OrganizationPlatformDatabase>;
    await bootstrapPlatformOrganizationDatabase(db);
    clock = new Date("2026-09-20T12:00:00.000Z");
    repository = new PlatformOrganizationRepository(db, { now: () => clock });
    members = [admin, member];
    projection = createOrganizationMembershipProjection({
      repository, now: () => clock,
      upstream: { listOrganizationsForActor: async (actorId) => members.includes(actorId) ? [org] : [], listMembers: async () => ({
        organization: { organizationId: org, name: "Route org", slug: "route-org", aiSubmission: "members", sourceUpdatedAt: new Date(1_000) },
        members: members.map((actorId) => ({ membershipId: `orgmem_${actorId}`, actorId, role: actorId === admin ? "org:admin" : "org:member", sourceUpdatedAt: new Date(1_000) })),
      }) },
    });
    authority = createCollaborationControlAuthority({ repository, now: () => clock, affectedRuntimes: async () => [logicalRuntimeId], projection });
    actor = member;
    managementUpstream = {
      listPendingInvitations: vi.fn(async () => [{
        invitationId: "orginv_pending",
        emailAddress: "pending@example.com",
        role: "org:member",
        createdAt: new Date("2026-09-18T12:00:00.000Z"),
        expiresAt: new Date("2026-10-18T12:00:00.000Z"),
      }]),
      renameOrganization: vi.fn(async () => undefined),
      updateOrganizationLogo: vi.fn(async () => undefined),
      createInvitations: vi.fn(async () => undefined),
      resendInvitation: vi.fn(async () => undefined),
      revokeInvitation: vi.fn(async () => undefined),
      updateMemberRole: vi.fn(async () => undefined),
      removeMember: vi.fn(async () => undefined),
      deleteOrganization: vi.fn(async () => undefined),
    };
    app = createPlatformOrganizationRoutes({
      repository, projection, controlAuthority: authority, webhookSigningSecret: signingSecret, now: () => clock,
      managementDirectory: {
        resolveMemberProfiles: async (actorIds) => new Map(actorIds.map((actorId) => [actorId, {
          actorId,
          displayName: actorId === admin ? "Alex Admin" : "Morgan Member",
          emailAddress: actorId === admin ? "alex@example.com" : "morgan@example.com",
        }])),
      },
      managementUpstream,
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

  it("lists only organizations where the actor is a fresh current member", async () => {
    await projection.reconcile(org);
    const response = await app.request("/api/organizations");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ complete: true, organizations: [{ organizationId: org, name: "Route org", slug: "route-org", role: "org:member", memberCount: 2, aiSubmission: "members", membershipEpoch: expect.any(Number) }] });
    actor = outsider;
    expect(await (await app.request("/api/organizations")).json()).toEqual({ complete: true, organizations: [] });
    actor = null;
    expect((await app.request("/api/organizations")).status).toBe(401);
  });

  it("lists refreshed role, policy, name and epoch after stale membership verification", async () => {
    await projection.reconcile(org);
    clock = new Date(clock.getTime() + 60_001);
    const check = vi.spyOn(projection, "isCurrentMember").mockImplementation(async () => {
      await repository.reconcileOrganization({
        organization: { organizationId: org, name: "Updated org", slug: "updated-org", aiSubmission: "owner_only", sourceUpdatedAt: new Date(2_000) },
        members: [{ membershipId: `orgmem_${member}`, actorId: member, role: "org:admin", sourceUpdatedAt: new Date(2_000) }],
      }, clock);
      return true;
    });
    try {
      const response = await app.request("/api/organizations");
      const current = await repository.getOrganization(org);
      expect(await response.json()).toEqual({ complete: true, organizations: [{ organizationId: org, name: "Updated org", slug: "updated-org", role: "org:admin", memberCount: 1, aiSubmission: "owner_only", membershipEpoch: current!.membershipEpoch }] });
    } finally { check.mockRestore(); }
  });

  it("checks organization listings concurrently instead of accumulating upstream delays", async () => {
    const ids = [org, "org_2rout00000000000000000002", "org_2rout00000000000000000003"];
    for (const organizationId of ids) await repository.reconcileOrganization({
      organization: { organizationId, name: organizationId, slug: organizationId, aiSubmission: "members", sourceUpdatedAt: new Date(1_000) },
      members: [{ membershipId: `orgmem_${organizationId}`, actorId: member, role: "org:member", sourceUpdatedAt: new Date(1_000) }],
    }, clock);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const check = vi.spyOn(projection, "isCurrentMember").mockImplementation(async () => { await gate; return true; });
    const request = app.request("/api/organizations");
    try { await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(3), { timeout: 500 }); }
    finally { release(); await request; check.mockRestore(); }
  });

  it("returns all 100 supported idle organizations without exhausting its own refresh pool", async () => {
    const entries = Array.from({ length: 100 }, (_, index) => ({
      organization: { organizationId: `org_capacity${String(index).padStart(16, "0")}`, name: "Org", slug: "org", aiSubmission: "members" as const, lifecycle: "active" as const, membershipEpoch: 1, sourceUpdatedAt: new Date(1_000), verifiedAt: new Date(clock.getTime() - 60_001) },
      membership: { organizationId: `org_capacity${String(index).padStart(16, "0")}`, membershipId: `orgmem_${index}`, actorId: member, role: "org:member", state: "active" as const, membershipEpoch: 1, sourceUpdatedAt: new Date(1_000) },
    }));
    const refreshed = new Set<string>(); // Request fixture contains exactly 100 IDs.
    vi.spyOn(repository, "listOrganizationsForActor").mockImplementation(async () => entries);
    vi.spyOn(repository, "getOrganization").mockImplementation(async (id) => {
      const entry = entries.find((item) => item.organization.organizationId === id)!;
      return { ...entry.organization, verifiedAt: refreshed.has(id) ? clock : entry.organization.verifiedAt };
    });
    vi.spyOn(repository, "getMembership").mockImplementation(async ({ organizationId }) => entries.find((entry) => entry.organization.organizationId === organizationId)!.membership);
    vi.spyOn(repository, "reconcileOrganization").mockImplementation(async (snapshot) => {
      refreshed.add(snapshot.organization.organizationId);
      return { endedMemberships: [], membershipEpoch: 1 };
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const upstream = vi.fn(async (id: string) => {
      await gate;
      return { organization: { organizationId: id, name: "Org", slug: "org", aiSubmission: "members" as const, sourceUpdatedAt: new Date(1_000) }, members: [] };
    });
    const limited = createOrganizationMembershipProjection({ repository, upstream: { listMembers: upstream }, now: () => clock });
    const listing = createPlatformOrganizationRoutes({ repository, projection: limited, controlAuthority: authority, resolveActor: async () => member, authenticateRuntime: async () => null, now: () => clock });
    const request = listing.request("/api/organizations");
    try {
      await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(64));
      release();
      const response = await request;
      expect(response.status).toBe(200);
      expect((await response.json() as { organizations: unknown[] }).organizations).toHaveLength(100);
    } finally { release(); await request; await limited.shutdown(); vi.restoreAllMocks(); }
  });

  it("serves paginated members only to current members and validates the page request", async () => {
    await projection.reconcile(org);
    const first = await app.request(`/api/organizations/${org}/members?limit=1`);
    expect(first.status).toBe(200);
    const page = await first.json() as { members: Array<{ actorId: string; role: string; displayName: string; emailAddress?: string }>; nextCursor?: string };
    expect(page.members).toHaveLength(1);
    expect(page.members[0]).toMatchObject({ displayName: "Alex Admin", emailAddress: "alex@example.com", role: "org:admin" });
    expect(page.nextCursor).toBeTypeOf("string");
    const second = await (await app.request(`/api/organizations/${org}/members?limit=1&cursor=${encodeURIComponent(page.nextCursor!)}`)).json() as { members: Array<{ actorId: string }>; nextCursor?: string };
    expect(second.members).toHaveLength(1);
    expect(new Set([...page.members, ...second.members].map((m) => m.actorId))).toEqual(new Set([admin, member]));
    expect((await app.request(`/api/organizations/${org}/members?limit=1000`)).status).toBe(422);
    expect((await app.request(`/api/organizations/not%20an%20org/members`)).status).toBe(422);
    actor = outsider;
    expect((await app.request(`/api/organizations/${org}/members`)).status).toBe(404);
  });

  it("lists pending invitations only for current admins", async () => {
    await projection.reconcile(org);
    expect((await app.request(`/api/organizations/${org}/invitations`)).status).toBe(403);
    actor = admin;
    const response = await app.request(`/api/organizations/${org}/invitations`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ invitations: [{
      invitationId: "orginv_pending",
      emailAddress: "pending@example.com",
      role: "org:member",
      createdAt: "2026-09-18T12:00:00.000Z",
      expiresAt: "2026-10-18T12:00:00.000Z",
    }] });
    actor = outsider;
    expect((await app.request(`/api/organizations/${org}/invitations`)).status).toBe(404);
  });

  it("allows admins to rename, invite, update roles, and manage invitations", async () => {
    await projection.reconcile(org);
    actor = admin;
    const json = { "content-type": "application/json" };
    expect((await app.request(`/api/organizations/${org}`, { method: "PATCH", headers: json, body: JSON.stringify({ name: "New name" }) })).status).toBe(200);
    expect((await app.request(`/api/organizations/${org}/invitations`, { method: "POST", headers: json, body: JSON.stringify({ emailAddresses: ["new@example.com"], role: "org:member" }) })).status).toBe(200);
    expect((await app.request(`/api/organizations/${org}/members/${member}`, { method: "PATCH", headers: json, body: JSON.stringify({ role: "org:admin" }) })).status).toBe(200);
    expect((await app.request(`/api/organizations/${org}/invitations/orginv_pending/resend`, { method: "POST" })).status).toBe(200);
    expect((await app.request(`/api/organizations/${org}/invitations/orginv_pending`, { method: "DELETE" })).status).toBe(200);
    expect(managementUpstream.renameOrganization).toHaveBeenCalledWith(org, "New name");
    expect(managementUpstream.createInvitations).toHaveBeenCalledWith(org, ["new@example.com"], "org:member");
    expect(managementUpstream.updateMemberRole).toHaveBeenCalledWith(org, member, "org:admin");
    expect(managementUpstream.resendInvitation).toHaveBeenCalledWith(org, "orginv_pending");
    expect(managementUpstream.revokeInvitation).toHaveBeenCalledWith(org, "orginv_pending");
  });

  it("supports logo upload, member removal, leaving, and organization deletion", async () => {
    await projection.reconcile(org);
    actor = admin;
    const logo = new FormData();
    logo.set("file", new Blob(["logo"], { type: "image/png" }), "logo.png");
    expect((await app.request(`/api/organizations/${org}/logo`, { method: "PATCH", body: logo })).status).toBe(200);
    expect((await app.request(`/api/organizations/${org}/members/${member}`, { method: "DELETE" })).status).toBe(200);
    expect((await app.request(`/api/organizations/${org}`, { method: "DELETE" })).status).toBe(200);
    expect(managementUpstream.updateOrganizationLogo).toHaveBeenCalledWith(org, expect.any(Blob));
    expect(managementUpstream.removeMember).toHaveBeenCalledWith(org, member);
    expect(managementUpstream.deleteOrganization).toHaveBeenCalledWith(org);

    actor = member;
    expect((await app.request(`/api/organizations/${org}/members/${member}`, { method: "DELETE" })).status).toBe(200);
    expect(managementUpstream.removeMember).toHaveBeenCalledWith(org, member);
  });

  it("enforces admin permissions, validates bodies, and protects the final admin", async () => {
    await projection.reconcile(org);
    const json = { "content-type": "application/json" };
    expect((await app.request(`/api/organizations/${org}`, { method: "PATCH", headers: json, body: JSON.stringify({ name: "Nope" }) })).status).toBe(403);
    actor = admin;
    expect((await app.request(`/api/organizations/${org}/invitations`, { method: "POST", headers: json, body: JSON.stringify({ emailAddresses: ["bad"], role: "org:member" }) })).status).toBe(422);

    members = [admin];
    await projection.reconcile(org);
    expect((await app.request(`/api/organizations/${org}/members/${admin}`, { method: "PATCH", headers: json, body: JSON.stringify({ role: "org:member" }) })).status).toBe(409);
    expect((await app.request(`/api/organizations/${org}/members/${admin}`, { method: "DELETE" })).status).toBe(409);
    expect(managementUpstream.updateMemberRole).not.toHaveBeenCalledWith(org, admin, "org:member");
  });

  it("prefers persisted Clerk member names and emails over directory fallbacks", async () => {
    await projection.reconcile(org);
    const named = clerkMembershipEvent("organizationMembership.updated", member, "org:member", 5_000, "members", {
      first_name: "Ada", last_name: " Lovelace ", identifier: "ada@example.com", image_url: "https://img.clerk.com/ada.png",
    });
    expect((await app.request("/webhooks/clerk/organizations", { method: "POST", headers: signed("msg_profile_1", named, clock), body: named })).status).toBe(200);
    const epoch = (await repository.getMembership({ organizationId: org, actorId: member }))!.membershipEpoch;
    // An email-less identifier (a phone or username) is never shown as an email, and only https images are kept.
    const unnamed = clerkMembershipEvent("organizationMembership.updated", admin, "org:admin", 5_000, "members", {
      first_name: null, last_name: null, identifier: "+15550100", image_url: "javascript:alert(1)",
    });
    expect((await app.request("/webhooks/clerk/organizations", { method: "POST", headers: signed("msg_profile_2", unnamed, clock), body: unnamed })).status).toBe(200);

    const page = await (await app.request(`/api/organizations/${org}/members?include=profile`)).json() as { members: Array<Record<string, unknown>> };
    expect(page.members).toEqual([
      { actorId: admin, displayName: "Alex Admin", emailAddress: "alex@example.com", role: "org:admin", joinedAt: new Date(5_000).toISOString() },
      { actorId: member, role: "org:member", joinedAt: new Date(5_000).toISOString(),
        displayName: "Ada Lovelace", emailAddress: "ada@example.com" },
    ]);
    // The current management contract always includes a safe display label.
    const plain = await (await app.request(`/api/organizations/${org}/members`)).json() as { members: Array<Record<string, unknown>> };
    expect(plain.members).toEqual(page.members);
    expect((await app.request(`/api/organizations/${org}/members?include=everything`)).status).toBe(422);

    // A later name change with the same membership timestamp updates the name, never the membership epoch.
    const renamed = clerkMembershipEvent("organizationMembership.updated", member, "org:member", 5_000, "members", {
      first_name: "Ada", last_name: "King", identifier: "ada@example.com",
    });
    expect((await app.request("/webhooks/clerk/organizations", { method: "POST", headers: signed("msg_profile_3", renamed, clock), body: renamed })).status).toBe(200);
    const after = await repository.getMembership({ organizationId: org, actorId: member });
    expect(after).toMatchObject({ displayName: "Ada King", email: "ada@example.com", membershipEpoch: epoch });
    // An older event never overwrites the newer profile.
    const stale = clerkMembershipEvent("organizationMembership.updated", member, "org:member", 4_000, "members", {
      first_name: "Old", last_name: "Name", identifier: "old@example.com",
    });
    await app.request("/webhooks/clerk/organizations", { method: "POST", headers: signed("msg_profile_4", stale, clock), body: stale });
    expect(await repository.getMembership({ organizationId: org, actorId: member })).toMatchObject({ displayName: "Ada King" });
  });

  it("keeps the newest member profile whichever of the webhook and the reconcile arrives last", async () => {
    await projection.reconcile(org);
    // Clerk renamed the member at t=9s; a reconcile read the new name at t=12s (the clock).
    const fresh = clerkMembershipEvent("organizationMembership.updated", member, "org:member", 5_000, "members", {
      first_name: "Ada", last_name: "King", identifier: "ada@example.com",
    }, clock.getTime());
    expect((await app.request("/webhooks/clerk/organizations", { method: "POST", headers: signed("msg_order_1", fresh, clock), body: fresh })).status).toBe(200);
    // A delayed webhook about the same membership, emitted before the rename, arrives afterwards.
    const delayed = clerkMembershipEvent("organizationMembership.updated", member, "org:member", 5_000, "members", {
      first_name: "Ada", last_name: "Lovelace", identifier: "ada@example.com",
    }, clock.getTime() - 60_000);
    expect((await app.request("/webhooks/clerk/organizations", { method: "POST", headers: signed("msg_order_2", delayed, clock), body: delayed })).status).toBe(200);
    expect(await repository.getMembership({ organizationId: org, actorId: member })).toMatchObject({ displayName: "Ada King" });
    // A payload that does not report the name or email leaves the stored ones alone.
    const sparse = clerkMembershipEvent("organizationMembership.updated", member, "org:member", 5_000, "members", {}, clock.getTime() + 1_000);
    expect((await app.request("/webhooks/clerk/organizations", { method: "POST", headers: signed("msg_order_3", sparse, clock), body: sparse })).status).toBe(200);
    expect(await repository.getMembership({ organizationId: org, actorId: member })).toMatchObject({ displayName: "Ada King", email: "ada@example.com" });
    // Each field keeps its own observation time: an email-only report does not make a name
    // change observed before it (but after the stored name) look stale.
    const emailOnly = clerkMembershipEvent("organizationMembership.updated", member, "org:member", 5_000, "members", {
      identifier: "ada.king@example.com",
    }, clock.getTime() + 20_000);
    expect((await app.request("/webhooks/clerk/organizations", { method: "POST", headers: signed("msg_order_4", emailOnly, clock), body: emailOnly })).status).toBe(200);
    const renamedBefore = clerkMembershipEvent("organizationMembership.updated", member, "org:member", 5_000, "members", {
      first_name: "Ada", last_name: "Byron",
    }, clock.getTime() + 10_000);
    expect((await app.request("/webhooks/clerk/organizations", { method: "POST", headers: signed("msg_order_5", renamedBefore, clock), body: renamedBefore })).status).toBe(200);
    expect(await repository.getMembership({ organizationId: org, actorId: member })).toMatchObject({ displayName: "Ada Byron", email: "ada.king@example.com" });
    const staleEmail = clerkMembershipEvent("organizationMembership.updated", member, "org:member", 5_000, "members", {
      identifier: "ada.old@example.com",
    }, clock.getTime() + 15_000);
    expect((await app.request("/webhooks/clerk/organizations", { method: "POST", headers: signed("msg_order_6", staleEmail, clock), body: staleEmail })).status).toBe(200);
    expect(await repository.getMembership({ organizationId: org, actorId: member })).toMatchObject({ email: "ada.king@example.com" });
  });

  it("drops an image whose normalized address is too long instead of failing the membership change", async () => {
    await projection.reconcile(org);
    // `URL` percent-encodes spaces, so this fits the input bound but not the stored one.
    const image = `https://img.clerk.com/${" ".repeat(700)}avatar.png`;
    const removed = clerkMembershipEvent("organizationMembership.deleted", member, "org:member", 5_000, "members", {
      first_name: "Ada", image_url: image,
    });
    const response = await app.request("/webhooks/clerk/organizations", { method: "POST", headers: signed("msg_long_image", removed, clock), body: removed });
    expect(response.status).toBe(200);
    expect(await repository.getMembership({ organizationId: org, actorId: member })).toMatchObject({ state: "removed", imageUrl: null });
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
