import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSeededPreviewPair } from "./preview-pair-seeded-postgres.js";
import { PAIR_NOW } from "./preview-pair-test-support.js";
import { claimPreviewPair, requestPreviewPairStop } from "../../packages/platform/src/preview-pair/lifecycle.js";
import { createPreviewPairProviderCleanup } from "../../packages/platform/src/preview-pair/cleanup-provider.js";
import type { PreviewPairCleanupMember } from "../../packages/platform/src/preview-pair/cleanup.js";

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("actual provider inspection and durable deletion adapter", () => {
  let fixture: Awaited<ReturnType<typeof createSeededPreviewPair>>;
  beforeEach(async () => { fixture = await createSeededPreviewPair(); }, 30_000);
  afterEach(async () => { await fixture?.destroy(); });
  async function setup() {
    const row = await requestPreviewPairStop(fixture.db, fixture.pair.pair_id, 1, 1, PAIR_NOW);
    const claim = await claimPreviewPair(fixture.db, row.pair_id, 1, row.revision, PAIR_NOW);
    const binding = await fixture.db.executor.selectFrom("preview_pair_members").selectAll().where("role", "=", "owner").executeTakeFirstOrThrow();
    const member: PreviewPairCleanupMember = { pairId: row.pair_id, generation: 1,
      machineId: binding.machine_id, jobId: binding.job_id, handle: binding.handle,
      actorId: binding.actor_id, providerServerId: null };
    fixture.hetzner.getServer = vi.fn(async () => null);
    fixture.hetzner.inspectServersByLabel = vi.fn(async () => ({ servers: [], complete: true }));
    return { claim, member, adapter: createPreviewPairProviderCleanup(fixture.db, fixture.hetzner, () => PAIR_NOW) };
  }
  it("proves absence only from a complete label inventory and settled creation", async () => {
    const { claim, member, adapter } = await setup();
    expect(await adapter.proveAbsent(member, claim)).toMatchObject({ machineId: member.machineId,
      exactServerAbsent: true, labeledServerIds: [], creationSettled: true });
    fixture.hetzner.inspectServersByLabel = vi.fn(async () => ({ servers: [], complete: false }));
    expect(await adapter.proveAbsent(member, claim)).toMatchObject({ creationSettled: false });
  });
  it("does not equate a stale creation lease or unknown create action with settled absence", async () => {
    const { claim, member, adapter } = await setup();
    await fixture.db.executor.updateTable("provisioning_jobs").set({ status: "running", lease_expires_at: new Date(PAIR_NOW + 120_000).toISOString() })
      .where("job_id", "=", member.jobId).execute();
    expect(await adapter.proveAbsent(member, claim)).toMatchObject({ creationSettled: false });
    await fixture.db.executor.updateTable("provisioning_jobs").set({ status: "failed", lease_expires_at: null, activation_step: "creating" })
      .where("job_id", "=", member.jobId).execute();
    expect(await adapter.proveAbsent(member, claim)).toMatchObject({ creationSettled: false });
  });
  it("queues exact labeled orphans idempotently through the existing deletion queue", async () => {
    const { claim, member, adapter } = await setup();
    fixture.hetzner.inspectServersByLabel = vi.fn(async () => ({ complete: true, servers: [{ id: 123, status: "running",
      labels: { app: "matrix-os", machine_id: member.machineId, clerk_user_id: member.actorId, runtime_slot: member.handle } }] }));
    await adapter.retire(member, claim); await adapter.retire(member, claim);
    const queued = await fixture.db.executor.selectFrom("provider_deletion_queue").selectAll().execute();
    expect(queued).toHaveLength(1);
    expect(queued[0]!.provider_server_id).toBe(123);
    expect(fixture.hetzner.deleteServer).not.toHaveBeenCalled();
    expect(await adapter.proveAbsent(member, claim)).toMatchObject({ labeledServerIds: [123] });
  });
  it("refuses a mismatched labeled server and never queues an unrelated customer resource", async () => {
    const { claim, member, adapter } = await setup();
    fixture.hetzner.inspectServersByLabel = vi.fn(async () => ({ complete: true, servers: [{ id: 123, status: "running", labels: { machine_id: "unrelated" } }] }));
    await expect(adapter.retire(member, claim)).rejects.toThrow("unavailable");
    expect(await fixture.db.executor.selectFrom("provider_deletion_queue").selectAll().execute()).toHaveLength(0);
  });
});
