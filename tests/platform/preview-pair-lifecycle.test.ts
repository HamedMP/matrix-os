import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPreviewPairPostgresFixture } from "./preview-pair-postgres-support.js";
import { PAIR_NOW } from "./preview-pair-test-support.js";
import { claimPreviewPair, requestPreviewPairStop, withPreviewPairClaim, expirePreviewPairs } from "../../packages/platform/src/preview-pair/lifecycle.js";

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("pair claims and stop are fenced by real Postgres writes", () => {
  let fixture: Awaited<ReturnType<typeof createPreviewPairPostgresFixture>>;
  const pairId = "11111111-1111-4111-8111-111111111111";
  beforeEach(async () => {
    fixture = await createPreviewPairPostgresFixture();
    await fixture.db.executor.insertInto("preview_pairs").values({ pair_id: pairId, repository: "HamedMP/matrix-os",
      pr: 3022, requester_id: "user_requester", source_sha: "a".repeat(40), state: "preparing",
      created_at: new Date(PAIR_NOW).toISOString(), expires_at: new Date(PAIR_NOW + 72 * 3_600_000).toISOString() }).execute();
  }, 30_000);
  afterEach(async () => { await fixture?.destroy(); });
  it("only one independent worker can claim the same revision", async () => {
    const results = await Promise.allSettled([claimPreviewPair(fixture.db, pairId, 1, 1, PAIR_NOW),
      claimPreviewPair(fixture.db, pairId, 1, 1, PAIR_NOW)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  });
  it.each(["generation", "revision", "claimId"] as const)("rejects an independently mismatched %s fence", async field => {
    const claim = await claimPreviewPair(fixture.db, pairId, 1, 1, PAIR_NOW);
    const mismatched = { ...claim, [field]: field === "claimId" ? "22222222-2222-4222-8222-222222222222" : claim[field] + 1 };
    let ran = false;
    await expect(withPreviewPairClaim(fixture.db, mismatched, PAIR_NOW + 1_000, async () => { ran = true; })).rejects.toThrow("unavailable");
    expect(ran).toBe(false);
  });
  it("rejects an expired claim even before another worker takes over", async () => {
    const claim = await claimPreviewPair(fixture.db, pairId, 1, 1, PAIR_NOW);
    await expect(withPreviewPairClaim(fixture.db, claim, PAIR_NOW + 121_000, async () => undefined)).rejects.toThrow("unavailable");
  });
  it("stop invalidates an in-flight worker and never extends the original expiry", async () => {
    const claim = await claimPreviewPair(fixture.db, pairId, 1, 1, PAIR_NOW);
    const stopped = await requestPreviewPairStop(fixture.db, pairId, 1, claim.revision, PAIR_NOW + 1_000);
    expect(stopped.state).toBe("cleanup_pending");
    expect(stopped.expires_at).toBe(new Date(PAIR_NOW + 72 * 3_600_000).toISOString());
    let ran = false;
    await expect(withPreviewPairClaim(fixture.db, claim, PAIR_NOW + 2_000, async () => { ran = true; })).rejects.toThrow("unavailable");
    expect(ran).toBe(false);
  });
  it("repeated stop of the same generation is idempotent", async () => {
    const first = await requestPreviewPairStop(fixture.db, pairId, 1, 1, PAIR_NOW);
    const replay = await requestPreviewPairStop(fixture.db, pairId, 1, 1, PAIR_NOW + 1_000);
    expect(replay).toEqual(first);
  });
  it("an expired worker cannot persist completion after another worker recovers", async () => {
    const old = await claimPreviewPair(fixture.db, pairId, 1, 1, PAIR_NOW);
    const fresh = await claimPreviewPair(fixture.db, pairId, 1, old.revision, PAIR_NOW + 121_000);
    await expect(withPreviewPairClaim(fixture.db, old, PAIR_NOW + 122_000, async () => undefined)).rejects.toThrow("unavailable");
    const result = await withPreviewPairClaim(fixture.db, fresh, PAIR_NOW + 122_000, async trx =>
      trx.executor.selectFrom("preview_pairs").select("pair_id").where("pair_id", "=", pairId).executeTakeFirstOrThrow());
    expect(result.pair_id).toBe(pairId);
  });
  it("stale generation stop cannot cancel a newer generation", async () => {
    await fixture.db.executor.updateTable("preview_pairs").set({ generation: 2, revision: 2 }).where("pair_id", "=", pairId).execute();
    await expect(requestPreviewPairStop(fixture.db, pairId, 1, 2, PAIR_NOW)).rejects.toThrow("unavailable");
    expect((await fixture.db.executor.selectFrom("preview_pairs").selectAll().executeTakeFirstOrThrow()).state).toBe("preparing");
  });
  it("hard expiry invalidates claims and moves to cleanup without freeing fixtures", async () => {
    const claim = await claimPreviewPair(fixture.db, pairId, 1, 1, PAIR_NOW);
    expect(await expirePreviewPairs(fixture.db, PAIR_NOW + 72 * 3_600_000, 16)).toBe(1);
    await expect(withPreviewPairClaim(fixture.db, claim, PAIR_NOW + 72 * 3_600_000, async () => undefined)).rejects.toThrow("unavailable");
    expect((await fixture.db.executor.selectFrom("preview_pairs").selectAll().executeTakeFirstOrThrow()).stopped_at).toBeNull();
  });
});
