import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSeededPreviewPair } from "./preview-pair-seeded-postgres.js";
import { PAIR_NOW } from "./preview-pair-test-support.js";
import { admitPreviewPair, promoteQueuedPreviewPair } from "../../packages/platform/src/preview-pair/admission.js";
import { requestPreviewPairStop, claimPreviewPair } from "../../packages/platform/src/preview-pair/lifecycle.js";
import { upsertHostBundleRelease } from "../../packages/platform/src/db.js";
import { cleanupPreviewPair } from "../../packages/platform/src/preview-pair/cleanup.js";

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("queued pairs acquire two slots atomically when capacity becomes free", () => {
  let fixture: Awaited<ReturnType<typeof createSeededPreviewPair>>;
  const nextId = "22222222-2222-4222-8222-222222222222";
  beforeEach(async () => {
    fixture = await createSeededPreviewPair();
    const version = fixture.candidate.hostBundleVersion + "-queue";
    await upsertHostBundleRelease(fixture.db, { version, sourcePr: 3030, gitCommit: fixture.candidate.sourceSha,
      channel: null, sha256: fixture.candidate.hostBundleSha256, size: 123,
      buildTime: new Date(PAIR_NOW).toISOString(), bundleKey: "test/queue.tar.gz" });
    await admitPreviewPair(fixture.db, fixture.config, { pairId: nextId, pr: 3030, requesterId: "user_requester",
      sourceSha: fixture.candidate.sourceSha, candidate: { ...fixture.candidate, hostBundleVersion: version,
        browserOrigin: fixture.candidate.browserOrigin.replace("11111111", "22222222"),
        apiOrigin: fixture.candidate.apiOrigin.replace("11111111", "22222222") } }, fixture.prepare, PAIR_NOW);
  }, 30_000);
  afterEach(async () => { await fixture?.destroy(); });
  async function freeCapacity() {
    const pending = await requestPreviewPairStop(fixture.db, fixture.pair.pair_id, 1, 1, PAIR_NOW);
    const claim = await claimPreviewPair(fixture.db, pending.pair_id, 1, pending.revision, PAIR_NOW);
    await cleanupPreviewPair(fixture.db, claim, { retire: async () => undefined,
      proveAbsent: async member => ({ machineId: member.machineId, providerServerId: null, exactServerAbsent: true,
        labeledServerIds: [], creationSettled: true, observedAt: new Date(PAIR_NOW).toISOString() }) }, () => PAIR_NOW);
  }
  it("retains the whole queued reservation while the existing fixture is occupied", async () => {
    const pair = await promoteQueuedPreviewPair(fixture.db, fixture.config, nextId, 1, fixture.prepare, PAIR_NOW);
    expect(pair.state).toBe("queued");
    expect(await fixture.db.executor.selectFrom("user_machines").selectAll().execute()).toHaveLength(2);
  });
  it("promotes both members together without extending the original hard expiry", async () => {
    await freeCapacity();
    const before = await fixture.db.executor.selectFrom("preview_pairs").selectAll().where("pair_id", "=", nextId).executeTakeFirstOrThrow();
    const promoted = await promoteQueuedPreviewPair(fixture.db, fixture.config, nextId, 1, fixture.prepare, PAIR_NOW + 1_000);
    expect(promoted.state).toBe("preparing"); expect(promoted.expires_at).toBe(before.expires_at);
    expect(await fixture.db.executor.selectFrom("preview_pair_members").selectAll().where("pair_id", "=", nextId).execute()).toHaveLength(2);
    expect(fixture.hetzner.createServer).not.toHaveBeenCalled();
  });
  it("rolls back promotion if preparing the second member fails", async () => {
    await freeCapacity();
    await expect(promoteQueuedPreviewPair(fixture.db, fixture.config, nextId, 1, async (...args) => {
      if (args[2] === "member") throw new Error("member failed"); return fixture.prepare(...args);
    }, PAIR_NOW)).rejects.toThrow("member failed");
    const pair = await fixture.db.executor.selectFrom("preview_pairs").selectAll().where("pair_id", "=", nextId).executeTakeFirstOrThrow();
    expect(pair.state).toBe("queued"); expect(pair.fixture_id).toBeNull();
    expect(await fixture.db.executor.selectFrom("user_machines").selectAll().execute()).toHaveLength(2);
    expect((await fixture.db.executor.selectFrom("preview_pair_fixtures").selectAll().executeTakeFirstOrThrow()).active_pair_id).toBeNull();
  });
  it("does not promote an expired reservation", async () => {
    await freeCapacity();
    await expect(promoteQueuedPreviewPair(fixture.db, fixture.config, nextId, 1, fixture.prepare, PAIR_NOW + 72 * 3_600_000))
      .rejects.toThrow("unavailable");
    expect(await fixture.db.executor.selectFrom("user_machines").selectAll().execute()).toHaveLength(2);
  });
});
