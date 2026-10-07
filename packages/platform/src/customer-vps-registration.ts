/** Customer VPS registration, split from customer-vps.ts. */
import { sql } from 'kysely';
import { completeUserMachineRegistration, getUserMachine, runInPlatformTransaction } from './db.js';
import { registrationTokenMatches } from './customer-vps-auth.js';
import { CustomerVpsError, logCustomerVpsError } from './customer-vps-errors.js';
import { buildVpsMeta } from './customer-vps-r2.js';
import { PublicIPv4Schema, type RegisterRequest } from './customer-vps-schema.js';
import {
  completeProvisioningJob,
  getProvisioningJobByMachineId,
} from './customer-vps-provisioning-jobs.js';
import { markPrebillingIntentReady } from './prebilling-provisioning-store.js';
import {
  getGoldenSnapshot,
  getGoldenSnapshotRecoveryRegistrationTarget,
  releaseGoldenSnapshotLeaseInTransaction,
} from './golden-snapshot-repository.js';
import type { RegisterResponse } from './customer-vps-types.js';
import type { CustomerVpsContext } from './customer-vps-context.js';

/** Accepts a provisioned server's registration and marks its machine running. */
export function createCustomerVpsRegistration(context: CustomerVpsContext) {
  const { deps, now, enqueueProviderDeletionTx } = context;

  async function register(token: string | undefined, input: RegisterRequest): Promise<RegisterResponse> {
    const publicIPv4 = PublicIPv4Schema.safeParse(input.publicIPv4);
    if (!publicIPv4.success) {
      throw new CustomerVpsError(400, 'invalid_state', 'Invalid request');
    }
    const row = await getUserMachine(deps.db, input.machineId);
    if (!row) {
      throw new CustomerVpsError(404, 'not_found', 'Machine not found');
    }
    if (row.status === 'running') {
      throw new CustomerVpsError(409, 'already_registered', 'Machine already registered');
    }
    if (row.status !== 'provisioning' && row.status !== 'recovering') {
      throw new CustomerVpsError(409, 'invalid_state', 'Machine cannot register');
    }
    if (row.hetznerServerId !== input.hetznerServerId) {
      throw new CustomerVpsError(401, 'registration_rejected', 'Registration rejected');
    }
    if (!row.registrationTokenExpiresAt || new Date(row.registrationTokenExpiresAt).getTime() < now().getTime()) {
      throw new CustomerVpsError(401, 'registration_rejected', 'Registration rejected');
    }
    const expectedRegistrationTokenHash = row.registrationTokenHash;
    if (!expectedRegistrationTokenHash || !registrationTokenMatches(token, expectedRegistrationTokenHash)) {
      throw new CustomerVpsError(401, 'registration_rejected', 'Registration rejected');
    }
    const provisioningJob = row.status === 'provisioning'
      ? await getProvisioningJobByMachineId(deps.db, input.machineId)
      : undefined;
    const recoveryTarget = row.status === 'recovering'
      ? await getGoldenSnapshotRecoveryRegistrationTarget(deps.db, input.machineId)
      : undefined;
    const persistedRecoveryTarget = row.status === 'recovering'
      && row.sourceSnapshotId !== null
      && row.sourceBaseGeneration !== null
      && row.targetBundleVersion !== null
      && row.targetBundleSha256 !== null
      ? {
          snapshotId: row.sourceSnapshotId,
          baseGeneration: row.sourceBaseGeneration,
          targetBundleVersion: row.targetBundleVersion,
          targetBundleSha256: row.targetBundleSha256,
        }
      : undefined;
    let sourceSnapshotId: string | null = persistedRecoveryTarget?.snapshotId ?? recoveryTarget?.snapshotId ?? null;
    let sourceBaseGeneration: string | null = persistedRecoveryTarget?.baseGeneration ?? recoveryTarget?.baseGeneration ?? null;
    let registrationTarget: { targetBundleVersion: string; targetBundleSha256: string } | undefined =
      row.targetBundleVersion !== null && row.targetBundleSha256 !== null
        ? {
            targetBundleVersion: row.targetBundleVersion,
            targetBundleSha256: row.targetBundleSha256,
          }
        : persistedRecoveryTarget ?? recoveryTarget;
    if (!registrationTarget && provisioningJob?.imageSource === 'snapshot') {
      if (provisioningJob.targetBundleVersion === null || provisioningJob.targetBundleSha256 === null) {
        throw new CustomerVpsError(409, 'registration_rejected', 'Registration rejected');
      }
      if (provisioningJob.snapshotId === null) {
        throw new CustomerVpsError(409, 'registration_rejected', 'Registration rejected');
      }
      const sourceSnapshot = await getGoldenSnapshot(deps.db, provisioningJob.snapshotId);
      if (!sourceSnapshot || sourceSnapshot.state !== 'ready') {
        throw new CustomerVpsError(409, 'registration_rejected', 'Registration rejected');
      }
      sourceSnapshotId = sourceSnapshot.snapshotId;
      sourceBaseGeneration = sourceSnapshot.compatibility.baseGeneration;
      registrationTarget = {
        targetBundleVersion: provisioningJob.targetBundleVersion,
        targetBundleSha256: provisioningJob.targetBundleSha256,
      };
    }
    if (!registrationTarget
      && provisioningJob?.targetBundleVersion !== null
      && provisioningJob?.targetBundleVersion !== undefined
      && provisioningJob.targetBundleSha256 !== null) {
      registrationTarget = {
        targetBundleVersion: provisioningJob.targetBundleVersion,
        targetBundleSha256: provisioningJob.targetBundleSha256,
      };
    }
    // Preserve the pre-feature clean-image contract while snapshots are disabled,
    // but never let its unknown-digest sentinel authorize snapshot-era routing.
    if (registrationTarget
      && (deps.config.goldenSnapshots.enabled
        || registrationTarget.targetBundleSha256 !== '0'.repeat(64))
      && (registrationTarget.targetBundleSha256 === '0'.repeat(64)
        || input.imageVersion !== registrationTarget.targetBundleVersion
        || input.bundleSha256 !== registrationTarget.targetBundleSha256
        || input.healthy !== true)) {
      throw new CustomerVpsError(409, 'registration_rejected', 'Registration rejected');
    }
    const lastSeenAt = now().toISOString();
    const updated = await runInPlatformTransaction(deps.db, async (trx) => {
      const snapshotLeaseId = provisioningJob?.snapshotLeaseId ?? recoveryTarget?.leaseId;
      if (sourceSnapshotId !== null) {
        if (sourceBaseGeneration === null) {
          throw new CustomerVpsError(409, 'registration_rejected', 'Registration rejected');
        }
        await sql`SELECT pg_advisory_xact_lock(hashtext(${sourceBaseGeneration}))`
          .execute(trx.executor);
        const readySource = await trx.executor.selectFrom('golden_snapshots').select('snapshot_id')
          .where('snapshot_id', '=', sourceSnapshotId).where('state', '=', 'ready')
          .forUpdate().executeTakeFirst();
        if (!readySource) {
          throw new CustomerVpsError(409, 'registration_rejected', 'Registration rejected');
        }
      }
      if (sourceSnapshotId !== null && snapshotLeaseId) {
        const createIntent = await trx.executor.selectFrom('golden_snapshot_create_intents').selectAll()
          .where('lease_id', '=', snapshotLeaseId).forUpdate().executeTakeFirst();
        if (!createIntent || createIntent.state === 'denied') {
          throw new CustomerVpsError(409, 'registration_rejected', 'Registration rejected');
        }
        if (createIntent.state !== 'activated') {
          const activation = await trx.executor.updateTable('golden_snapshot_create_intents').set({
            state: 'activated', updated_at: lastSeenAt, completed_at: lastSeenAt,
          }).where('intent_id', '=', createIntent.intent_id)
            .where('state', 'in', ['pending', 'accepted'])
            .returning('intent_id').executeTakeFirst();
          if (!activation) {
            throw new CustomerVpsError(409, 'registration_rejected', 'Registration rejected');
          }
        }
      }
      const registered = await completeUserMachineRegistration(
        trx,
        input.machineId,
        input.hetznerServerId,
        expectedRegistrationTokenHash,
        lastSeenAt,
        {
          status: 'running',
          publicIPv4: input.publicIPv4,
          publicIPv6: input.publicIPv6,
          imageVersion: input.imageVersion,
          sourceSnapshotId,
          sourceBaseGeneration,
          targetBundleVersion: registrationTarget?.targetBundleVersion
            ?? provisioningJob?.targetBundleVersion
            ?? input.imageVersion,
          targetBundleSha256: registrationTarget?.targetBundleSha256
            ?? provisioningJob?.targetBundleSha256
            ?? input.bundleSha256
            ?? null,
          recoveryCreateActionId: null,
          recoveryEncryptedPayload: null,
          recoveryOldServerId: null,
          recoveryOldPublicIPv4: null,
          lastSeenAt,
          registrationTokenHash: null,
          registrationTokenExpiresAt: null,
          failureCode: null,
          failureAt: null,
        },
      );
      if (!registered) {
        const current = await getUserMachine(trx, input.machineId);
        if (current?.status === 'running' && current.registrationTokenHash === null) {
          throw new CustomerVpsError(409, 'already_registered', 'Machine already registered');
        }
        throw new CustomerVpsError(409, 'invalid_state', 'Machine cannot register');
      }
      if (row.prebillingIntentId) {
        const markedReady = await markPrebillingIntentReady(trx, {
          intentId: row.prebillingIntentId,
          machineId: row.machineId,
          clerkUserId: row.clerkUserId,
          runtimeSlot: row.runtimeSlot,
          now: lastSeenAt,
        });
        if (!markedReady) {
          throw new CustomerVpsError(409, 'registration_rejected', 'Registration rejected');
        }
      }
      if (row.recoveryOldServerId !== null) {
        await enqueueProviderDeletionTx(trx, {
          providerServerId: row.recoveryOldServerId,
          reason: 'recover_old_server',
          machineId: row.machineId,
          handle: row.handle,
          detail: 'recovery replacement registered before create-action reconciliation',
        });
      }
      if (recoveryTarget) {
        await releaseGoldenSnapshotLeaseInTransaction(trx, recoveryTarget.leaseId, lastSeenAt);
      }
      if (provisioningJob?.snapshotLeaseId) {
        await releaseGoldenSnapshotLeaseInTransaction(trx, provisioningJob.snapshotLeaseId, lastSeenAt);
      }
      if (provisioningJob?.status === 'running') {
        const completed = await completeProvisioningJob(trx, provisioningJob.jobId, lastSeenAt);
        if (!completed) throw new Error('Provisioning job registration completion lost its lease');
      }
      await trx.executor.updateTable('provisioning_jobs').set({
        activation_step: 'registered', updated_at: lastSeenAt,
      }).where('machine_id', '=', input.machineId).where('status', '=', 'completed').execute();
      return registered;
    });

    const warnings: string[] = [];
    try {
      await deps.systemStore.writeVpsMeta(buildVpsMeta(updated, lastSeenAt));
    } catch (err: unknown) {
      logCustomerVpsError('write vps-meta failed', err);
      warnings.push('vps_meta_persistence_failed');
    }

    return warnings.length > 0
      ? { registered: true, status: 'running', warnings }
      : { registered: true, status: 'running' };
  }

  return { register };
}
