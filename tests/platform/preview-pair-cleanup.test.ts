import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSeededPreviewPair } from "./preview-pair-seeded-postgres.js";
import { PAIR_NOW } from "./preview-pair-test-support.js";
import { claimPreviewPair, requestPreviewPairStop } from "../../packages/platform/src/preview-pair/lifecycle.js";
import { cleanupPreviewPair } from "../../packages/platform/src/preview-pair/cleanup.js";

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("pair cleanup retains capacity until actual absence is proved", () => {
  let fixture: Awaited<ReturnType<typeof createSeededPreviewPair>>;
  beforeEach(async () => { fixture = await createSeededPreviewPair(); }, 30_000);
  afterEach(async () => { await fixture?.destroy(); });
  async function stop() {
    const row = await requestPreviewPairStop(fixture.db, fixture.pair.pair_id, 1, 1, PAIR_NOW);
    return claimPreviewPair(fixture.db, row.pair_id, 1, row.revision, PAIR_NOW);
  }
  const proof = (machineId: string) => ({ machineId, providerServerId: null, exactServerAbsent: true,
    labeledServerIds: [] as number[], creationSettled: true, observedAt: new Date(PAIR_NOW).toISOString() });
  it.each(["exact server remains", "labeled orphan remains", "wrong machine", "stale proof", "provider unavailable", "unsettled creation"])(
    "keeps the whole fixture reservation when %s", async fault => {
      const claim = await stop();
      const retire = vi.fn(async () => undefined);
      const proveAbsent = vi.fn(async (member: { machineId: string }) => {
        if (fault === "provider unavailable") throw new Error("provider unavailable");
        const result = proof(member.machineId);
        if (fault === "exact server remains") result.exactServerAbsent = false;
        if (fault === "labeled orphan remains") result.labeledServerIds = [123];
        if (fault === "wrong machine") result.machineId = "22222222-2222-4222-8222-222222222222";
        if (fault === "stale proof") result.observedAt = "2026-10-30T11:00:00.000Z";
        if (fault === "unsettled creation") result.creationSettled = false;
        return result;
      });
      await cleanupPreviewPair(fixture.db, claim, { retire, proveAbsent }, () => PAIR_NOW);
      const row = await fixture.db.executor.selectFrom("preview_pairs").selectAll().executeTakeFirstOrThrow();
      expect(row.state).toBe("cleanup_pending");
      expect(row.stopped_at).toBeNull();
      expect((await fixture.db.executor.selectFrom("preview_pair_fixtures").selectAll().executeTakeFirstOrThrow()).active_pair_id).toBe(row.pair_id);
    });
  it("retires both exact members, then releases the fixture only after fresh proofs", async () => {
    const claim = await stop();
    const retire = vi.fn(async () => undefined);
    await cleanupPreviewPair(fixture.db, claim, { retire, proveAbsent: async member => proof(member.machineId) }, () => PAIR_NOW);
    expect(retire).toHaveBeenCalledTimes(2);
    const row = await fixture.db.executor.selectFrom("preview_pairs").selectAll().executeTakeFirstOrThrow();
    expect(row.state).toBe("stopped");
    expect(row.stopped_at).toBe(new Date(PAIR_NOW).toISOString());
    expect((await fixture.db.executor.selectFrom("preview_pair_fixtures").selectAll().executeTakeFirstOrThrow()).active_pair_id).toBeNull();
  });
  it("retires both members before external effects and attempts both cleanups when the first is unavailable", async () => {
    const claim = await stop();
    const unavailable = await fixture.db.executor.selectFrom("preview_pair_members").select("machine_id").orderBy("generation").orderBy("role").executeTakeFirstOrThrow();
    const retire = vi.fn(async (member: { machineId: string }) => {
      const machines = await fixture.db.executor.selectFrom("user_machines").select(["machine_id", "status", "deleted_at", "runtime_token_epoch"]).execute();
      expect(machines).toHaveLength(2);
      expect(machines.every(machine => machine.status === "deleted" && machine.deleted_at !== null && machine.runtime_token_epoch === 2)).toBe(true);
      if (member.machineId === unavailable.machine_id) throw new Error("Fixture target unavailable");
    });
    await cleanupPreviewPair(fixture.db, claim, { retire, proveAbsent: async member => proof(member.machineId) }, () => PAIR_NOW);
    expect(retire).toHaveBeenCalledTimes(2);
    const pair = await fixture.db.executor.selectFrom("preview_pairs").selectAll().executeTakeFirstOrThrow();
    expect(pair.state).toBe("cleanup_pending"); expect(pair.stopped_at).toBeNull();
    expect((await fixture.db.executor.selectFrom("preview_pair_fixtures").select("active_pair_id").executeTakeFirstOrThrow()).active_pair_id).toBe(claim.pairId);
  });
  it("a stale worker performs no host effect and cannot release a newer generation", async () => {
    const claim = await stop();
    await fixture.db.executor.updateTable("preview_pairs").set({ generation: 2, revision: claim.revision + 1 }).where("pair_id", "=", claim.pairId).execute();
    const retire = vi.fn(async () => undefined);
    await expect(cleanupPreviewPair(fixture.db, claim, { retire, proveAbsent: async member => proof(member.machineId) }, () => PAIR_NOW)).rejects.toThrow("unavailable");
    expect(retire).not.toHaveBeenCalled();
    expect((await fixture.db.executor.selectFrom("preview_pair_fixtures").selectAll().executeTakeFirstOrThrow()).active_pair_id).toBe(claim.pairId);
  });
});
