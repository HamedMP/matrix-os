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
      public_user_data: { user_id: `user_${String(offset + i).padStart(24, "0")}` },
    }));
    return new Response(JSON.stringify({ data, ...(totalCount === null ? {} : { total_count: totalCount }) }), { status: 200 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

describe("Clerk organization upstream pagination boundary", () => {
  it("accepts an organization with exactly 2,000 members when total_count confirms it", async () => {
    const clerk = fakeClerk(2_000);
    const client = new ClerkOrganizationUpstreamClient({ secretKey: "sk_test_x", fetchImpl: clerk.fetchImpl });
    const snapshot = await client.listMembers(org);
    expect(snapshot.members).toHaveLength(2_000);
    expect(clerk.calls.filter((c) => c.includes("/memberships"))).toHaveLength(20);
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
});
