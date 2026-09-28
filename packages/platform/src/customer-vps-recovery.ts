/** Customer VPS recovery, split from customer-vps.ts. */
import { randomUUID } from 'node:crypto';
import { DEFAULT_CLOUD_INIT_TEMPLATE, buildHostConfig } from './customer-vps-host-config.js';
import type { UserMachineRecord } from './db.js';
import {
  claimUserMachineRecovery,
  getActiveUserMachineByClerkId,
  getUserMachine,
  parseNullableProviderActionId,
  runInPlatformTransaction,
  updateUserMachine,
} from './db.js';
import type { HetznerClient } from './customer-vps-hetzner.js';
import { CustomerVpsError, genericProviderError, logCustomerVpsError } from './customer-vps-errors.js';
import { renderCloudInitTemplate } from './customer-vps-cloud-init.js';
import { type RecoverRequest } from './customer-vps-schema.js';
import { hostBundleUrlForImageVersion, resolveHostBundleRef } from './customer-vps-host-bundle.js';
import {
  openProvisioningPayload,
  sealProvisioningPayload,
  type ProvisioningPayload,
} from './customer-vps-provisioning-jobs.js';
import { chooseRecoveryImage, type ProvisioningImageDecision } from './golden-snapshot-activation.js';
import {
  createGoldenSnapshotCreateIntent,
  getGoldenSnapshot,
  getGoldenSnapshotRecoveryRegistrationTarget,
  markGoldenSnapshotCreateIntentAccepted,
  releaseGoldenSnapshotLease,
  releaseGoldenSnapshotLeaseInTransaction,
} from './golden-snapshot-repository.js';
import type { RecoverResponse } from './customer-vps-types.js';
import {
  RECOVERY_CREATE_ACTION_POLL_ATTEMPTS,
  RECOVERY_CREATE_ACTION_POLL_INTERVAL_MS,
  isAmbiguousProviderCreateError,
  buildRecoveryServerName,
  resolveBillingRecoveryContext,
  assertMachineProviderMutationAllowed,
  sleep,
} from './customer-vps-support.js';
import type { CustomerVpsContext } from './customer-vps-context.js';

