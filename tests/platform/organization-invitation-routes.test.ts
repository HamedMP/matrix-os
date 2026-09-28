import { describe, expect, it, vi } from "vitest";
import { createOrganizationAdminRoutes } from "../../packages/platform/src/organizations/admin-routes.js";
import type { ClerkOrganizationAdmin } from "../../packages/platform/src/organizations/clerk-admin-client.js";

const organizationId = "org_invites000000000000000";
const actorId = "user_admin000000000000000";
const invitationId = "orginv_00000000000000000000";
const url = `/api/organizations/${organizationId}/invitations`;
const body = { emailAddress: "member@example.com", role: "org:member", clientRequestId: "a77b8e1c-6112-4250-93d8-650d6fca8174" };

function fixture() {
  let actor: string | null = actorId;
  let admin = true;
  let verified = true;
  const record = { organizationId, addressDigest: "digest", invitationId: null as string | null, inviterId: actorId, expiresAt: new Date("2026-10-01"), role: "org:member" as const };
  const repository = {
    invitationDigest: vi.fn(() => "digest"),
    beginInvitation: vi.fn(async () => ({ record, claimed: true })),
    completeInvitation: vi.fn(async () => ({ ...record, invitationId })),
    getInvitation: vi.fn(async () => ({ ...record, invitationId })),
    deleteInvitation: vi.fn(async () => undefined),
  };
  const clerk = {
    createInvitation: vi.fn(async () => ({ invitationId, expiresAt: new Date("2026-10-01") })),
    listInvitations: vi.fn(async () => ({ invitations: [{ invitationId, emailAddress: body.emailAddress, role: body.role, status: "pending" }], totalCount: 1 })),
    revokeInvitation: vi.fn(async () => undefined),
  };
  const projection = { reconcileFresh: vi.fn(async () => ({ verified })) };
  const memberships = { getMembership: vi.fn(async () => ({ state: "active", role: admin ? "org:admin" : "org:member" })) };
  const app = createOrganizationAdminRoutes({
    repository: repository as never, clerk: clerk as unknown as ClerkOrganizationAdmin,
    projection: projection as never, membershipRepository: memberships as never,
    platformSecret: "test-platform-secret", appOrigin: "https://preview.example.com",
    resolveActor: async () => actor,
  });
  const post = (value: unknown) => app.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
  return { app, post, repository, clerk, projection, memberships, setActor: (value: string | null) => { actor = value; }, setAdmin: (value: boolean) => { admin = value; }, setVerified: (value: boolean) => { verified = value; } };
}

describe("organization invitation routes", () => {
  it("requires fresh admin evidence for create, list and revoke", async () => {
    const f = fixture();
    f.setActor(null);
    expect((await f.post(body)).status).toBe(401);
    f.setActor(actorId);
    f.setVerified(false);
    expect((await f.post(body)).status).toBe(503);
    f.setVerified(true);
    f.setAdmin(false);
    expect((await f.post(body)).status).toBe(403);
    expect((await f.app.request(url)).status).toBe(403);
    expect((await f.app.request(`${url}/${invitationId}`, { method: "DELETE" })).status).toBe(403);
    expect(f.clerk.createInvitation).not.toHaveBeenCalled();
    expect(f.projection.reconcileFresh).toHaveBeenCalledWith(organizationId);
  });

  it("validates path, body, query and bounded delete before calling Clerk", async () => {
    const f = fixture();
    expect((await f.post({ ...body, extra: true })).status).toBe(422);
    expect((await f.post({ ...body, emailAddress: "nope" })).status).toBe(422);
    expect((await f.post({ ...body, emailAddress: "x".repeat(20_000) })).status).toBe(413);
    expect((await f.app.request(`${url}?limit=999`)).status).toBe(422);
    expect((await f.app.request(`${url}/bad id`, { method: "DELETE" })).status).toBe(422);
    expect((await f.app.request(`${url}/${invitationId}`, { method: "DELETE", body: "x".repeat(20_000) })).status).toBe(413);
    expect(f.clerk.createInvitation).not.toHaveBeenCalled();
  });

  it("uses a uniform create response, lists for admins, and revokes only after Clerk confirmation", async () => {
    const f = fixture();
    const result = await f.post(body);
    expect(result.status).toBe(201);
    expect(await result.json()).toEqual({ invitationId, status: "pending" });
    expect(f.clerk.createInvitation).toHaveBeenCalledWith(expect.objectContaining({
      organizationId, actorId, role: "org:member", redirectUrl: "https://preview.example.com/shared/organization-invitation",
    }));
    expect((await f.app.request(url)).status).toBe(200);
    expect(f.clerk.listInvitations).toHaveBeenCalledWith({ organizationId, limit: 50, offset: 0 });
    expect((await f.app.request(`${url}/${invitationId}`, { method: "DELETE" })).status).toBe(204);
    expect(f.repository.deleteInvitation).toHaveBeenCalledWith(organizationId, invitationId);
  });

  it("adopts a pending Clerk invitation after a lost completion response", async () => {
    const f = fixture();
    f.repository.beginInvitation.mockResolvedValueOnce({ record: { ...await f.repository.getInvitation(), invitationId: null }, claimed: true, reclaim: true } as never);
    const response = await f.post(body);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ invitationId, status: "pending" });
    expect(f.clerk.listInvitations).toHaveBeenCalledWith({ organizationId, limit: 50, offset: 0 });
    expect(f.clerk.createInvitation).not.toHaveBeenCalled();
  });

  it("returns a generic 429 with Retry-After and a generic 503 on upstream failure", async () => {
    const f = fixture();
    f.repository.beginInvitation.mockRejectedValueOnce(Object.assign(new Error("limit"), { retryAfterSeconds: 60, name: "OrganizationInvitationLimitError" }));
    const limited = await f.post(body);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
    f.clerk.createInvitation.mockRejectedValueOnce(new Error("private Clerk detail"));
    const failed = await f.post(body);
    expect(failed.status).toBe(503);
    expect(JSON.stringify(await failed.json())).not.toContain("private Clerk detail");
  });
});
