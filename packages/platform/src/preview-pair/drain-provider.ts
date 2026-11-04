import type { PlatformDB, ProviderDeletionQueueRecord } from "../db.js";
import type { HetznerClient } from "../customer-vps-hetzner.js";
import { mapProviderDeletion } from "../database/user-machine-records.js";
import { retryCustomerVpsProviderDeletions } from "../customer-vps-provider-deletions.js";
import { withPreviewPairClaim, type PreviewPairClaim } from "./lifecycle.js";
import type { PreviewPairCleanupMember } from "./cleanup.js";
import { PreviewPairConflictError } from "./repository.js";

/** Drain one owned deletion per member/pass through the established consumer.
 * It never invokes broad customer reconciliation or selects a customer job. */
export function createPreviewPairProviderDrain(options: { db: PlatformDB; provider: HetznerClient; now: () => number }) {
  return async (member: PreviewPairCleanupMember, claim: PreviewPairClaim, signal: AbortSignal): Promise<void> => {
    if (!options.provider.withSignal) throw new PreviewPairConflictError();
    const provider = options.provider.withSignal(signal), { db } = options;
    async function canonical(deletion: ProviderDeletionQueueRecord) {
      signal.throwIfAborted();
      if (!Number.isSafeInteger(deletion.providerServerId) || deletion.providerServerId <= 0
        || deletion.reason !== "preview_pair_retire" || deletion.machineId !== member.machineId || deletion.handle !== member.handle
        || member.pairId !== claim.pairId || member.generation > claim.generation) throw new PreviewPairConflictError();
      await withPreviewPairClaim(db, claim, options.now(), async trx => {
        const row = await trx.executor.selectFrom("provider_deletion_queue as deletion")
          .innerJoin("preview_pair_members as member", "member.machine_id", "deletion.machine_id")
          .innerJoin("user_machines as machine", "machine.machine_id", "member.machine_id")
          .innerJoin("preview_pairs as pair", "pair.pair_id", "member.pair_id")
          .select("deletion.id").where("deletion.id", "=", deletion.id)
          .where("deletion.provider_server_id", "=", deletion.providerServerId).where("deletion.reason", "=", "preview_pair_retire")
          .where("deletion.handle", "=", member.handle).where("member.pair_id", "=", claim.pairId)
          .where("member.generation", "=", member.generation).where("member.job_id", "=", member.jobId)
          .where("member.actor_id", "=", member.actorId).where("member.handle", "=", member.handle).where("member.retired_at", "is not", null)
          .where("machine.clerk_user_id", "=", member.actorId).where("machine.handle", "=", member.handle)
          .where("machine.runtime_slot", "=", member.handle).where("machine.provisioning_class", "=", "preview")
          .where("machine.status", "=", "deleted").where("machine.deleted_at", "is not", null)
          .where("pair.state", "in", ["cleanup_pending", "updating"]).executeTakeFirst();
        if (!row) throw new PreviewPairConflictError();
      });
      const server = await provider.getServer(deletion.providerServerId);
      if (server && (server.id !== deletion.providerServerId || server.labels?.app !== "matrix-os"
        || server.labels.machine_id !== member.machineId || server.labels.clerk_user_id !== member.actorId
        || server.labels.runtime_slot !== member.handle)) throw new PreviewPairConflictError();
      signal.throwIfAborted();
      // Provider verification crossed a network boundary. Check the claim again
      // immediately before the consumer may issue its destructive call.
      await withPreviewPairClaim(db, claim, options.now(), async () => undefined);
    }
    await retryCustomerVpsProviderDeletions({ db, provider, now: () => new Date(options.now()), batchSize: 1,
      confirmAbsence: true, signal, authorize: canonical,
      select: async () => (await db.executor.selectFrom("provider_deletion_queue").selectAll()
        .where("machine_id", "=", member.machineId).where("handle", "=", member.handle).where("reason", "=", "preview_pair_retire")
        .where("completed_at", "is", null).where("next_attempt_at", "<=", new Date(options.now()).toISOString())
        .orderBy("next_attempt_at").orderBy("id").limit(1).execute()).map(mapProviderDeletion),
    });
  };
}