/** Recovers a customer VPS onto a replacement server and reconciles pending recovery creates. */
export function createCustomerVpsRecovery(context: CustomerVpsContext) {
  const { deps, machineIdFactory, tokenFactory, postgresPasswordFactory, now, queueProviderDeletion } = context;

  async function waitForRecoveryCreateAction(actionId: number): Promise<'success' | 'error' | 'pending'> {
    for (let attempt = 0; attempt < RECOVERY_CREATE_ACTION_POLL_ATTEMPTS; attempt += 1) {
      try {
        const action = await deps.hetzner.getAction(actionId);
        if (action?.status === 'success') return 'success';
        if (action?.status === 'error') return 'error';
      } catch (err: unknown) {
        logCustomerVpsError(`recovery create action refresh failed actionId=${actionId}`, err);
      }
      if (attempt + 1 < RECOVERY_CREATE_ACTION_POLL_ATTEMPTS) {
        await sleep(RECOVERY_CREATE_ACTION_POLL_INTERVAL_MS);
      }
    }
    return 'pending';
  }

  async function removeRejectedRecoveryServer(input: {
    serverId: number;
    machineId: string;
    handle: string;
  }): Promise<boolean> {
    try {
      await deps.hetzner.deleteServer(input.serverId);
      if (await deps.hetzner.getServer(input.serverId)) {
        const err = new Error('Recovery server deletion has not completed');
        await queueProviderDeletion({
          providerServerId: input.serverId,
          reason: 'rejected_snapshot_recovery_clone',
          machineId: input.machineId,
          handle: input.handle,
          err,
        });
        return false;
      }
      return true;
    } catch (err: unknown) {
      logCustomerVpsError('rejected snapshot recovery clone cleanup failed', err);
      await queueProviderDeletion({
        providerServerId: input.serverId,
        reason: 'rejected_snapshot_recovery_clone',
        machineId: input.machineId,
        handle: input.handle,
        err,
      });
      return false;
    }
  }

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

    if (row.hetznerServerId === null || !await removeRejectedRecoveryServer({
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
          row.runtimeTokenEpoch,
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
            await queueProviderDeletion({
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

  async function recover(input: RecoverRequest): Promise<RecoverResponse> {
    const active = await getActiveUserMachineByClerkId(deps.db, input.clerkUserId, input.runtimeSlot);
    if (!active) {
      throw new CustomerVpsError(404, 'not_found', 'Machine not found');
    }
    if (active.status === 'recovering') {
      throw new CustomerVpsError(409, 'invalid_state', 'Recovery already in progress');
    }
    if (active.status === 'resizing') {
      throw new CustomerVpsError(409, 'invalid_state', 'Machine cannot recover');
    }
    // This R2 check is an advisory fast-fail before the DB claim. The
    // claimUserMachineRecovery WHERE clause below remains the authoritative
    // concurrency guard; keeping the backup check before the claim avoids
    // leaving a machine in recovering state when no snapshot exists.
    if (!input.allowEmpty && !(await deps.systemStore.hasDbLatest(input.clerkUserId, input.runtimeSlot))) {
      throw new CustomerVpsError(409, 'invalid_state', 'No backup snapshot available');
    }
    const currentTime = now();
    const billingContext = await resolveBillingRecoveryContext(
      deps,
      active.clerkUserId,
      active.runtimeSlot,
      active.serverType,
      currentTime,
    );
    const machineId = machineIdFactory();
    const registration = tokenFactory(currentTime, deps.config.registrationTokenTtlMs);
    const postgresPassword = postgresPasswordFactory();
    // Resolve before claiming recovery so bundle lookup failures do not clear
    // the old provider server id and leave a billable VPS untracked.
    const bundleRef = await resolveHostBundleRef(deps.db, deps.config);
    let recoveryImage: ProvisioningImageDecision = {
      imageSource: 'clean_image',
      targetBundleVersion: bundleRef.imageVersion,
      targetBundleSha256: bundleRef.sha256 ?? '0'.repeat(64),
    };
    const hostConfig = buildHostConfig(
      deps.config,
      {
        clerkUserId: active.clerkUserId,
        handle: active.handle,
        runtimeSlot: active.runtimeSlot,
        developerTools: active.developerTools,
      },
      machineId,
      registration.token,
      registration.expiresAt,
      postgresPassword,
      bundleRef,
    );
    if (deps.config.goldenSnapshots.enabled) {
      recoveryImage = await chooseRecoveryImage(deps.db, deps.config.goldenSnapshots, {
        machineId,
        targetBundleVersion: bundleRef.imageVersion,
        serverType: billingContext?.serverType ?? active.serverType ?? deps.config.serverType,
        purpose: 'recover',
        leaseId: randomUUID(),
        now: currentTime.toISOString(),
      });
    }
    if (deps.config.goldenSnapshots.enabled
      && recoveryImage.targetBundleSha256 === '0'.repeat(64)) {
      throw new CustomerVpsError(503, 'provider_unavailable', 'Provisioning unavailable');
    }
    const recoverySnapshotLeaseId = recoveryImage.imageSource === 'snapshot'
      ? recoveryImage.snapshotLeaseId
      : null;
    const sealRecoveryIntent = (decision: ProvisioningImageDecision): string => sealProvisioningPayload({
      registrationToken: registration.token,
      postgresPassword,
      recovery: {
        oldMachineId: active.machineId,
        oldStatus: active.status,
        oldPublicIPv4: active.publicIPv4,
        oldPublicIPv6: active.publicIPv6,
        oldImageVersion: active.imageVersion,
        oldSourceSnapshotId: active.sourceSnapshotId,
        oldSourceBaseGeneration: active.sourceBaseGeneration,
        oldTargetBundleVersion: active.targetBundleVersion,
        oldTargetBundleSha256: active.targetBundleSha256,
        oldServerType: active.serverType,
        oldRegistrationTokenHash: active.registrationTokenHash,
        oldRegistrationTokenExpiresAt: active.registrationTokenExpiresAt,
        oldProvisionedAt: active.provisionedAt,
        oldLastSeenAt: active.lastSeenAt,
        oldFailureCode: active.failureCode,
        oldFailureAt: active.failureAt,
        imageSource: decision.imageSource,
        targetBundleVersion: decision.targetBundleVersion,
        targetBundleSha256: decision.targetBundleSha256,
        sourceSnapshotId: decision.imageSource === 'snapshot' ? decision.snapshotId : null,
        sourceBaseGeneration: decision.imageSource === 'snapshot' ? decision.sourceBaseGeneration : null,
      },
    }, deps.config.platformSecret);
    let encryptedRecoveryPayload = sealRecoveryIntent(recoveryImage);
    const intendedServerType = billingContext?.serverType ?? active.serverType ?? deps.config.serverType;
    const existing = await claimUserMachineRecovery(deps.db, input.clerkUserId, active.runtimeSlot, {
      machineId,
      encryptedPayload: encryptedRecoveryPayload,
      serverType: intendedServerType,
      registrationTokenHash: registration.hash,
      registrationTokenExpiresAt: registration.expiresAt,
    });
    if (!existing) {
      if (recoveryImage.imageSource === 'snapshot') {
        await releaseGoldenSnapshotLease(deps.db, recoveryImage.snapshotLeaseId, currentTime.toISOString());
      }
      const latest = await getActiveUserMachineByClerkId(deps.db, input.clerkUserId, input.runtimeSlot);
      if (latest?.status === 'recovering') {
        throw new CustomerVpsError(409, 'invalid_state', 'Recovery already in progress');
      }
      throw new CustomerVpsError(404, 'not_found', 'Machine not found');
    }
    const oldMachineId = active.machineId;
    const oldServerId = existing.recoveryOldServerId;
    const transitionRecoveryToCleanFallback = async (
      snapshotImage: Extract<ProvisioningImageDecision, { imageSource: 'snapshot' }>,
    ): Promise<void> => {
      const cleanImage: ProvisioningImageDecision = {
        imageSource: 'clean_image',
        targetBundleVersion: snapshotImage.targetBundleVersion,
        targetBundleSha256: snapshotImage.targetBundleSha256,
      };
      const fallbackPayload = sealRecoveryIntent(cleanImage);
      const transitionedAt = now().toISOString();
      await runInPlatformTransaction(deps.db, async (trx) => {
        const released = await releaseGoldenSnapshotLeaseInTransaction(
          trx, snapshotImage.snapshotLeaseId, transitionedAt,
        );
        if (!released) throw new Error('Recovery snapshot lease transition lost');
        const updated = await trx.executor.updateTable('user_machines').set({
          recovery_encrypted_payload: fallbackPayload,
        }).where('machine_id', '=', machineId).where('status', '=', 'recovering')
          .returning('machine_id').executeTakeFirst();
        if (!updated) throw new Error('Recovery fallback transition lost its machine claim');
      });
      recoveryImage = cleanImage;
      encryptedRecoveryPayload = fallbackPayload;
    };

    let newServerId: number | null = null;
    let createPending = false;
    let createOutcomeAmbiguous = false;
    try {
      const userData = renderCloudInitTemplate(
        deps.cloudInitTemplate ?? DEFAULT_CLOUD_INIT_TEMPLATE,
        {
          ...hostConfig,
          imageSource: recoveryImage.imageSource,
          targetBundleSha256: recoveryImage.targetBundleSha256 === '0'.repeat(64) ? '' : recoveryImage.targetBundleSha256,
          snapshotSourceVersion: recoveryImage.imageSource === 'snapshot' ? recoveryImage.sourceBundleVersion : '',
        },
      );
      const recoveryCreateInput = {
        name: buildRecoveryServerName(existing.handle, machineId),
        serverType: intendedServerType,
        location: active.location ?? deps.config.location,
        userData,
        labels: {
          app: 'matrix-os',
          clerk_user_id: existing.clerkUserId,
          runtime_slot: existing.runtimeSlot,
          machine_id: machineId,
          image_source: recoveryImage.imageSource,
          ...(recoveryImage.imageSource === 'snapshot' ? { snapshot_id: recoveryImage.snapshotId } : {}),
        },
        ...(recoveryImage.imageSource === 'snapshot' ? { image: recoveryImage.providerImageId } : {}),
      };
      let server;
      await assertMachineProviderMutationAllowed(deps, existing, recoveryCreateInput.serverType, now());
      try {
        if (recoveryImage.imageSource === 'snapshot') {
          const selectableSnapshot = await getGoldenSnapshot(deps.db, recoveryImage.snapshotId);
          if (selectableSnapshot?.state !== 'ready'
            || selectableSnapshot.providerImageId !== recoveryImage.providerImageId) {
            throw new CustomerVpsError(409, 'snapshot_clone_rejected', 'Provisioning image unavailable');
          }
          const intent = await createGoldenSnapshotCreateIntent(deps.db, {
            intentId: randomUUID(), snapshotId: recoveryImage.snapshotId,
            leaseId: recoveryImage.snapshotLeaseId, machineId,
            purpose: 'recover', rolloutGeneration: recoveryImage.rolloutGeneration,
            now: now().toISOString(),
          });
          if (!intent || intent.state === 'denied') {
            throw new CustomerVpsError(409, 'snapshot_clone_rejected', 'Provisioning image unavailable');
          }
        }
        server = await deps.hetzner.createServer(recoveryCreateInput);
        if (recoveryImage.imageSource === 'snapshot') {
          const accepted = await markGoldenSnapshotCreateIntentAccepted(
            deps.db, recoveryImage.snapshotLeaseId, server.createActionId ?? null, now().toISOString(),
          );
          if (!accepted || accepted.state === 'denied') {
            await removeRejectedRecoveryServer({ serverId: server.id, machineId, handle: existing.handle });
            throw new CustomerVpsError(409, 'snapshot_clone_rejected', 'Provisioning image unavailable');
          }
        }
      } catch (createErr: unknown) {
        if (!(createErr instanceof CustomerVpsError)
          || createErr.code !== 'snapshot_clone_rejected'
          || recoveryImage.imageSource !== 'snapshot') {
          createOutcomeAmbiguous = isAmbiguousProviderCreateError(createErr);
          throw createErr;
        }
        await transitionRecoveryToCleanFallback(recoveryImage);
        await assertMachineProviderMutationAllowed(deps, existing, recoveryCreateInput.serverType, now());
        try {
          server = await deps.hetzner.createServer({
            name: recoveryCreateInput.name,
            serverType: recoveryCreateInput.serverType,
            location: recoveryCreateInput.location,
            userData: renderCloudInitTemplate(
              deps.cloudInitTemplate ?? DEFAULT_CLOUD_INIT_TEMPLATE,
              {
                ...hostConfig,
                imageSource: 'clean_image',
                targetBundleSha256: recoveryImage.targetBundleSha256,
                snapshotSourceVersion: '',
              },
            ),
            labels: {
              app: 'matrix-os', clerk_user_id: existing.clerkUserId, runtime_slot: existing.runtimeSlot,
              machine_id: machineId, image_source: 'clean_image',
            },
          });
        } catch (fallbackCreateErr: unknown) {
          createOutcomeAmbiguous = isAmbiguousProviderCreateError(fallbackCreateErr);
          throw fallbackCreateErr;
        }
      }
      newServerId = server.id;
      if (server.createActionId !== undefined) {
        const createResult = await waitForRecoveryCreateAction(server.createActionId);
        if (createResult === 'error') {
          if (recoveryImage.imageSource !== 'snapshot') {
            throw new CustomerVpsError(500, 'provider_unavailable', 'Provisioning provider unavailable');
          }
          const removed = await removeRejectedRecoveryServer({
            serverId: server.id,
            machineId,
            handle: existing.handle,
          });
          if (!removed) {
            throw new CustomerVpsError(500, 'provider_timeout', 'Provisioning provider unavailable');
          }
          newServerId = null;
          await transitionRecoveryToCleanFallback(recoveryImage);
          await assertMachineProviderMutationAllowed(deps, existing, recoveryCreateInput.serverType, now());
          try {
            server = await deps.hetzner.createServer({
              name: recoveryCreateInput.name,
              serverType: recoveryCreateInput.serverType,
              location: recoveryCreateInput.location,
              userData: renderCloudInitTemplate(
                deps.cloudInitTemplate ?? DEFAULT_CLOUD_INIT_TEMPLATE,
                {
                  ...hostConfig,
                  imageSource: 'clean_image',
                  targetBundleSha256: recoveryImage.targetBundleSha256,
                  snapshotSourceVersion: '',
                },
              ),
              labels: {
                app: 'matrix-os', clerk_user_id: existing.clerkUserId, runtime_slot: existing.runtimeSlot,
                machine_id: machineId, image_source: 'clean_image',
              },
            });
          } catch (fallbackCreateErr: unknown) {
            createOutcomeAmbiguous = isAmbiguousProviderCreateError(fallbackCreateErr);
            throw fallbackCreateErr;
          }
          newServerId = server.id;
          if (server.createActionId !== undefined) {
            const fallbackCreateResult = await waitForRecoveryCreateAction(server.createActionId);
            if (fallbackCreateResult === 'error') {
              throw new CustomerVpsError(500, 'provider_unavailable', 'Provisioning provider unavailable');
            }
            createPending = fallbackCreateResult === 'pending';
          }
        } else {
          createPending = createResult === 'pending';
        }
      }
      await runInPlatformTransaction(deps.db, async (trx) => {
        await updateUserMachine(trx, machineId, {
          status: 'recovering',
          hetznerServerId: server.id,
          imageVersion: bundleRef.imageVersion,
          sourceSnapshotId: recoveryImage.imageSource === 'snapshot' ? recoveryImage.snapshotId : null,
          sourceBaseGeneration: recoveryImage.imageSource === 'snapshot'
            ? recoveryImage.sourceBaseGeneration
            : null,
          targetBundleVersion: recoveryImage.targetBundleVersion,
          targetBundleSha256: recoveryImage.targetBundleSha256,
          recoveryCreateActionId: createPending ? server.createActionId ?? null : null,
          recoveryEncryptedPayload: encryptedRecoveryPayload,
          recoveryOldServerId: oldServerId,
          serverType: recoveryCreateInput.serverType,
          location: recoveryCreateInput.location,
          registrationTokenHash: registration.hash,
          registrationTokenExpiresAt: registration.expiresAt,
          provisionedAt: currentTime.toISOString(),
          lastSeenAt: null,
          deletedAt: null,
          failureCode: null,
          failureAt: null,
        });
      });
    } catch (err: unknown) {
      const mapped = genericProviderError(err);
      if (createOutcomeAmbiguous) {
        throw mapped;
      }
      if (newServerId !== null) {
        try {
          await deps.hetzner.deleteServer(newServerId);
        } catch (cleanupErr: unknown) {
          logCustomerVpsError('recover compensation delete failed', cleanupErr);
          await queueProviderDeletion({
            providerServerId: newServerId,
            reason: 'recover_compensation',
            machineId,
            handle: existing.handle,
            err: cleanupErr,
          });
        }
      }
      try {
        await runInPlatformTransaction(deps.db, async (trx) => {
          if (recoverySnapshotLeaseId !== null) {
            // Idempotently account for the original snapshot lease even when
            // the clean fallback transition already released it.
            await releaseGoldenSnapshotLeaseInTransaction(
              trx, recoverySnapshotLeaseId, now().toISOString(),
            );
          }
          const recoveryRow = await trx.executor.selectFrom('user_machines')
            .select(['machine_id', 'status'])
            .where('clerk_user_id', '=', input.clerkUserId)
            .where('runtime_slot', '=', active.runtimeSlot)
            .where('deleted_at', 'is', null)
            .forUpdate()
            .executeTakeFirst();
          if (!recoveryRow || recoveryRow.status !== 'recovering') {
            throw new Error('Recovery rollback lost its machine claim');
          }
          await updateUserMachine(trx, recoveryRow.machine_id, {
            machineId: oldMachineId,
            status: active.status,
            hetznerServerId: active.hetznerServerId,
            publicIPv4: active.publicIPv4,
            publicIPv6: active.publicIPv6,
            imageVersion: active.imageVersion,
            sourceSnapshotId: active.sourceSnapshotId,
            sourceBaseGeneration: active.sourceBaseGeneration,
            targetBundleVersion: active.targetBundleVersion,
            targetBundleSha256: active.targetBundleSha256,
            recoveryCreateActionId: active.recoveryCreateActionId,
            recoveryEncryptedPayload: active.recoveryEncryptedPayload,
            recoveryOldServerId: active.recoveryOldServerId,
            recoveryOldPublicIPv4: active.recoveryOldPublicIPv4,
            serverType: active.serverType,
            registrationTokenHash: active.registrationTokenHash,
            registrationTokenExpiresAt: active.registrationTokenExpiresAt,
            provisionedAt: active.provisionedAt,
            lastSeenAt: active.lastSeenAt,
            failureCode: active.failureCode,
            failureAt: active.failureAt,
          });
        });
      } catch (statusErr: unknown) {
        logCustomerVpsError('recover failure status update failed', statusErr);
      }
      throw mapped;
    }

    return {
      oldMachineId,
      machineId,
      runtimeSlot: existing.runtimeSlot,
      status: 'recovering',
      etaSeconds: deps.config.provisionEtaSeconds,
    };
  }

  return { reconcilePendingRecoveryCreate, recover };
}
