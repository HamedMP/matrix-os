/**
 * VPS recovery reconciliation operations.
 *
 * Extracted from ./customer-vps.ts (Phase 1-A4). Pure move: no logic changes.
 */

import {
  CustomerVpsError,
  logCustomerVpsError,
} from './customer-vps-errors.js';
import {
  getUserMachine,
  runInPlatformTransaction,
  updateUserMachine,
} from './db.js';
import { parseNullableProviderActionId } from './db.js';
import {
  openProvisioningPayload,
  sealProvisioningPayload,
  type ProvisioningPayload,
} from './customer-vps-provisioning-jobs.js';
import { renderCloudInitTemplate } from './customer-vps-cloud-init.js';
import { hostBundleUrlForImageVersion } from './customer-vps-host-bundle.js';
import { getGoldenSnapshotRecoveryRegistrationTarget } from './golden-snapshot-repository.js';
import { releaseGoldenSnapshotLeaseInTransaction } from './golden-snapshots/leases.js';
import {
  buildHostConfig,
  buildRecoveryServerName,
} from './customer-vps-helpers.js';

import type { PlatformDB } from './db.js';
import type { HetznerClient } from './customer-vps-hetzner.js';
import type { UserMachineRecord } from './db.js';
import type { CustomerVpsServiceDeps } from './customer-vps.js';
import type { createVpsPollingOperations } from './customer-vps-polling.js';
import { DEFAULT_CLOUD_INIT_TEMPLATE } from './customer-vps-helpers.js';
export interface VpsRecoveryOperationsDeps {
  db: PlatformDB;
  hetzner: HetznerClient;
  config: CustomerVpsServiceDeps['config'];
  cloudInitTemplate: string;
  polling: ReturnType<typeof createVpsPollingOperations>;
  now: () => Date;
}

