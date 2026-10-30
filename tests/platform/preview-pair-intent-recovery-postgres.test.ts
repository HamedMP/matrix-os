import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSeededPreviewPair } from "./preview-pair-seeded-postgres.js";
import { PAIR_NOW } from "./preview-pair-test-support.js";
import { previewPairReadinessAdapters } from "./preview-pair-ready-postgres.js";
import { previewPairProvenanceFixture } from "./preview-pair-provenance-fixture.js";
import { createPreviewPairService } from "../../packages/platform/src/preview-pair/service.js";
import { preparePreviewPairCloudIntent, stopPreviewPairCloudIntent } from "../../packages/platform/src/preview-pair/cloud-intents.js";

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("pre-admission recovery uses the actual source worker service", () => {
  let f: Awaited<ReturnType<typeof createSeededPreviewPair>>;
  beforeEach(async () => { f = await createSeededPreviewPair(); }, 30_000);
  afterEach(async () => { await f?.destroy(); });
  async function setup(admissionEnabled = true) {
    let now = PAIR_NOW;
    const config = { ...f.config, sourceProfileFingerprint: "f".repeat(64) }, pairId = "44444444-4444-4444-8444-444444444444";
    const row = await preparePreviewPairCloudIntent(f.db, config, { pairId, generation: 1, pr: 3023,
      requesterId: "user_requester", controllerRunId: 42, sourceSha: f.pair.source_sha,
      profileFingerprint: config.sourceProfileFingerprint }, now);
    const requested = { open: true, requested: true, sourceSha: row.source_sha };
    const inspectRequest = vi.fn(async () => requested), retireCloudIntent = vi.fn(async () => false), activate = vi.fn(async () => false);
    const service = createPreviewPairService({ db: f.db, config: { ...config, admissionEnabled }, source: previewPairProvenanceFixture().source,
      prepare: f.prepare, resolveController: async () => null, isMaintainer: async () => true, verifyFixtures: async () => true,
      inspectRequest, activate, readiness: previewPairReadinessAdapters(f), now: () => now,
      cleanup: { retire: async () => undefined, proveAbsent: async member => ({ machineId: member.machineId,
        providerServerId: null, exactServerAbsent: true, labeledServerIds: [], creationSettled: true,
        observedAt: new Date(now).toISOString() }) }, ...{ retireCloudIntent } });
    const saved = () => f.db.executor.selectFrom("preview_pair_cloud_intents").selectAll().where("pair_id", "=", pairId).executeTakeFirstOrThrow();
    return { pairId, row, requested, service, saved, retireCloudIntent, inspectRequest, activate, time: (value: number) => { now = value; } };
  }
  it("expires a request that never reached admission without pretending cloud retirement succeeded", async () => {
    const s = await setup(); s.time(Date.parse(s.row.expires_at));
    await s.service.reconcile({ limit: 1 });
    expect((await s.saved()).state).toBe("cleanup_pending");
    expect(s.retireCloudIntent).toHaveBeenCalledOnce();
    expect(await f.db.executor.selectFrom("user_machines").selectAll().execute()).toHaveLength(2);
    expect(f.hetzner.createServer).not.toHaveBeenCalled();
  });
  it("recovers a cancellation through the durable worker after its controller has exited", async () => {
    const s = await setup(); await stopPreviewPairCloudIntent(f.db, s.pairId, 1, 42, PAIR_NOW);
    s.retireCloudIntent.mockResolvedValue(true);
    await s.service.reconcile({ limit: 1 });
    expect((await s.saved()).state).toBe("stopped");
    expect(s.retireCloudIntent).toHaveBeenCalledOnce();
    expect((await f.db.executor.selectFrom("preview_pair_fixtures").select("active_pair_id").executeTakeFirstOrThrow()).active_pair_id).toBe(f.pair.pair_id);
  });
  it("respects cleanup backoff after hard expiry instead of probing on every pass", async () => {
    const s = await setup(); s.time(Date.parse(s.row.expires_at));
    await s.service.reconcile({ limit: 1 });
    await s.service.reconcile({ limit: 1 });
    expect(s.retireCloudIntent).toHaveBeenCalledOnce();
    expect((await s.saved()).attempt).toBe(1);
  });
  it("keeps canonical pair work progressing while an independent cloud check waits", async () => {
    const s = await setup(); await stopPreviewPairCloudIntent(f.db, s.pairId, 1, 42, PAIR_NOW);
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    s.retireCloudIntent.mockImplementation(async () => { await waiting; return false; });
    const pass = s.service.reconcile({ limit: 2 });
    try {
      await vi.waitFor(() => expect(s.retireCloudIntent).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(s.activate).toHaveBeenCalledOnce());
    } finally { release(); await pass; }
  });
  it("cancelling an inspection releases its obsolete claim and a late callback cannot postpone cleanup", async () => {
    const s = await setup(); let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    s.inspectRequest.mockImplementation(async () => { await waiting; return s.requested; });
    const pass = s.service.reconcile({ limit: 1 });
    try {
      await vi.waitFor(() => expect(s.inspectRequest).toHaveBeenCalledOnce());
      await stopPreviewPairCloudIntent(f.db, s.pairId, 1, 42, PAIR_NOW);
      expect(await s.saved()).toMatchObject({ state: "cleanup_pending", claim_id: null, claim_expires_at: null });
    } finally { release(); await pass; }
    expect(s.retireCloudIntent).not.toHaveBeenCalled();
    expect(await s.saved()).toMatchObject({ next_attempt_at: new Date(PAIR_NOW).toISOString(), claim_id: null });
  });
  it("maintenance retires an unadmitted request without waiting for its publication expiry", async () => {
    const s = await setup(false); s.retireCloudIntent.mockResolvedValue(true);
    await s.service.reconcile({ limit: 1 });
    expect((await s.saved()).state).toBe("stopped");
    expect(s.retireCloudIntent).toHaveBeenCalledOnce();
    expect(s.inspectRequest).not.toHaveBeenCalled();
  });
  it("retires an unadopted update after its parent stops without releasing the parent's fixture lease", async () => {
    const s = await setup();
    await preparePreviewPairCloudIntent(f.db, { ...f.config, sourceProfileFingerprint: "f".repeat(64) }, {
      pairId: f.pair.pair_id, generation: 2, pr: f.pair.pr, requesterId: "user_requester", controllerRunId: 42,
      sourceSha: f.pair.source_sha, profileFingerprint: "f".repeat(64) }, PAIR_NOW);
    await s.service.action(f.pair.pair_id, { type: "stop", generation: 1, revision: f.pair.revision });
    s.retireCloudIntent.mockResolvedValue(true);
    await s.service.reconcile({ limit: 1 });
    const row = await f.db.executor.selectFrom("preview_pair_cloud_intents").selectAll()
      .where("pair_id", "=", f.pair.pair_id).where("generation", "=", 2).executeTakeFirstOrThrow();
    expect(row.state).toBe("stopped");
    expect((await f.db.executor.selectFrom("preview_pair_fixtures").select("active_pair_id").executeTakeFirstOrThrow()).active_pair_id).toBe(f.pair.pair_id);
    expect(f.hetzner.createServer).not.toHaveBeenCalled();
  });
});
