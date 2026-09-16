/**
 * VPS provider-deletion queue operations.
 *
 * Extracted from ./customer-vps.ts (Phase 1-A4). Pure move: no logic changes.
 */

import type { PlatformDB } from './db.js';
import {
  insertProviderDeletion,
  listPendingProviderDeletions,
  listRunningUserMachines,
} from './repositories/provisioning.js';
import {
  markProviderDeletionCompleted,
  markProviderDeletionFailed,
} from './repositories/releases.js';
import { getUserMachine, updateUserMachine } from './repositories/machines.js';
import { buildVpsMeta } from './customer-vps-r2.js';
import { CustomerVpsError, logCustomerVpsError } from './customer-vps-errors.js';
import { randomUUID } from 'node:crypto';
import type { createVpsPollingOperations } from './customer-vps-polling.js';
import type { HetznerClient } from './customer-vps-hetzner.js';
import type { UserMachineRecord } from './db.js';
import type { CustomerVpsServiceDeps } from './customer-vps.js';
export interface VpsDeletionOperationsDeps {
  db: PlatformDB;
  hetzner: HetznerClient;
  systemStore: CustomerVpsServiceDeps['systemStore'];
  config: CustomerVpsServiceDeps['config'];
  polling: ReturnType<typeof createVpsPollingOperations>;
  now: () => Date;
}

const PROVIDER_DELETION_RETRY_BASE_MS = 60_000;
const PROVIDER_DELETION_RETRY_MAX_MS = 60 * 60_000;

export function createVpsDeletionOperations(deletionDeps: VpsDeletionOperationsDeps) {
  const deps = deletionDeps;
  const polling = deletionDeps.polling;
  const now = deletionDeps.now;
  async function enqueueProviderDeletionTx(
    handle: PlatformDB,
    input: {
      providerServerId: number;
      reason: string;
      machineId?: string | null;
      handle?: string | null;
      detail: string;
    },
  ): Promise<string> {
    const currentTime = now().toISOString();
    const deletionId = randomUUID();
    await insertProviderDeletion(handle, {
      id: deletionId,
      providerServerId: input.providerServerId,
      reason: input.reason,
      machineId: input.machineId ?? null,
      handle: input.handle ?? null,
      nextAttemptAt: currentTime,
      createdAt: currentTime,
      lastError: input.detail,
    });
    return deletionId;
  }

  async function retryProviderDeletions(): Promise<void> {
    const pending = await listPendingProviderDeletions(
      deps.db,
      now().toISOString(),
      deps.config.reconciliationBatchSize,
    );
    for (const deletion of pending) {
      try {
        await deps.hetzner.deleteServer(deletion.providerServerId);
        if (deletion.reason === 'rejected_snapshot_recovery_clone'
          && await deps.hetzner.getServer(deletion.providerServerId)) {
          throw new Error('Provider server deletion has not completed');
        }
        await markProviderDeletionCompleted(deps.db, deletion.id, now().toISOString());
      } catch (err: unknown) {
        const attempts = deletion.attempts + 1;
        const delayMs = Math.min(
          PROVIDER_DELETION_RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 6),
          PROVIDER_DELETION_RETRY_MAX_MS,
        );
        await markProviderDeletionFailed(
          deps.db,
          deletion.id,
          attempts,
          new Date(now().getTime() + delayMs).toISOString(),
          err instanceof Error ? err.message : String(err),
        );
        logCustomerVpsError(
          `provider deletion retry failed orphanedHetznerServerId=${deletion.providerServerId} reason=${deletion.reason}`,
          err,
        );
      }
    }
  }

  async function cleanupUntrackedServersForMachine(row: UserMachineRecord): Promise<void> {
    if (!deps.hetzner.listServersByLabel) {
      logCustomerVpsError(
        `provider orphan scan unavailable machineId=${row.machineId}`,
        new Error('Hetzner label listing is not configured'),
      );
      return;
    }
    let servers: Awaited<ReturnType<NonNullable<HetznerClient['listServersByLabel']>>>;
    try {
      servers = await deps.hetzner.listServersByLabel(`machine_id=${row.machineId}`);
    } catch (err: unknown) {
      logCustomerVpsError(`provider orphan scan failed machineId=${row.machineId}`, err);
      return;
    }
    for (const server of servers) {
      try {
        await deps.hetzner.deleteServer(server.id);
      } catch (err: unknown) {
        logCustomerVpsError(`provider orphan cleanup failed orphanedHetznerServerId=${server.id}`, err);
        await polling.queueProviderDeletion({
          providerServerId: server.id,
          reason: 'stale_untracked_machine',
          machineId: row.machineId,
          handle: row.handle,
          err,
        });
      }
    }
  }

  async function retryRunningMachineMetadata(): Promise<void> {
    const rows = await listRunningUserMachines(deps.db, deps.config.reconciliationBatchSize);
    for (const row of rows) {
      try {
        await deps.systemStore.writeVpsMeta(buildVpsMeta(row, row.lastSeenAt ?? now().toISOString()));
      } catch (err: unknown) {
        logCustomerVpsError(`write vps-meta retry failed machineId=${row.machineId}`, err);
      }
    }
  }
  return { enqueueProviderDeletionTx, retryProviderDeletions,
    cleanupUntrackedServersForMachine, retryRunningMachineMetadata };
}
