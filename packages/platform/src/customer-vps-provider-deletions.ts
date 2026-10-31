import { listPendingProviderDeletions, markProviderDeletionCompleted, markProviderDeletionFailed,
  type PlatformDB, type ProviderDeletionQueueRecord } from "./db.js";
import type { HetznerClient } from "./customer-vps-hetzner.js";
import { logCustomerVpsError } from "./customer-vps-errors.js";
import { PROVIDER_DELETION_RETRY_BASE_MS, PROVIDER_DELETION_RETRY_MAX_MS } from "./customer-vps-support.js";

/** Shared durable queue consumer. Pair callers supply a strictly bounded owned
 * selection and canonical authorization; ordinary reconciliation stays unchanged. */
export async function retryCustomerVpsProviderDeletions(options: {
  db: PlatformDB; provider: HetznerClient; now: () => Date; batchSize: number;
  select?: () => Promise<ProviderDeletionQueueRecord[]>;
  authorize?: (deletion: ProviderDeletionQueueRecord) => Promise<void>;
  confirmAbsence?: boolean; signal?: AbortSignal;
}): Promise<void> {
  const { db, provider, now } = options;
  const pending = options.select ? await options.select() : await listPendingProviderDeletions(db, now().toISOString(), options.batchSize);
  if (pending.length > options.batchSize) throw new Error("Provider deletion batch exceeds its bound");
  for (const deletion of pending) {
    try {
      options.signal?.throwIfAborted();
      await options.authorize?.(deletion);
      await provider.deleteServer(deletion.providerServerId);
      if ((options.confirmAbsence || deletion.reason === "rejected_snapshot_recovery_clone")
        && await provider.getServer(deletion.providerServerId)) throw new Error("Provider server deletion has not completed");
      await options.authorize?.(deletion);
      await markProviderDeletionCompleted(db, deletion.id, now().toISOString());
    } catch (error: unknown) {
      if (options.signal?.aborted) throw error;
      const attempts = deletion.attempts + 1;
      const delay = Math.min(PROVIDER_DELETION_RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 6), PROVIDER_DELETION_RETRY_MAX_MS);
      await markProviderDeletionFailed(db, deletion.id, attempts, new Date(now().getTime() + delay).toISOString(),
        error instanceof Error ? error.message : String(error));
      logCustomerVpsError(`provider deletion retry failed orphanedHetznerServerId=${deletion.providerServerId} reason=${deletion.reason}`, error);
    }
  }
}
