import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSeededPreviewPair } from "./preview-pair-seeded-postgres.js";
import { PAIR_NOW } from "./preview-pair-test-support.js";
import { claimPreviewPair, withPreviewPairClaim, requestPreviewPairStop } from "../../packages/platform/src/preview-pair/lifecycle.js";
import { cleanupPreviewPair } from "../../packages/platform/src/preview-pair/cleanup.js";
import { requestPreviewPairUpdate, advancePreviewPairUpdate } from "../../packages/platform/src/preview-pair/update.js";

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("explicit clean reset keeps one reserved fixture and the original hard expiry", () => {
  let fixture: Awaited<ReturnType<typeof createSeededPreviewPair>>;
  beforeEach(async () => { fixture = await createSeededPreviewPair(); }, 30_000);
  afterEach(async () => { await fixture?.destroy(); });
  function candidate() { return { ...fixture.candidate,
    browserOrigin: fixture.candidate.browserOrigin.replace("-g1-", "-g2-"),
    apiOrigin: fixture.candidate.apiOrigin.replace("-g1-", "-g2-") }; }
  it("does not prepare generation two before all old members are physically absent", async () => {
    const pending = await requestPreviewPairUpdate(fixture.db, fixture.pair.pair_id, 1, 1, candidate(), PAIR_NOW);
    const claim = await claimPreviewPair(fixture.db, pending.pair_id, 1, pending.revision, PAIR_NOW);
    await expect(advancePreviewPairUpdate(fixture.db, claim, fixture.prepare, PAIR_NOW)).rejects.toThrow("unavailable");
    expect(await fixture.db.executor.selectFrom("user_machines").selectAll().execute()).toHaveLength(2);
  });
  it("retires old capabilities, resets into exactly one new generation and fences the previous worker", async () => {
    const pending = await requestPreviewPairUpdate(fixture.db, fixture.pair.pair_id, 1, 1, candidate(), PAIR_NOW);
    const claim = await claimPreviewPair(fixture.db, pending.pair_id, 1, pending.revision, PAIR_NOW);
    await cleanupPreviewPair(fixture.db, claim, { retire: async () => undefined,
      proveAbsent: async member => ({ machineId: member.machineId, providerServerId: null,
        exactServerAbsent: true, labeledServerIds: [], creationSettled: true, observedAt: new Date(PAIR_NOW).toISOString() }) }, () => PAIR_NOW);
    const advanced = await advancePreviewPairUpdate(fixture.db, claim, fixture.prepare, PAIR_NOW);
    expect(advanced.generation).toBe(2);
    expect(advanced.state).toBe("preparing");
    expect(advanced.expires_at).toBe(fixture.pair.expires_at);
    const members = await fixture.db.executor.selectFrom("preview_pair_members").selectAll().execute();
    expect(members.filter(m => m.generation === 1).every(m => m.retired_at && m.provider_absent_at)).toBe(true);
    expect(members.filter(m => m.generation === 2)).toHaveLength(2);
    expect(new Set(members.map(m => m.machine_id)).size).toBe(4);
    expect((await fixture.db.executor.selectFrom("preview_pair_fixtures").selectAll().executeTakeFirstOrThrow()).active_pair_id).toBe(fixture.pair.pair_id);
    await expect(withPreviewPairClaim(fixture.db, claim, PAIR_NOW, async () => undefined)).rejects.toThrow("unavailable");
  });
  it("rejects wrong-generation tags and stale revision without altering the pinned pair", async () => {
    await expect(requestPreviewPairUpdate(fixture.db, fixture.pair.pair_id, 1, 1, fixture.candidate, PAIR_NOW)).rejects.toThrow("unavailable");
    await expect(requestPreviewPairUpdate(fixture.db, fixture.pair.pair_id, 1, 99, candidate(), PAIR_NOW)).rejects.toThrow("unavailable");
    expect((await fixture.db.executor.selectFrom("preview_pairs").selectAll().executeTakeFirstOrThrow()).generation).toBe(1);
  });
  it("a concurrent stop and update have exactly one winning revision", async () => {
    const results = await Promise.allSettled([
      requestPreviewPairUpdate(fixture.db, fixture.pair.pair_id, 1, 1, candidate(), PAIR_NOW),
      requestPreviewPairStop(fixture.db, fixture.pair.pair_id, 1, 1, PAIR_NOW),
    ]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  });
});
