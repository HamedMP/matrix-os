import type { Kysely } from "kysely";
import { createSeededPreviewPair } from "./preview-pair-seeded-postgres.js";
import { createIsolatedPreviewPairDatabase } from "./preview-pair-isolated-postgres.js";
import { PAIR_NOW } from "./preview-pair-test-support.js";
import { claimPreviewPair, requestPreviewPairStop } from "../../packages/platform/src/preview-pair/lifecycle.js";
import { readPreviewPairProjection, writePreviewPairProjection, reconcilePreviewPairProjection, retirePreviewPairProjection } from "../../packages/platform/src/preview-pair/projection.js";
import { createCustomerVpsService } from "../../packages/platform/src/customer-vps.js";
import { openProvisioningPayload } from "../../packages/platform/src/customer-vps-provisioning-jobs.js";
import { createTestConfig } from "./customer-vps-service-test-helper.js";
import { createMockCustomerVpsSystemStore } from "./customer-vps-fixtures.js";
import { bootstrapPlatformCollaborationDatabase, type CollaborationPlatformDatabase } from "../../packages/platform/src/collaboration/database.js";
import { bootstrapPlatformRuntimeEndpointDatabase, type RuntimeEndpointPlatformDatabase } from "../../packages/platform/src/collaboration/runtime-endpoints.js";

/** Actual admission, projection, registration and two databases. Provider IDs are synthetic;
 * this does not exercise paid provisioning, Clerk login or the customer sharing journey. */
export async function createProjectedPreviewPair(addresses: readonly [string, string] = ["203.0.113.10", "203.0.113.11"], hostBundleSha256?: string) {
  const previewSecret = "isolated-preview-" + "p".repeat(40);
  const controlSecret = "isolated-control-" + "c".repeat(40);
  const source = await createSeededPreviewPair({ platformSecret: controlSecret }, hostBundleSha256);
  let target: Awaited<ReturnType<typeof createIsolatedPreviewPairDatabase>> | undefined;
  try {
    target = await createIsolatedPreviewPairDatabase();
    const members = await source.db.executor.selectFrom("preview_pair_members").selectAll().orderBy("role").execute();
    for (const [i, member] of members.entries()) await source.db.executor.updateTable("user_machines")
      .set({ hetzner_server_id: 1000 + i, public_ipv4: addresses[i] }).where("machine_id", "=", member.machine_id).execute();
    const claim = await claimPreviewPair(source.db, source.pair.pair_id, 1, 1, PAIR_NOW);
    await writePreviewPairProjection(target.db, await readPreviewPairProjection(source.db, claim, () => PAIR_NOW));
    const service = createCustomerVpsService({ db: target.db, config: createTestConfig({ platformSecret: previewSecret }),
      hetzner: source.hetzner, systemStore: createMockCustomerVpsSystemStore(), now: () => new Date(PAIR_NOW) });
    for (const [i, member] of members.entries()) {
      const job = await source.db.executor.selectFrom("provisioning_jobs").selectAll().where("job_id", "=", member.job_id).executeTakeFirstOrThrow();
      const token = openProvisioningPayload(job.encrypted_payload!, controlSecret).registrationToken;
      await service.register(token, { machineId: member.machine_id, hetznerServerId: 1000 + i, publicIPv4: addresses[i],
        imageVersion: source.candidate.hostBundleVersion, bundleSha256: source.candidate.hostBundleSha256, healthy: true });
    }
    await reconcilePreviewPairProjection(source.db, target.db, claim, () => PAIR_NOW);
    const destination = target;
    const collaborationDb = destination.db.kysely as unknown as Kysely<CollaborationPlatformDatabase & RuntimeEndpointPlatformDatabase>;
    await bootstrapPlatformCollaborationDatabase(collaborationDb);
    await bootstrapPlatformRuntimeEndpointDatabase(collaborationDb);
    const owner = members.find(member => member.role === "owner")!;
    let cleanupClaim: typeof claim | undefined;
    return { source, target: destination, members, owner, previewSecret, controlSecret,
      collaborationDb,
      async retire() {
        if (!cleanupClaim) {
          const pending = await requestPreviewPairStop(source.db, source.pair.pair_id, 1, claim.revision, PAIR_NOW);
          cleanupClaim = await claimPreviewPair(source.db, pending.pair_id, 1, pending.revision, PAIR_NOW);
        }
        await retirePreviewPairProjection(source.db, destination.db, { pairId: source.pair.pair_id, generation: 1,
          machineId: owner.machine_id, actorId: owner.actor_id, handle: owner.handle, jobId: owner.job_id, providerServerId: 1001 }, cleanupClaim, () => PAIR_NOW);
      },
      async destroy() { try { await destination.destroy(); } finally { await source.destroy(); } },
    };
  } catch (error: unknown) { try { await target?.destroy(); } finally { await source.destroy(); } throw error; }
}
