import { describe, expect, it, vi } from "vitest";
import { OrganizationMembershipClient } from "../../packages/gateway/src/collaboration/organization-membership-client.js";

const org = "org_2gw000000000000000000001";
const member = "user_member0000000000000000";
const runtimeId = "vps:10000000-0000-4000-8000-000000000001";

function assertionResponse(input: { member: boolean; requestStartedAt: Date; ttlMs?: number; actorId?: string; aiSubmission?: string | null }) {
  return new Response(JSON.stringify([{
    protocolVersion: 2, type: "membership_assertion", organizationId: org, actorId: input.actorId ?? member, membershipEpoch: "3",
    member: input.member, ...(input.aiSubmission === null ? {} : { aiSubmission: input.aiSubmission ?? "members" }),
    requestStartedAt: input.requestStartedAt.toISOString(), expiresAt: new Date(input.requestStartedAt.getTime() + (input.ttlMs ?? 20_000)).toISOString(),
  }]), { status: 200, headers: { "content-type": "application/json" } });
}

describe("gateway organization membership client (S03 seam for the S20 precondition)", () => {
  it("asks the platform with runtime credentials and returns the platform's fixed expiry", async () => {
    const clock = new Date("2026-09-20T12:00:00.000Z");
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { protocolVersion: number; actors: unknown[] };
      expect(body).toEqual({ protocolVersion: 2, actors: [{ organizationId: org, actorId: member }] });
      expect((init?.headers as Record<string, string>)["x-matrix-runtime-id"]).toBe(runtimeId);
      expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${"t".repeat(40)}`);
      return assertionResponse({ member: true, requestStartedAt: clock });
    });
    const client = new OrganizationMembershipClient({ platformBaseUrl: "https://platform.example", runtimeId, serviceToken: "t".repeat(40), fetchImpl: fetchImpl as unknown as typeof fetch, now: () => clock });
    await expect(client.assertMembership({ organizationId: org, actorId: member })).resolves.toEqual({ member: true, expiresAt: new Date(clock.getTime() + 20_000).toISOString(), aiSubmission: "members" });
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://platform.example/internal/organizations/access/resolve");
  });

  it("serves cached positive evidence only until its original expiry and never renews it locally", async () => {
    let clock = new Date("2026-09-20T12:00:00.000Z");
    const fetchImpl = vi.fn(async () => assertionResponse({ member: true, requestStartedAt: clock }));
    const client = new OrganizationMembershipClient({ platformBaseUrl: "https://platform.example", runtimeId, serviceToken: "t".repeat(40), fetchImpl: fetchImpl as unknown as typeof fetch, now: () => clock });
    await client.assertMembership({ organizationId: org, actorId: member });
    clock = new Date(clock.getTime() + 19_000);
    await client.assertMembership({ organizationId: org, actorId: member });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    clock = new Date(clock.getTime() + 2_000);
    await client.assertMembership({ organizationId: org, actorId: member });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent lookups, bounds the cache and fails closed on transport, status or schema errors", async () => {
    const clock = new Date("2026-09-20T12:00:00.000Z");
    const fetchImpl = vi.fn(async () => assertionResponse({ member: true, requestStartedAt: clock }));
    const client = new OrganizationMembershipClient({ platformBaseUrl: "https://platform.example", runtimeId, serviceToken: "t".repeat(40), fetchImpl: fetchImpl as unknown as typeof fetch, now: () => clock, maxCacheEntries: 2 });
    await Promise.all([client.assertMembership({ organizationId: org, actorId: member }), client.assertMembership({ organizationId: org, actorId: member })]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    for (const actorId of ["user_a00000000000000000000000", "user_b00000000000000000000000", "user_c00000000000000000000000"]) {
      fetchImpl.mockImplementationOnce(async () => assertionResponse({ member: true, requestStartedAt: clock, actorId }));
      await client.assertMembership({ organizationId: org, actorId });
    }
    expect(client.describe().cacheEntries).toBeLessThanOrEqual(2);
    fetchImpl.mockImplementationOnce(async () => new Response("nope", { status: 503 }));
    await expect(client.assertMembership({ organizationId: org, actorId: "user_d00000000000000000000000" })).rejects.toThrow();
    fetchImpl.mockImplementationOnce(async () => new Response(JSON.stringify([{ type: "generation" }]), { status: 200 }));
    await expect(client.assertMembership({ organizationId: org, actorId: "user_e00000000000000000000000" })).rejects.toThrow();
    fetchImpl.mockImplementationOnce(async () => { throw new TypeError("fetch failed"); });
    await expect(client.assertMembership({ organizationId: org, actorId: "user_f00000000000000000000000" })).rejects.toThrow();
  });

  it("carries the organization AI-submission policy and treats an absent or unknown value as owner-only", async () => {
    const clock = new Date("2026-09-20T12:00:00.000Z");
    const fetchImpl = vi.fn(async () => assertionResponse({ member: true, requestStartedAt: clock, aiSubmission: null }));
    const client = new OrganizationMembershipClient({ platformBaseUrl: "https://platform.example", runtimeId, serviceToken: "t".repeat(40), fetchImpl: fetchImpl as unknown as typeof fetch, now: () => clock });
    await expect(client.assertMembership({ organizationId: org, actorId: member })).resolves.toMatchObject({ member: true, aiSubmission: "owner_only" });
    await expect(client.organizationAiSubmission({ organizationId: org, actorId: member })).resolves.toBe("owner_only");
    fetchImpl.mockImplementationOnce(async () => assertionResponse({ member: true, requestStartedAt: clock, actorId: "user_a00000000000000000000000", aiSubmission: "unknown" }));
    await expect(client.organizationAiSubmission({ organizationId: org, actorId: "user_a00000000000000000000000" })).resolves.toBe("owner_only");
    fetchImpl.mockImplementationOnce(async () => assertionResponse({ member: true, requestStartedAt: clock, actorId: "user_b00000000000000000000000", aiSubmission: "members" }));
    await expect(client.organizationAiSubmission({ organizationId: org, actorId: "user_b00000000000000000000000" })).resolves.toBe("members");
    fetchImpl.mockImplementationOnce(async () => assertionResponse({ member: false, requestStartedAt: clock, actorId: "user_c00000000000000000000000", aiSubmission: "members" }));
    await expect(client.organizationAiSubmission({ organizationId: org, actorId: "user_c00000000000000000000000" })).resolves.toBe("owner_only");
    fetchImpl.mockImplementationOnce(async () => new Response("nope", { status: 503 }));
    await expect(client.organizationAiSubmission({ organizationId: org, actorId: "user_d00000000000000000000000" })).resolves.toBe("owner_only");
  });

  it("rejects an assertion the platform issued for a different actor or organization", async () => {
    const clock = new Date("2026-09-20T12:00:00.000Z");
    const fetchImpl = vi.fn(async () => assertionResponse({ member: true, requestStartedAt: clock, actorId: "user_other000000000000000000" }));
    const client = new OrganizationMembershipClient({ platformBaseUrl: "https://platform.example", runtimeId, serviceToken: "t".repeat(40), fetchImpl: fetchImpl as unknown as typeof fetch, now: () => clock });
    await expect(client.assertMembership({ organizationId: org, actorId: member })).rejects.toThrow();
  });
});