export function createVpsRecoveryOperations(recoveryDeps: VpsRecoveryOperationsDeps) {
  const deps = recoveryDeps;
  const polling = recoveryDeps.polling;
  const now = recoveryDeps.now;
  async function reconcilePendingRecoveryCreate(
    row: UserMachineRecord,
  ): Promise<'settled' | 'pending' | 'failed'> {
    if (row.status !== 'recovering') return 'settled';
    const restoreOldMachine = async (encryptedPayload: string): Promise<boolean> => {
      let payload: ProvisioningPayload;
      try {
        payload = openProvisioningPayload(encryptedPayload, deps.config.platformSecret);
      } catch (err: unknown) {
        logCustomerVpsError(`recovery rollback intent decode failed machineId=${row.machineId}`, err);
        return false;
      }
      if (!payload.recovery) return false;
      const expected = payload.recovery;
      const recoveryTarget = await getGoldenSnapshotRecoveryRegistrationTarget(deps.db, row.machineId);
      return runInPlatformTransaction(deps.db, async (trx) => {
        const current = await trx.executor.selectFrom('user_machines').select([
          'status', 'deleted_at', 'hetzner_server_id', 'recovery_create_action_id',
          'recovery_encrypted_payload',
        ]).where('machine_id', '=', row.machineId).forUpdate().executeTakeFirst();
        if (!current || current.status !== 'recovering' || current.deleted_at !== null
          || current.hetzner_server_id !== row.hetznerServerId
          || parseNullableProviderActionId(
            current.recovery_create_action_id as number | string | null,
          ) !== row.recoveryCreateActionId
          || current.recovery_encrypted_payload !== encryptedPayload) {
          return false;
        }
        await updateUserMachine(trx, row.machineId, {
          machineId: expected.oldMachineId,
          status: expected.oldStatus,
          hetznerServerId: row.recoveryOldServerId,
          publicIPv4: expected.oldPublicIPv4,
          publicIPv6: expected.oldPublicIPv6,
          imageVersion: expected.oldImageVersion,
          sourceSnapshotId: expected.oldSourceSnapshotId,
          sourceBaseGeneration: expected.oldSourceBaseGeneration,
          targetBundleVersion: expected.oldTargetBundleVersion,
          targetBundleSha256: expected.oldTargetBundleSha256,
          serverType: expected.oldServerType,
          recoveryCreateActionId: null,
          recoveryEncryptedPayload: null,
          recoveryOldServerId: null,
          recoveryOldPublicIPv4: null,
          registrationTokenHash: expected.oldRegistrationTokenHash,
          registrationTokenExpiresAt: expected.oldRegistrationTokenExpiresAt,
          provisionedAt: expected.oldProvisionedAt,
          lastSeenAt: expected.oldLastSeenAt,
          failureCode: expected.oldFailureCode,
          failureAt: expected.oldFailureAt,
        });
        if (recoveryTarget) {
          await releaseGoldenSnapshotLeaseInTransaction(trx, recoveryTarget.leaseId, now().toISOString());
        }
        return true;
      });
    };
    const registrationExpired = row.registrationTokenExpiresAt !== null
      && new Date(row.registrationTokenExpiresAt).getTime() < now().getTime();
    if (registrationExpired && row.hetznerServerId !== null && row.recoveryEncryptedPayload !== null) {
      try {
        await deps.hetzner.deleteServer(row.hetznerServerId);
        if (await deps.hetzner.getServer(row.hetznerServerId)) return 'pending';
      } catch (err: unknown) {
        logCustomerVpsError(`expired recovery replacement cleanup failed machineId=${row.machineId}`, err);
        return 'pending';
      }
      return await restoreOldMachine(row.recoveryEncryptedPayload) ? 'settled' : 'pending';
    }
    if (row.recoveryCreateActionId === null) {
      if (row.recoveryEncryptedPayload === null) return 'settled';
      let payload: ProvisioningPayload;
      try {
        payload = openProvisioningPayload(row.recoveryEncryptedPayload, deps.config.platformSecret);
      } catch (err: unknown) {
        logCustomerVpsError(`recovery intent decode failed machineId=${row.machineId}`, err);
        return 'pending';
      }
      if (!payload.recovery) return 'pending';
      const expected = payload.recovery;
      if (row.hetznerServerId !== null) {
        return 'pending';
      }
      if (!deps.hetzner.listServersByLabel) return 'pending';
      let candidates: Awaited<ReturnType<NonNullable<HetznerClient['listServersByLabel']>>>;
      try {
        candidates = await deps.hetzner.listServersByLabel(`machine_id=${row.machineId}`);
      } catch (err: unknown) {
        logCustomerVpsError(`recovery create label reconciliation failed machineId=${row.machineId}`, err);
        return 'pending';
      }
      const matches = candidates.filter((candidate) => {
        const labels = candidate.labels ?? {};
        return labels.machine_id === row.machineId
          && labels.clerk_user_id === row.clerkUserId
          && labels.runtime_slot === row.runtimeSlot
          && labels.image_source === expected.imageSource
          && (expected.sourceSnapshotId === null
            ? labels.snapshot_id === undefined
            : labels.snapshot_id === expected.sourceSnapshotId);
      });
      if (matches.length === 0 && row.registrationTokenExpiresAt !== null
        && new Date(row.registrationTokenExpiresAt).getTime() < now().getTime()) {
        await restoreOldMachine(row.recoveryEncryptedPayload);
        return 'settled';
      }
      if (matches.length !== 1) {
        if (matches.length > 1) {
          logCustomerVpsError(
            `recovery create provenance ambiguous machineId=${row.machineId}`,
            new Error('Multiple exact-labeled replacement servers'),
          );
        }
        return 'pending';
      }
      const replacement = matches[0]!;
      // A label-list response proves identity, not create-action success.
      // Keep the old VPS until the replacement itself registers healthy.
      await runInPlatformTransaction(deps.db, async (trx) => {
        await updateUserMachine(trx, row.machineId, {
          hetznerServerId: replacement.id,
          imageVersion: expected.targetBundleVersion,
          sourceSnapshotId: expected.sourceSnapshotId,
          sourceBaseGeneration: expected.sourceBaseGeneration,
          targetBundleVersion: expected.targetBundleVersion,
          targetBundleSha256: expected.targetBundleSha256,
          recoveryCreateActionId: replacement.createActionId ?? null,
          recoveryEncryptedPayload: row.recoveryEncryptedPayload,
          recoveryOldServerId: row.recoveryOldServerId,
          provisionedAt: now().toISOString(),
          lastSeenAt: null,
        });
      });
      return 'pending';
    }
    let action;
    try {
      action = await deps.hetzner.getAction(row.recoveryCreateActionId);
    } catch (err: unknown) {
      logCustomerVpsError(
        `recovery create action reconciliation failed actionId=${row.recoveryCreateActionId}`,
        err,
      );
      return 'pending';
    }
    if (!action || action.status === 'running') return 'pending';
    const at = now().toISOString();
    if (action.status === 'success') {
      await runInPlatformTransaction(deps.db, async (trx) => {
        await updateUserMachine(trx, row.machineId, {
          recoveryCreateActionId: null,
          recoveryEncryptedPayload: row.recoveryEncryptedPayload,
          recoveryOldServerId: row.recoveryOldServerId,
        });
      });
      return 'pending';
    }

    if (row.hetznerServerId === null || !await polling.removeRejectedRecoveryServer({
      serverId: row.hetznerServerId,
      machineId: row.machineId,
      handle: row.handle,
    })) {
      return 'pending';
    }

    const recoveryTarget = await getGoldenSnapshotRecoveryRegistrationTarget(deps.db, row.machineId);
    if (row.sourceSnapshotId !== null && row.recoveryEncryptedPayload !== null) {
      try {
        const payload = openProvisioningPayload(row.recoveryEncryptedPayload, deps.config.platformSecret);
        if (!payload.recovery) throw new Error('Recovery intent is missing durable provenance');
        const imageVersion = row.targetBundleVersion ?? row.imageVersion ?? deps.config.imageVersion;
        const fallbackRegistrationExpiresAt = new Date(Math.max(
          row.registrationTokenExpiresAt === null
            ? 0
            : new Date(row.registrationTokenExpiresAt).getTime(),
          now().getTime() + deps.config.registrationTokenTtlMs,
        )).toISOString();
        const hostConfig = buildHostConfig(
          deps.config,
          {
            clerkUserId: row.clerkUserId,
            handle: row.handle,
            runtimeSlot: row.runtimeSlot,
            developerTools: row.developerTools,
          },
          row.machineId,
          payload.registrationToken,
          fallbackRegistrationExpiresAt,
          payload.postgresPassword,
          {
            imageVersion,
            hostBundleUrl: hostBundleUrlForImageVersion(deps.config, imageVersion),
          },
        );
        const cleanRecoveryPayload = sealProvisioningPayload({
          registrationToken: payload.registrationToken,
          postgresPassword: payload.postgresPassword,
          recovery: {
            ...payload.recovery,
            imageSource: 'clean_image',
            sourceSnapshotId: null,
            sourceBaseGeneration: null,
          },
        }, deps.config.platformSecret);
        const transitioned = await runInPlatformTransaction(deps.db, async (trx) => {
          const claimed = await trx.executor.updateTable('user_machines').set({
            hetzner_server_id: null,
            public_ipv4: null,
            public_ipv6: null,
            source_snapshot_id: null,
            source_base_generation: null,
            recovery_create_action_id: null,
            recovery_encrypted_payload: cleanRecoveryPayload,
            registration_token_expires_at: fallbackRegistrationExpiresAt,
          }).where('machine_id', '=', row.machineId)
            .where('status', '=', 'recovering')
            .where('deleted_at', 'is', null)
            .where('hetzner_server_id', '=', row.hetznerServerId)
            .where('source_snapshot_id', '=', row.sourceSnapshotId)
            .where('recovery_create_action_id', '=', row.recoveryCreateActionId)
            .where('recovery_encrypted_payload', '=', row.recoveryEncryptedPayload)
            .returning('machine_id').executeTakeFirst();
          if (!claimed) return false;
          if (recoveryTarget) {
            await releaseGoldenSnapshotLeaseInTransaction(trx, recoveryTarget.leaseId, at);
          }
          return true;
        });
        if (!transitioned) return 'pending';
        let cleanServer;
        try {
          cleanServer = await deps.hetzner.createServer({
            name: buildRecoveryServerName(row.handle, row.machineId),
            serverType: row.serverType ?? deps.config.serverType,
            location: row.location ?? deps.config.location,
            userData: renderCloudInitTemplate(
              deps.cloudInitTemplate ?? DEFAULT_CLOUD_INIT_TEMPLATE,
              {
                ...hostConfig,
                imageSource: 'clean_image',
                targetBundleSha256: row.targetBundleSha256 ?? '',
                snapshotSourceVersion: '',
              },
            ),
            labels: {
              app: 'matrix-os', clerk_user_id: row.clerkUserId, runtime_slot: row.runtimeSlot,
              machine_id: row.machineId, image_source: 'clean_image',
            },
          });
        } catch (err: unknown) {
          logCustomerVpsError(`recovery clean fallback create ambiguous machineId=${row.machineId}`, err);
          return 'pending';
        }
        const persisted = await runInPlatformTransaction(deps.db, async (trx) => {
          const updated = await trx.executor.updateTable('user_machines').set({
            hetzner_server_id: cleanServer.id,
            public_ipv4: cleanServer.publicIPv4,
            public_ipv6: cleanServer.publicIPv6,
            source_snapshot_id: null,
            source_base_generation: null,
            recovery_create_action_id: cleanServer.createActionId ?? null,
            recovery_encrypted_payload: cleanRecoveryPayload,
            recovery_old_server_id: row.recoveryOldServerId,
          }).where('machine_id', '=', row.machineId)
            .where('status', '=', 'recovering')
            .where('deleted_at', 'is', null)
            .where('hetzner_server_id', 'is', null)
            .where('source_snapshot_id', 'is', null)
            .where('recovery_create_action_id', 'is', null)
            .where('recovery_encrypted_payload', '=', cleanRecoveryPayload)
            .where('registration_token_expires_at', '=', fallbackRegistrationExpiresAt)
            .returning('machine_id').executeTakeFirst();
          return updated !== undefined;
        });
        if (!persisted) {
          const current = await getUserMachine(deps.db, row.machineId);
          if (current?.status === 'recovering' && current.hetznerServerId === cleanServer.id) {
            return 'pending';
          }
          try {
            await deps.hetzner.deleteServer(cleanServer.id);
            if (await deps.hetzner.getServer(cleanServer.id)) {
              throw new Error('Unclaimed recovery fallback server deletion has not completed');
            }
          } catch (cleanupErr: unknown) {
            logCustomerVpsError('unclaimed recovery fallback cleanup failed', cleanupErr);
            await polling.queueProviderDeletion({
              providerServerId: cleanServer.id,
              reason: 'unclaimed_recovery_fallback',
              machineId: row.machineId,
              handle: row.handle,
              err: cleanupErr,
            });
          }
          return 'pending';
        }
        // Provider creation only proves that a replacement exists. Keep the
        // predecessor endpoint and server until authenticated registration
        // atomically activates the replacement and enqueues old-server cleanup.
        return 'pending';
      } catch (err: unknown) {
        logCustomerVpsError(`recovery clean fallback failed machineId=${row.machineId}`, err);
      }
    }

    if (row.recoveryEncryptedPayload !== null
      && await restoreOldMachine(row.recoveryEncryptedPayload)) {
      return 'settled';
    }

    await runInPlatformTransaction(deps.db, async (trx) => {
      await updateUserMachine(trx, row.machineId, {
        status: 'failed',
        failureCode: 'provider_unavailable',
        failureAt: at,
        recoveryCreateActionId: null,
        recoveryEncryptedPayload: null,
      });
      if (recoveryTarget) {
        await releaseGoldenSnapshotLeaseInTransaction(trx, recoveryTarget.leaseId, at);
      }
    });
    return 'failed';
  }

  // Enqueues a provider-server deletion on the given transaction-or-db handle.
  // Unlike queueProviderDeletion, this propagates insert failures so a caller
  // can keep the status change and the deletion enqueue in one atomic unit —
  // if the enqueue fails the whole transaction rolls back and the machine is
  // retried on the next reconciler pass instead of orphaning its server.
  return { reconcilePendingRecoveryCreate };
}
