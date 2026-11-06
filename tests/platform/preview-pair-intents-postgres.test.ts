import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSeededPreviewPair } from "./preview-pair-seeded-postgres.js";
import { PAIR_NOW } from "./preview-pair-test-support.js";
import { admitPreviewPair } from "../../packages/platform/src/preview-pair/admission.js";
import { requestPreviewPairUpdate } from "../../packages/platform/src/preview-pair/update.js";
import { preparePreviewPairCloudIntent, stopPreviewPairCloudIntent } from "../../packages/platform/src/preview-pair/cloud-intents.js";

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("durable cloud requests fence actual pair admission", () => {
  let fixture: Awaited<ReturnType<typeof createSeededPreviewPair>>;
  beforeEach(async () => { fixture = await createSeededPreviewPair(); }, 30_000);
  afterEach(async () => { await fixture?.destroy(); });
  const fingerprint = "f".repeat(64);
  const newId = "44444444-4444-4444-8444-444444444444";
  function start() {
    return { pairId: newId, pr: 3023, requesterId: "user_requester", controllerRunId: 42,
      sourceSha: fixture.candidate.sourceSha, candidate: { ...fixture.candidate, sourceProfileFingerprint: fingerprint,
        browserOrigin: fixture.candidate.browserOrigin.replace("11111111", "44444444"),
        apiOrigin: fixture.candidate.apiOrigin.replace("11111111", "44444444") } };
  }
  function intent() {
    const { candidate: _candidate, ...request } = start();
    return { ...request, generation: 1, profileFingerprint: fingerprint };
  }
  const config = () => ({ ...fixture.config, sourceProfileFingerprint: fingerprint });
  it("cannot allocate a pair without its prior source-owned publication intent", async () => {
    await expect(admitPreviewPair(fixture.db, { ...fixture.config, sourceProfileFingerprint: fingerprint },
      start(), fixture.prepare, PAIR_NOW)).rejects.toThrow("unavailable");
    expect(await fixture.db.executor.selectFrom("preview_pairs").selectAll().execute()).toHaveLength(1);
    expect(fixture.hetzner.createServer).not.toHaveBeenCalled();
  });
  it("cannot start a generation update without its prior publication intent", async () => {
    const candidate = { ...fixture.candidate, sourceProfileFingerprint: fingerprint,
      browserOrigin: fixture.candidate.browserOrigin.replace("g1", "g2"),
      apiOrigin: fixture.candidate.apiOrigin.replace("g1", "g2") };
    await expect(requestPreviewPairUpdate(fixture.db, fixture.pair.pair_id, 1, fixture.pair.revision,
      candidate, PAIR_NOW, 42)).rejects.toThrow("unavailable");
    expect(await fixture.db.executor.selectFrom("preview_pair_generations").selectAll().execute()).toHaveLength(1);
    expect((await fixture.db.executor.selectFrom("preview_pairs").select("state").executeTakeFirstOrThrow()).state).toBe("preparing");
  });
  it("prepares once without allocating a fixture, machine, job or provider resource", async () => {
    const first = await preparePreviewPairCloudIntent(fixture.db, config(), intent(), PAIR_NOW);
    const replay = await preparePreviewPairCloudIntent(fixture.db, config(), intent(), PAIR_NOW + 60_000);
    expect(replay).toEqual(first);
    expect(first).toMatchObject({ state: "prepared", revision: 1 });
    expect(await fixture.db.executor.selectFrom("user_machines").selectAll().execute()).toHaveLength(2);
    expect(await fixture.db.executor.selectFrom("provisioning_jobs").selectAll().execute()).toHaveLength(2);
    expect(fixture.hetzner.createServer).not.toHaveBeenCalled();
  });
  it("adopts the intent in the same transaction as the canonical generation", async () => {
    await preparePreviewPairCloudIntent(fixture.db, config(), intent(), PAIR_NOW);
    const pair = await admitPreviewPair(fixture.db, config(), start(), fixture.prepare, PAIR_NOW);
    expect(pair).toMatchObject({ pair_id: newId, state: "queued" });
    expect((await fixture.db.executor.selectFrom("preview_pair_cloud_intents").selectAll().executeTakeFirstOrThrow()).state).toBe("adopted");
    expect(await admitPreviewPair(fixture.db, config(), start(), fixture.prepare, PAIR_NOW + 60_000)).toMatchObject({ pair_id: newId });
    // A cancelled duplicate workflow cannot retire an adopted pair through its intent.
    expect((await stopPreviewPairCloudIntent(fixture.db, newId, 1, 42, PAIR_NOW)).state).toBe("adopted");
  });
  it("a cancelled request cannot be resurrected by a late publisher or admission", async () => {
    await preparePreviewPairCloudIntent(fixture.db, config(), intent(), PAIR_NOW);
    expect((await stopPreviewPairCloudIntent(fixture.db, newId, 1, 42, PAIR_NOW)).state).toBe("cleanup_pending");
    await expect(preparePreviewPairCloudIntent(fixture.db, config(), intent(), PAIR_NOW)).rejects.toThrow("unavailable");
    await expect(admitPreviewPair(fixture.db, config(), start(), fixture.prepare, PAIR_NOW)).rejects.toThrow("unavailable");
    expect(await fixture.db.executor.selectFrom("preview_pairs").selectAll().execute()).toHaveLength(1);
  });
  it.each(["controllerRunId", "requesterId", "profileFingerprint", "sourceSha"] as const)("a changed %s cannot reuse a prepared publication identity", async key => {
    await preparePreviewPairCloudIntent(fixture.db, config(), intent(), PAIR_NOW);
    const changed = { ...intent(), [key]: key === "controllerRunId" ? 43 : key === "requesterId" ? "user_other" : "e".repeat(key === "sourceSha" ? 40 : 64) };
    await expect(preparePreviewPairCloudIntent(fixture.db, config(), changed, PAIR_NOW)).rejects.toThrow("unavailable");
    expect((await fixture.db.executor.selectFrom("preview_pair_cloud_intents").selectAll().executeTakeFirstOrThrow()).revision).toBe(1);
  });
  it("expiry does not become a new lease through replay", async () => {
    const prepared = await preparePreviewPairCloudIntent(fixture.db, config(), intent(), PAIR_NOW);
    const expired = Date.parse(prepared.expires_at);
    await expect(preparePreviewPairCloudIntent(fixture.db, config(), intent(), expired)).rejects.toThrow("unavailable");
    await expect(admitPreviewPair(fixture.db, config(), start(), fixture.prepare, expired)).rejects.toThrow("unavailable");
  });
  it("concurrent cancellation and admission have a single transaction winner", async () => {
    await preparePreviewPairCloudIntent(fixture.db, config(), intent(), PAIR_NOW);
    const outcomes = await Promise.allSettled([
      admitPreviewPair(fixture.db, config(), start(), fixture.prepare, PAIR_NOW),
      stopPreviewPairCloudIntent(fixture.db, newId, 1, 42, PAIR_NOW),
    ]);
    const saved = await fixture.db.executor.selectFrom("preview_pair_cloud_intents").selectAll().executeTakeFirstOrThrow();
    const pair = await fixture.db.executor.selectFrom("preview_pairs").select("pair_id").where("pair_id", "=", newId).executeTakeFirst();
    expect(Boolean(pair)).toBe(saved.state === "adopted");
    expect(outcomes[1].status).toBe("fulfilled");
  });
  it("a failed generation insert rolls back adoption too", async () => {
    await preparePreviewPairCloudIntent(fixture.db, config(), intent(), PAIR_NOW);
    await expect(fixture.db.transaction(async () => {
      await admitPreviewPair(fixture.db, config(), start(), fixture.prepare, PAIR_NOW);
      throw new Error("simulated transaction failure after both writes");
    })).rejects.toThrow("simulated transaction failure");
    expect((await fixture.db.executor.selectFrom("preview_pair_cloud_intents").selectAll().executeTakeFirstOrThrow()).state).toBe("prepared");
    expect(await fixture.db.executor.selectFrom("preview_pairs").selectAll().execute()).toHaveLength(1);
  });
  it("a verified maintainer can prepare and adopt an explicit update without impersonating the initial requester", async () => {
    const candidate = { ...fixture.candidate, sourceProfileFingerprint: fingerprint,
      browserOrigin: fixture.candidate.browserOrigin.replace("g1", "g2"),
      apiOrigin: fixture.candidate.apiOrigin.replace("g1", "g2") };
    await preparePreviewPairCloudIntent(fixture.db, config(), { ...intent(), pairId: fixture.pair.pair_id,
      pr: fixture.pair.pr, generation: 2, requesterId: "user_maintainer" }, PAIR_NOW);
    await requestPreviewPairUpdate(fixture.db, fixture.pair.pair_id, 1, fixture.pair.revision,
      candidate, PAIR_NOW, 42, "user_maintainer");
    expect((await fixture.db.executor.selectFrom("preview_pair_cloud_intents").selectAll().executeTakeFirstOrThrow()).state).toBe("adopted");
    expect(await fixture.db.executor.selectFrom("preview_pair_generations").selectAll().execute()).toHaveLength(2);
  });
  it("keeps the bounded preparation queue full until cancelled requests are proved retired", async () => {
    const row = await preparePreviewPairCloudIntent(fixture.db, config(), intent(), PAIR_NOW);
    await fixture.db.executor.insertInto("preview_pair_cloud_intents").values(Array.from({ length: 31 }, (_, index) => ({
      ...row, pair_id: `55555555-5555-4555-8555-${String(index).padStart(12, "0")}`,
      state: "cleanup_pending" as const,
    }))).execute();
    const next = { ...intent(), pairId: "66666666-6666-4666-8666-666666666666", pr: 3024 };
    await expect(preparePreviewPairCloudIntent(fixture.db, config(), next, PAIR_NOW)).rejects.toMatchObject({ status: 429 });
    expect(await fixture.db.executor.selectFrom("preview_pair_cloud_intents").selectAll().execute()).toHaveLength(32);
  });
});
