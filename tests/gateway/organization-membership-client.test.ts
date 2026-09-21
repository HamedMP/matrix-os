import { describe, expect, it, vi } from "vitest";
import { OrganizationMembershipClient } from "../../packages/gateway/src/collaboration/organization-membership-client.js";

const org = "org_2gw000000000000000000001";
const member = "user_member0000000000000000";
const runtimeId = "vps:10000000-0000-4000-8000-000000000001";

function assertionFrame(input: { member: boolean; requestStartedAt: Date; ttlMs?: number; actorId?: string; aiSubmission?: string | null }) {
  return {
    protocolVersion: 2, type: "membership_assertion", organizationId: org, actorId: input.actorId ?? member, membershipEpoch: "3",
    member: input.member, ...(input.aiSubmission === null ? {} : { aiSubmission: input.aiSubmission ?? "members" }),
    requestStartedAt: input.requestStartedAt.toISOString(), expiresAt: new Date(input.requestStartedAt.getTime() + (input.ttlMs ?? 20_000)).toISOString(),
  };
}

function assertionResponse(input: { member: boolean; requestStartedAt: Date; ttlMs?: number; actorId?: string; aiSubmission?: string | null }) {
  return new Response(JSON.stringify([assertionFrame(input)]), { status: 200, headers: { "content-type": "application/json" } });
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
    await expect(client.assertMembership({ organizationId: org, actorId: member })).resolves.toEqual({ member: true, expiresAt: new Date(clock.getTime() + 20_000).toISOString(), aiSubmission: "members", membershipEpoch: "3" });
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://platform.example/internal/organizations/access/resolve");
  });

  it("serves cached positive evidence only until its original expiry and never renews it locally", async () => {
    let clock = new Date("2026-09-20T12:00:00.000Z");
    const fetchImpl = vi.fn(async () => assertionResponse({ member: true, requestStartedAt: clock }));
    const client = new OrganizationMembershipClient({ platformBaseUrl: "https://platform.example", runtimeId, serviceToken: "t".repeat(40), fetchImpl: fetchImpl as unknown as typeof fetch, now: () => clock });
    await client.assertMembership({ organizationId: org, actorId: member });
    clock = new Date(clock.getTime() + 19_000);
    await expect(client.assertMembership({ organizationId: org, actorId: member })).resolves.toMatchObject({ member: true, membershipEpoch: "3", aiSubmission: "members" });
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

  it("batches concurrent lookups for distinct actors into one request of at most 100 actors and settles each individually", async () => {
    const clock = new Date("2026-09-20T12:00:00.000Z");
    const actors = Array.from({ length: 130 }, (_, index) => `user_batch${String(index).padStart(17, "0")}`);
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { actors: { organizationId: string; actorId: string }[] };
      expect(body.actors.length).toBeLessThanOrEqual(100);
      // The platform answers every requested actor except one it never heard of, and one as a non-member.
      const frames = body.actors
        .filter(({ actorId }) => actorId !== actors[7])
        .map(({ actorId }) => assertionFrame({ member: actorId !== actors[3], requestStartedAt: clock, actorId }));
      return new Response(JSON.stringify(frames), { status: 200, headers: { "content-type": "application/json" } });
    });
    const client = new OrganizationMembershipClient({ platformBaseUrl: "https://platform.example", runtimeId, serviceToken: "t".repeat(40), fetchImpl: fetchImpl as unknown as typeof fetch, now: () => clock });
    const results = await Promise.allSettled(actors.map((actorId) => client.assertMembership({ organizationId: org, actorId })));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const sent = fetchImpl.mock.calls.map(([, init]) => (JSON.parse(String(init?.body)) as { actors: unknown[] }).actors.length);
    expect(sent).toEqual([100, 30]);
    expect(results[0]).toMatchObject({ status: "fulfilled", value: { member: true, membershipEpoch: "3" } });
    expect(results[3]).toMatchObject({ status: "fulfilled", value: { member: false } });
    expect(results[7]).toMatchObject({ status: "rejected" });
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(129);
    expect(client.describe().inflight).toBe(0);
    // Batched results are cached per actor exactly like single lookups.
    await client.assertMembership({ organizationId: org, actorId: actors[1]! });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // A failed batch rejects every lookup in it without affecting later batches.
    fetchImpl.mockImplementationOnce(async () => new Response("nope", { status: 503 }));
    const failed = await Promise.allSettled([
      client.assertMembership({ organizationId: org, actorId: "user_fail000000000000000000a" }),
      client.assertMembership({ organizationId: org, actorId: "user_fail000000000000000000b" }),
    ]);
    expect(failed.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
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

  it("evicts cached and in-flight evidence for an actor or a whole organization so a pushed denial is served at once", async () => {
    let clock = new Date("2026-09-20T12:00:00.000Z");
    const other = "user_other000000000000000000";
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { actors: Array<{ actorId: string }> };
      return new Response(JSON.stringify(body.actors.map(({ actorId }) => assertionFrame({ member: true, requestStartedAt: clock, actorId }))), { status: 200, headers: { "content-type": "application/json" } });
    });
    const client = new OrganizationMembershipClient({ platformBaseUrl: "https://platform.example", runtimeId, serviceToken: "t".repeat(40), fetchImpl: fetchImpl as unknown as typeof fetch, now: () => clock });
    await Promise.all([client.assertMembership({ organizationId: org, actorId: member }), client.assertMembership({ organizationId: org, actorId: other })]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // A pushed denial for the member: their cached evidence is dropped, the other actor's is kept.
    client.evict({ organizationId: org, actorId: member });
    expect(client.describe().cacheEntries).toBe(1);
    fetchImpl.mockImplementationOnce(async () => assertionResponse({ member: false, requestStartedAt: clock }));
    await expect(client.assertMembership({ organizationId: org, actorId: member })).resolves.toEqual({ member: false });
    await expect(client.assertMembership({ organizationId: org, actorId: other })).resolves.toMatchObject({ member: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // Evidence that was in flight when the denial arrived is settled but never cached.
    client.evict({ organizationId: org, actorId: member });
    let release!: () => void;
    fetchImpl.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(assertionResponse({ member: true, requestStartedAt: clock, actorId: member })); }));
    const pending = client.assertMembership({ organizationId: org, actorId: member });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    client.evict({ organizationId: org, actorId: member });
    release();
    await expect(pending).resolves.toMatchObject({ member: true });
    fetchImpl.mockImplementationOnce(async () => assertionResponse({ member: false, requestStartedAt: clock }));
    await expect(client.assertMembership({ organizationId: org, actorId: member })).resolves.toEqual({ member: false });
    // An organization-wide denial drops every cached actor of that organization.
    clock = new Date(clock.getTime() + 1_000);
    await client.assertMembership({ organizationId: org, actorId: other });
    expect(client.describe().cacheEntries).toBeGreaterThan(0);
    client.evict({ organizationId: org });
    expect(client.describe().cacheEntries).toBe(0);
  });
});
