import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapPlatformOrganizationDatabase, type OrganizationPlatformDatabase } from "../../packages/platform/src/organizations/database.js";
import { PlatformOrganizationRepository } from "../../packages/platform/src/organizations/repository.js";
import { createCollaborationControlAuthority } from "../../packages/platform/src/collaboration/control-authority.js";
import { createTestPlatformDb, destroyTestPlatformDb, type TestPlatformDb } from "./platform-db-test-helper.js";

const org = "org_2ctrl00000000000000000001";
const member = "user_member0000000000000000";
const runtimeA = "vps-10000000-0000-4000-8000-00000000000a";
const runtimeB = "vps-10000000-0000-4000-8000-00000000000b";

describe("collaboration control authority (T017/T019)", () => {
  let fixture: TestPlatformDb;
  let repository: PlatformOrganizationRepository;
  let clock: Date;

  beforeEach(async () => {
    fixture = await createTestPlatformDb();
    const db = fixture.db.kysely as unknown as Kysely<OrganizationPlatformDatabase>;
    await bootstrapPlatformOrganizationDatabase(db);
    clock = new Date("2026-09-20T12:00:00.000Z");
    repository = new PlatformOrganizationRepository(db, { now: () => clock });
  });

  afterEach(async () => destroyTestPlatformDb(fixture.db));

  it("keeps a denial pending until every affected runtime acknowledges a fence at or after it", async () => {
    const authority = createCollaborationControlAuthority({ repository, now: () => clock, leaseMs: 25_000, affectedRuntimes: async () => [runtimeA, runtimeB] });
    const denial = await authority.fence({ organizationId: org, actorId: member, generation: 3 });
    expect(denial).toMatchObject({ state: "pending", generation: 3, organizationId: org, actorId: member });
    expect(Date.parse(denial.ackDeadline) - Date.parse(denial.fencedAt)).toBe(25_000);
    await authority.acknowledge(runtimeA, { protocolVersion: 2, runtimeId: runtimeA, authorityGeneration: 3, fenceAt: new Date(clock.getTime() - 1_000).toISOString() });
    expect((await authority.describe(denial.denialId))?.state).toBe("pending");
    await authority.acknowledge(runtimeA, { protocolVersion: 2, runtimeId: runtimeA, authorityGeneration: 3, fenceAt: clock.toISOString() });
    expect((await authority.describe(denial.denialId))?.state).toBe("pending");
    clock = new Date(clock.getTime() + 2_000);
    await authority.acknowledge(runtimeB, { protocolVersion: 2, runtimeId: runtimeB, authorityGeneration: 3, fenceAt: clock.toISOString() });
    const completed = await authority.describe(denial.denialId);
    expect(completed?.state).toBe("completed");
    expect(completed?.acknowledgedAt).toBe(clock.toISOString());
    await authority.shutdown();
  });

  it("rejects an acknowledgement whose runtime does not match the authenticated runtime", async () => {
    const authority = createCollaborationControlAuthority({ repository, now: () => clock, affectedRuntimes: async () => [runtimeA] });
    await expect(authority.acknowledge(runtimeB, { protocolVersion: 2, runtimeId: runtimeA, authorityGeneration: 1, fenceAt: clock.toISOString() })).rejects.toThrow(/runtime/i);
    await authority.shutdown();
  });

  it("delivers pending denials through the registered transport with backoff and dead-letters after repeated failure", async () => {
    vi.useFakeTimers();
    try {
      const deliver = vi.fn(async () => { throw new Error("transport down"); });
      const authority = createCollaborationControlAuthority({
        repository, now: () => clock, leaseMs: 25_000, affectedRuntimes: async () => [runtimeA], deliver, maxDeliveryAttempts: 3, deliveryIntervalMs: 1_000, startTimers: true,
      });
      const denial = await authority.fence({ organizationId: org, generation: 5 });
      for (let i = 0; i < 12; i += 1) {
        clock = new Date(clock.getTime() + 1_000);
        await vi.advanceTimersByTimeAsync(1_000);
      }
      expect(deliver).toHaveBeenCalledTimes(3);
      expect(deliver.mock.calls[0]![0]).toBe(runtimeA);
      expect((deliver.mock.calls[0]![1] as { type: string }).type).toBe("denial");
      const outbox = await authority.describeOutbox(denial.denialId);
      expect(outbox).toEqual([{ runtimeId: runtimeA, attempts: 3, deadLetter: true, acknowledgedAt: null }]);
      await authority.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("batches membership assertions with one request start, caps the batch and coalesces duplicates", async () => {
    const assert = vi.fn(async (input: { organizationId: string; actorId: string; requestStartedAt: Date }) => ({
      member: input.actorId === member, membershipEpoch: 4, requestStartedAt: input.requestStartedAt, expiresAt: new Date(input.requestStartedAt.getTime() + 20_000),
    }));
    const authority = createCollaborationControlAuthority({ repository, now: () => clock, affectedRuntimes: async () => [], projection: { assert } });
    const assertions = await authority.assertActors(runtimeA, [
      { organizationId: org, actorId: member },
      { organizationId: org, actorId: member },
      { organizationId: org, actorId: "user_other000000000000000000" },
    ]);
    expect(assert).toHaveBeenCalledTimes(2);
    expect(assertions.map((a) => a.type === "membership_assertion" && a.member)).toEqual([true, false]);
    expect(assertions.every((a) => a.type === "membership_assertion" && a.requestStartedAt === clock.toISOString())).toBe(true);
    await expect(authority.assertActors(runtimeA, Array.from({ length: 101 }, (_, i) => ({ organizationId: org, actorId: `user_${String(i).padStart(24, "0")}` })))).rejects.toThrow(/batch/i);
    await authority.shutdown();
  });

  it("completes expired leases on the recurring sweep and stops timers on shutdown", async () => {
    vi.useFakeTimers();
    try {
      const authority = createCollaborationControlAuthority({ repository, now: () => clock, leaseMs: 5_000, affectedRuntimes: async () => [runtimeA], sweepIntervalMs: 1_000, startTimers: true });
      const denial = await authority.fence({ scopeId: "10000000-0000-4000-8000-000000000001", generation: 9 });
      clock = new Date(clock.getTime() + 6_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await authority.describe(denial.denialId))?.state).toBe("completed");
      await authority.shutdown();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
