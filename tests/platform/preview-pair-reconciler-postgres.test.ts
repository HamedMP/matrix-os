import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSeededPreviewPair } from "./preview-pair-seeded-postgres.js";
import { readyPreviewPair, previewPairReadinessAdapters } from "./preview-pair-ready-postgres.js";
import { PAIR_NOW } from "./preview-pair-test-support.js";
import { requestPreviewPairStop } from "../../packages/platform/src/preview-pair/lifecycle.js";
import { createPreviewPairReconciler } from "../../packages/platform/src/preview-pair/reconciler.js";

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("durable pair orchestration uses real claims around external stages", () => {
  let fixture: Awaited<ReturnType<typeof createSeededPreviewPair>>;
  beforeEach(async () => { fixture = await createSeededPreviewPair(); }, 30_000);
  afterEach(async () => { await fixture?.destroy(); });
  function setup(at = PAIR_NOW) {
    const activate = vi.fn<Parameters<typeof createPreviewPairReconciler>[0]["activate"]>(async () => false);
    const inspectRequest = vi.fn(async () => ({ open: true, requested: true, sourceSha: fixture.pair.source_sha }));
    const reconciler = createPreviewPairReconciler({ db: fixture.db, config: fixture.config, prepare: fixture.prepare,
      verifyFixtures: async () => true, activate, inspectRequest, readiness: previewPairReadinessAdapters(fixture),
      cleanup: { retire: async () => undefined, proveAbsent: async member => ({ machineId: member.machineId,
        providerServerId: null, exactServerAbsent: true, labeledServerIds: [], creationSettled: true,
        observedAt: new Date(at).toISOString() }) }, now: () => at });
    return { reconciler, activate, inspectRequest };
  }
  it("a pending infrastructure stage releases its claim and schedules bounded recovery", async () => {
    const { reconciler, activate } = setup();
    const row = await reconciler.run(fixture.pair.pair_id, 1, 1);
    expect(row.state).toBe("preparing"); expect(row.claim_id).toBeNull();
    expect(Date.parse(row.next_attempt_at!)).toBeGreaterThan(PAIR_NOW);
    expect(activate).toHaveBeenCalledTimes(1);
  });
  it("a bounded activation timeout preserves pending provisioning and resumes on a later pass", async () => {
    const { reconciler, activate } = setup();
    const entered = Promise.withResolvers<void>();
    let activationSignal: AbortSignal | undefined;
    activate.mockImplementation(async (_context, _claim, signal) => {
      activationSignal = signal;
      entered.resolve();
      return new Promise<boolean>(() => undefined);
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let row: Awaited<ReturnType<typeof reconciler.run>>;
    try {
      const running = reconciler.run(fixture.pair.pair_id, 1, 1);
      await entered.promise;
      await vi.advanceTimersByTimeAsync(10_001);
      row = await running;
    } finally { vi.useRealTimers(); }
    expect(activationSignal?.aborted).toBe(true);
    expect(row!.state).toBe("preparing");
    expect(row!.claim_id).toBeNull();
    expect(row!.failure_code).toBeNull();
    expect(Date.parse(row!.next_attempt_at!)).toBe(PAIR_NOW + 15_000);
    activate.mockResolvedValue(false);
    expect((await reconciler.run(row!.pair_id, row!.generation, row!.revision)).state).toBe("preparing");
    expect(activate).toHaveBeenCalledTimes(2);
  });
  it("successful infrastructure activation is followed by actual canonical readiness", async () => {
    const { reconciler, activate } = setup();
    activate.mockImplementation(async () => { await fixture.db.executor.updateTable("user_machines").set({ status: "running" }).execute(); return true; });
    expect((await reconciler.run(fixture.pair.pair_id, 1, 1)).state).toBe("ready");
  });
  it("a ready pair is observed without provisioning again", async () => {
    await readyPreviewPair(fixture); const { reconciler, activate } = setup();
    const row = await fixture.db.executor.selectFrom("preview_pairs").selectAll().executeTakeFirstOrThrow();
    expect((await reconciler.run(row.pair_id, 1, row.revision)).state).toBe("ready");
    expect(activate).not.toHaveBeenCalled();
  });
  it("PR close queues cleanup before any new infrastructure effects", async () => {
    const { reconciler, activate, inspectRequest } = setup(); inspectRequest.mockResolvedValue({ open: false, requested: true, sourceSha: fixture.pair.source_sha });
    expect((await reconciler.run(fixture.pair.pair_id, 1, 1)).state).toBe("cleanup_pending");
    expect(activate).not.toHaveBeenCalled();
  });
  it("hard expiry does not depend on a reachable GitHub service", async () => {
    const { reconciler, activate, inspectRequest } = setup(PAIR_NOW + 72 * 3_600_000);
    inspectRequest.mockRejectedValue(new Error("unavailable"));
    expect((await reconciler.run(fixture.pair.pair_id, 1, 1)).state).toBe("cleanup_pending");
    expect(inspectRequest).not.toHaveBeenCalled(); expect(activate).not.toHaveBeenCalled();
  });
  it("an expired pair proceeds from cleanup-pending to physical retirement instead of re-stopping forever", async () => {
    const { reconciler } = setup(PAIR_NOW + 72 * 3_600_000);
    const pending = await reconciler.run(fixture.pair.pair_id, 1, 1);
    const retired = await reconciler.run(pending.pair_id, pending.generation, pending.revision);
    expect(retired.state).toBe("stopped");
    expect((await fixture.db.executor.selectFrom("preview_pair_fixtures").selectAll().executeTakeFirstOrThrow()).active_pair_id).toBeNull();
  });
  it("a late activation completion cannot overwrite a stop", async () => {
    const { reconciler, activate } = setup(); const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    activate.mockImplementation(async () => { entered.resolve(); await release.promise; return true; });
    const running = reconciler.run(fixture.pair.pair_id, 1, 1);
    await entered.promise;
    const claimed = await fixture.db.executor.selectFrom("preview_pairs").selectAll().executeTakeFirstOrThrow();
    await requestPreviewPairStop(fixture.db, claimed.pair_id, 1, claimed.revision, PAIR_NOW);
    release.resolve(); await running;
    expect((await fixture.db.executor.selectFrom("preview_pairs").selectAll().executeTakeFirstOrThrow()).state).toBe("cleanup_pending");
  });
});
