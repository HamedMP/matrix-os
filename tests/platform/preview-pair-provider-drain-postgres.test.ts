import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSeededPreviewPair } from "./preview-pair-seeded-postgres.js";
import { PAIR_NOW } from "./preview-pair-test-support.js";
import { claimPreviewPair, requestPreviewPairStop } from "../../packages/platform/src/preview-pair/lifecycle.js";
import { cleanupPreviewPair } from "../../packages/platform/src/preview-pair/cleanup.js";
import { createPreviewPairProviderCleanup } from "../../packages/platform/src/preview-pair/cleanup-provider.js";
import { createPreviewPairProviderDrain } from "../../packages/platform/src/preview-pair/drain-provider.js";
import type { HetznerClient, HetznerServer } from "../../packages/platform/src/customer-vps-hetzner.js";

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("provider deletion retains its current canonical claim", () => {
  let f: Awaited<ReturnType<typeof createSeededPreviewPair>>;
  beforeEach(async () => { f = await createSeededPreviewPair(); }, 30_000);
  afterEach(async () => { await f?.destroy(); });
  it("does not delete after the claim expires during live provider ownership verification", async () => {
    let clock = PAIR_NOW;
    const pending = await requestPreviewPairStop(f.db, f.pair.pair_id, 1, f.pair.revision, clock);
    const claim = await claimPreviewPair(f.db, pending.pair_id, 1, pending.revision, clock);
    const owner = await f.db.executor.selectFrom("preview_pair_members").selectAll().where("role", "=", "owner").executeTakeFirstOrThrow();
    const server: HetznerServer = { id: 812, status: "running", labels: { app: "matrix-os",
      machine_id: owner.machine_id, clerk_user_id: owner.actor_id, runtime_slot: owner.handle } };
    const provider: HetznerClient = { ...f.hetzner, withSignal: () => provider,
      inspectServersByLabel: async selector => ({ servers: selector === `machine_id=${owner.machine_id}` ? [server] : [], complete: true }),
      getServer: vi.fn(async id => { if (id === server.id) { clock += 120_000; return server; } return null; }) };
    const queue = createPreviewPairProviderCleanup(f.db, provider, () => clock);
    const drain = createPreviewPairProviderDrain({ db: f.db, provider, now: () => clock });
    await expect(cleanupPreviewPair(f.db, claim, {
      retire: async (member, current) => { await queue.retire(member, current); await drain(member, current, new AbortController().signal); },
      proveAbsent: queue.proveAbsent,
    }, () => clock)).rejects.toThrow("unavailable");
    expect(f.hetzner.deleteServer).not.toHaveBeenCalled();
    expect((await f.db.executor.selectFrom("preview_pair_fixtures").select("active_pair_id").executeTakeFirstOrThrow()).active_pair_id).toBe(f.pair.pair_id);
    expect((await f.db.executor.selectFrom("provider_deletion_queue").select("completed_at").executeTakeFirstOrThrow()).completed_at).toBeNull();
  });
});
