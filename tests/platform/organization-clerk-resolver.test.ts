import { describe, expect, it, vi } from "vitest";
import { ClerkOrganizationUpstreamClient } from "../../packages/platform/src/organizations/clerk-resolver.js";

const org = "org_2clerk0000000000000000001";

function fakeClerk(memberCount: number, totalCount: number | null = memberCount) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    if (url.pathname.endsWith(`/organizations/${org}`)) {
      return new Response(JSON.stringify({ id: org, name: "Big org", slug: "big-org", public_metadata: {}, updated_at: 1_000 }), { status: 200 });
    }
    const limit = Number(url.searchParams.get("limit"));
    const offset = Number(url.searchParams.get("offset"));
    const data = Array.from({ length: Math.max(0, Math.min(limit, memberCount - offset)) }, (_, i) => ({
      id: `orgmem_${offset + i}`, role: "org:member", updated_at: 1_000,
      public_user_data: { user_id: `user_${String(offset + i).padStart(24, "0")}`, first_name: "Member", last_name: String(offset + i),
        identifier: `member${offset + i}@example.com`, image_url: "https://img.clerk.com/member.png" },
    }));
    return new Response(JSON.stringify({ data, ...(totalCount === null ? {} : { total_count: totalCount }) }), { status: 200 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

describe("Clerk organization upstream pagination boundary", () => {
  it("discovers every organization for an actor before an empty listing is considered authoritative", async () => {
    const actorId = "user_member0000000000000000";
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe(`/v1/users/${actorId}/organization_memberships`);
      expect(url.searchParams.get("limit")).toBe("100");
      return new Response(JSON.stringify({
        data: [
          { id: "orgmem_a", organization: { id: org } },
          { id: "orgmem_b", organization: { id: "org_2clerk0000000000000000002" } },
        ],
        total_count: 2,
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new ClerkOrganizationUpstreamClient({ secretKey: "sk_test_x", fetchImpl });

    await expect(client.listOrganizationsForActor(actorId)).resolves.toEqual([
      org,
      "org_2clerk0000000000000000002",
    ]);
  });

  it("rejects an actor organization listing that exceeds the platform cap", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [], total_count: 101 }), { status: 200 })) as unknown as typeof fetch;
    const client = new ClerkOrganizationUpstreamClient({ secretKey: "sk_test_x", fetchImpl });

    await expect(client.listOrganizationsForActor("user_member0000000000000000"))
      .rejects.toThrow(/organization count/);
  });

  it("accepts an organization with exactly 2,000 members when total_count confirms it", async () => {
    const clerk = fakeClerk(2_000);
    const client = new ClerkOrganizationUpstreamClient({ secretKey: "sk_test_x", fetchImpl: clerk.fetchImpl });
    const snapshot = await client.listMembers(org);
    expect(snapshot.members).toHaveLength(2_000);
    expect(clerk.calls.filter((c) => c.includes("/memberships"))).toHaveLength(20);
  });

  it("reads each member's name, email and image from the reconcile pages it already fetches", async () => {
    const clerk = fakeClerk(2);
    const client = new ClerkOrganizationUpstreamClient({ secretKey: "sk_test_x", fetchImpl: clerk.fetchImpl });
    expect((await client.listMembers(org)).members.map((entry) => entry.profile)).toEqual([
      { displayName: "Member 0", email: "member0@example.com", imageUrl: "https://img.clerk.com/member.png", observedAt: expect.any(Date) },
      { displayName: "Member 1", email: "member1@example.com", imageUrl: "https://img.clerk.com/member.png", observedAt: expect.any(Date) },
    ]);
  });

  it("accepts exactly 2,000 members without total_count by probing one empty page", async () => {
    const clerk = fakeClerk(2_000, null);
    const client = new ClerkOrganizationUpstreamClient({ secretKey: "sk_test_x", fetchImpl: clerk.fetchImpl });
    expect((await client.listMembers(org)).members).toHaveLength(2_000);
    expect(clerk.calls.filter((c) => c.includes("/memberships"))).toHaveLength(21);
  });

  it("rejects 2,001 members whether or not total_count is reported", async () => {
    await expect(new ClerkOrganizationUpstreamClient({ secretKey: "sk_test_x", fetchImpl: fakeClerk(2_001).fetchImpl }).listMembers(org))
      .rejects.toThrow(/member count/);
    await expect(new ClerkOrganizationUpstreamClient({ secretKey: "sk_test_x", fetchImpl: fakeClerk(2_001, null).fetchImpl }).listMembers(org))
      .rejects.toThrow(/member count/);
  });

  it("reads the bounded pending invitation directory", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe(`/v1/organizations/${org}/invitations/pending`);
      expect(url.searchParams.get("limit")).toBe("100");
      expect(url.searchParams.get("offset")).toBe("0");
      return Response.json({ data: [{
        id: "orginv_pending",
        email_address: "pending@example.com",
        role: "org:member",
        created_at: 1_760_000_000_000,
        expires_at: 1_762_592_000_000,
      }] });
    });
    const client = new ClerkOrganizationUpstreamClient({ secretKey: "sk_test_x", fetchImpl: fetchImpl as typeof fetch });
    await expect(client.listPendingInvitations(org)).resolves.toEqual([{
      invitationId: "orginv_pending",
      emailAddress: "pending@example.com",
      role: "org:member",
      createdAt: new Date(1_760_000_000_000),
      expiresAt: new Date(1_762_592_000_000),
    }]);
  });

  it("performs bounded organization management mutations against Clerk", async () => {
    const calls: Array<{ path: string; method: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : init?.body;
      calls.push({ path: url.pathname, method, body });
      return Response.json({ ok: true });
    });
    const client = new ClerkOrganizationUpstreamClient({ secretKey: "sk_test_x", fetchImpl: fetchImpl as typeof fetch });

    await client.renameOrganization(org, "Acme Labs");
    await client.createInvitations(org, ["one@example.com", "two@example.com"], "org:member");
    await client.updateMemberRole(org, "user_member0000000000000000", "org:admin");
    await client.removeMember(org, "user_member0000000000000000");
    await client.revokeInvitation(org, "orginv_pending");
    await client.deleteOrganization(org);

    expect(calls).toEqual([
      { path: `/v1/organizations/${org}`, method: "PATCH", body: { name: "Acme Labs" } },
      { path: `/v1/organizations/${org}/invitations/bulk`, method: "POST", body: { email_addresses: ["one@example.com", "two@example.com"], role: "org:member" } },
      { path: `/v1/organizations/${org}/memberships/user_member0000000000000000`, method: "PATCH", body: { role: "org:admin" } },
      { path: `/v1/organizations/${org}/memberships/user_member0000000000000000`, method: "DELETE", body: undefined },
      { path: `/v1/organizations/${org}/invitations/orginv_pending/revoke`, method: "POST", body: undefined },
      { path: `/v1/organizations/${org}`, method: "DELETE", body: undefined },
    ]);
  });

  it("resends a pending invitation by revoking and recreating it", async () => {
    const calls: Array<{ path: string; method: string; body?: unknown }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      calls.push({ path: url.pathname, method, ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}) });
      if (method === "GET") return Response.json({ data: [{
        id: "orginv_pending", email_address: "pending@example.com", role: "org:member",
        created_at: 1_760_000_000_000, expires_at: 1_762_592_000_000,
      }] });
      return Response.json({ ok: true });
    });
    const client = new ClerkOrganizationUpstreamClient({ secretKey: "sk_test_x", fetchImpl: fetchImpl as typeof fetch });

    await client.resendInvitation(org, "orginv_pending");

    expect(calls).toEqual([
      { path: `/v1/organizations/${org}/invitations/pending`, method: "GET" },
      { path: `/v1/organizations/${org}/invitations/orginv_pending/revoke`, method: "POST" },
      { path: `/v1/organizations/${org}/invitations`, method: "POST", body: { email_address: "pending@example.com", role: "org:member" } },
    ]);
  });

  it("uploads organization logos as multipart data", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("PUT");
      expect(init?.body).toBeInstanceOf(FormData);
      expect((init?.body as FormData).get("file")).toBeInstanceOf(Blob);
      expect(new Headers(init?.headers).has("content-type")).toBe(false);
      return Response.json({ ok: true });
    });
    const client = new ClerkOrganizationUpstreamClient({ secretKey: "sk_test_x", fetchImpl: fetchImpl as typeof fetch });
    await client.updateOrganizationLogo(org, new Blob(["logo"], { type: "image/png" }));
    expect(fetchImpl).toHaveBeenCalledWith(`https://api.clerk.com/v1/organizations/${org}/logo`, expect.objectContaining({ redirect: "error" }));
  });
});
