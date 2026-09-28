import { describe, expect, it, vi } from "vitest";
import { ClerkOrganizationAdminClient } from "../../packages/platform/src/organizations/clerk-admin-client.js";

const organizationId = "org_invites000000000000000";
const actorId = "user_admin000000000000000";
const invitationId = "orginv_00000000000000000000";
const requestId = "a77b8e1c-6112-4250-93d8-650d6fca8174";
const invitation = {
  id: invitationId, organization_id: organizationId, email_address: "member@example.com",
  role: "org:member", status: "pending", expires_at: 1_800_000_000_000,
};

describe("Clerk organization invitation client", () => {
  it("sends bounded create, pending list and revoke requests with the server-chosen redirect", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.redirect).toBe("error");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return Response.json(_url.includes("?limit=") ? { data: [invitation], total_count: 1 } : invitation);
    });
    const clerk = new ClerkOrganizationAdminClient({ secretKey: "test-secret", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await clerk.createInvitation({ organizationId, actorId, emailAddress: invitation.email_address,
      role: "org:member", redirectUrl: "https://preview.example.com/shared/organization-invitation", requestId })).toEqual({ invitationId, expiresAt: new Date(invitation.expires_at) });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1].body))).toEqual({
      email_address: invitation.email_address, inviter_user_id: actorId, role: "org:member",
      redirect_url: "https://preview.example.com/shared/organization-invitation",
      private_metadata: { matrixInviteRequestId: requestId },
    });
    expect((await clerk.listInvitations({ organizationId, limit: 50, offset: 0 })).invitations).toHaveLength(1);
    expect(String(fetchImpl.mock.calls[1]![0])).toContain("status=pending");
    await clerk.revokeInvitation({ organizationId, invitationId, actorId });
    expect(String(fetchImpl.mock.calls[2]![0]).endsWith(`/${invitationId}/revoke`)).toBe(true);
    expect(JSON.parse(String(fetchImpl.mock.calls[2]![1].body))).toEqual({ requesting_user_id: actorId });
  });

  it("rejects a mismatched upstream invitation identity", async () => {
    const clerk = new ClerkOrganizationAdminClient({ secretKey: "test-secret", fetchImpl: vi.fn(async () => Response.json({ ...invitation, organization_id: "org_other" })) as typeof fetch });
    await expect(clerk.createInvitation({ organizationId, actorId, emailAddress: invitation.email_address,
      role: "org:member", redirectUrl: "https://preview.example.com/shared/organization-invitation", requestId })).rejects.toThrow();
  });
});
