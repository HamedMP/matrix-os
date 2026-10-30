import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectedPreviewPair } from "./preview-pair-projected-postgres.js";
import { PAIR_NOW } from "./preview-pair-test-support.js";
import { claimPreviewPair, requestPreviewPairStop } from "../../packages/platform/src/preview-pair/lifecycle.js";
import { cleanupPreviewPair } from "../../packages/platform/src/preview-pair/cleanup.js";
import { createPreviewPairCleanup } from "../../packages/platform/src/preview-pair/compose-cleanup.js";

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("actual two-database and provider retirement composition", () => {
  let f: Awaited<ReturnType<typeof createProjectedPreviewPair>>;
  beforeEach(async () => { f = await createProjectedPreviewPair(); }, 30_000);
  afterEach(async () => { await f?.destroy(); });
  async function setup(absent = false) {
    const servers = f.members.map((member, index) => ({ id: 1000 + index, status: "running", labels: {
      app: "matrix-os", machine_id: member.machine_id, clerk_user_id: member.actor_id, runtime_slot: member.handle,
    } }));
    f.source.hetzner.getServer = vi.fn(async id => absent ? null : servers.find(server => server.id === id) ?? null);
    f.source.hetzner.inspectServersByLabel = vi.fn(async selector => ({ complete: true,
      servers: absent ? [] : servers.filter(server => selector === `machine_id=${server.labels.machine_id}`) }));
    const current = await f.source.db.executor.selectFrom("preview_pairs").selectAll().executeTakeFirstOrThrow();
    const pending = await requestPreviewPairStop(f.source.db, current.pair_id, 1, current.revision, PAIR_NOW);
    const claim = await claimPreviewPair(f.source.db, pending.pair_id, 1, pending.revision, PAIR_NOW);
    const retireCloud = vi.fn(async () => true); // Cloud HTTP is qualified separately; no real cloud mutation here.
    const adapter = createPreviewPairCleanup({ db: f.source.db, target: f.target.db, provider: f.source.hetzner,
      retireCloud, now: () => PAIR_NOW });
    return { claim, retireCloud, adapter };
  }
  async function held() {
    const pair = await f.source.db.executor.selectFrom("preview_pairs").selectAll().executeTakeFirstOrThrow();
    expect(pair.state).toBe("cleanup_pending"); expect(pair.stopped_at).toBeNull();
    expect((await f.source.db.executor.selectFrom("preview_pair_fixtures").select("active_pair_id").executeTakeFirstOrThrow()).active_pair_id).toBe(pair.pair_id);
    const machines = await f.source.db.executor.selectFrom("user_machines").select(["status", "runtime_token_epoch"]).execute();
    expect(machines.every(machine => machine.status === "deleted" && machine.runtime_token_epoch === 2)).toBe(true);
    const queued = await f.source.db.executor.selectFrom("provider_deletion_queue").select("provider_server_id").orderBy("provider_server_id").execute();
    expect(queued.map(row => Number(row.provider_server_id))).toEqual([1000, 1001]);
  }
  it("queues both paid deletions even when one projected owner fails the actual target transaction", async () => {
    const s = await setup();
    await f.target.db.executor.updateTable("user_machines").set({ clerk_user_id: "user_unrelated" }).where("machine_id", "=", f.owner.machine_id).execute();
    await cleanupPreviewPair(f.source.db, s.claim, s.adapter, () => PAIR_NOW);
    await held(); expect(s.retireCloud).toHaveBeenCalledTimes(2);
    expect((await f.target.db.executor.selectFrom("user_machines").select(["clerk_user_id", "deleted_at"]).where("machine_id", "=", f.owner.machine_id).executeTakeFirstOrThrow())).toMatchObject({ clerk_user_id: "user_unrelated", deleted_at: null });
  });
  it("queues both paid deletions and retires target routing while cloud retirement is unavailable", async () => {
    const s = await setup(); s.retireCloud.mockRejectedValue(new Error("Fixture cloud unavailable"));
    await cleanupPreviewPair(f.source.db, s.claim, s.adapter, () => PAIR_NOW);
    await held(); expect(s.retireCloud).toHaveBeenCalledTimes(2);
    expect((await f.target.db.executor.selectFrom("user_machines").select("deleted_at").execute()).every(row => row.deleted_at !== null)).toBe(true);
  });
  it("releases the fixture only after target retirement, cloud confirmation and exact provider absence", async () => {
    const s = await setup(true);
    await cleanupPreviewPair(f.source.db, s.claim, s.adapter, () => PAIR_NOW);
    expect(s.retireCloud).toHaveBeenCalledTimes(2);
    expect((await f.source.db.executor.selectFrom("preview_pairs").select("state").executeTakeFirstOrThrow()).state).toBe("stopped");
    expect((await f.source.db.executor.selectFrom("preview_pair_fixtures").select("active_pair_id").executeTakeFirstOrThrow()).active_pair_id).toBeNull();
    expect((await f.target.db.executor.selectFrom("user_machines").select("deleted_at").execute()).every(row => row.deleted_at !== null)).toBe(true);
  });
});
