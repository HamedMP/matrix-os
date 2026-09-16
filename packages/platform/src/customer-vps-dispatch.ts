/**
 * VPS provisioning dispatch operations.
 *
 * Extracted from ./customer-vps.ts (Phase 1-A4). Pure move: no logic changes.
 */

import { randomUUID } from 'node:crypto';
import {
  CustomerVpsError,
  PreviewSnapshotUnavailableError,
  genericProviderError,
  logCustomerVpsError,
} from './customer-vps-errors.js';
import {
  claimProvisioningJob,
  failProvisioningJob,
  getProvisioningJob,
  listDispatchableProvisioningJobs,
  openProvisioningPayload,
  sealProvisioningPayload,
  type NewProvisioningJob,
  type ProvisioningPayload,
} from './customer-vps-provisioning-jobs.js';
import {
  isProvisioningJobAuthorized,
  persistProvisioningClaimMutation,
} from './customer-vps-prebilling.js';
import { getUserMachine, runInPlatformTransaction, updateUserMachine } from './db.js';
import { parseNullableProviderActionId } from './db.js';
import { renderCloudInitTemplate } from './customer-vps-cloud-init.js';
import { hostBundleUrlForImageVersion } from './customer-vps-host-bundle.js';
import { resolvePersistedProvisioningImage } from './golden-snapshot-preview-test.js';
import { fallbackProvisioningImage, type ProvisioningImageDecision } from './golden-snapshot-activation.js';
import { isPreviewTestSnapshotDecision } from './golden-snapshot-preview-test.js';
import {
  appendGoldenSnapshotAuditEvent,
  getGoldenSnapshot,
  getGoldenSnapshotRecoveryRegistrationTarget,
  markGoldenSnapshotCreateIntentAccepted,
  releaseGoldenSnapshotLeaseInTransaction,
} from './golden-snapshot-repository.js';
import { MAX_PROVISIONING_JOB_ATTEMPTS, completeProvisioningJob } from './customer-vps-provisioning-jobs.js';
import { chooseProvisioningImage } from './golden-snapshot-activation.js';
import { createPreviewTestSnapshotCreateIntent } from './golden-snapshot-preview-test.js';
import { createGoldenSnapshotCreateIntent } from './golden-snapshots/rollout.js';
import type { ProvisionOptions } from './customer-vps.js';
import {
  assertMachineProviderMutationAllowed,
  buildHostConfig,
  buildServerName,
  DEFAULT_CLOUD_INIT_TEMPLATE,
  isAmbiguousProviderCreateError,
  toFailureCode,
} from './customer-vps-helpers.js';

import type { PlatformDB } from './db.js';
import type { HetznerClient } from './customer-vps-hetzner.js';
import type { UserMachineRecord } from './db.js';
import type { CustomerVpsServiceDeps } from './customer-vps.js';
import type { createVpsPollingOperations } from './customer-vps-polling.js';
import type { createVpsDeletionOperations } from './customer-vps-deletion.js';
export interface VpsDispatchOperationsDeps {
  db: PlatformDB;
  hetzner: HetznerClient;
  config: CustomerVpsServiceDeps['config'];
  cloudInitTemplate: string;
  polling: ReturnType<typeof createVpsPollingOperations>;
  deletion: Pick<ReturnType<typeof createVpsDeletionOperations>, 'enqueueProviderDeletionTx'>;
  scheduleProvisioningDispatch: NonNullable<CustomerVpsServiceDeps['scheduleProvisioningDispatch']>;
  resolveBillingEntitlement: CustomerVpsServiceDeps['resolveBillingEntitlement'];
  now: () => Date;
}

const PROVISIONING_JOB_LEASE_MS = 5 * 60_000;

export function createVpsDispatchOperations(dispatchDeps: VpsDispatchOperationsDeps) {
  const deps = dispatchDeps;
  const polling = dispatchDeps.polling;
  const now = dispatchDeps.now;
  const scheduleProvisioningDispatch = dispatchDeps.scheduleProvisioningDispatch;
  const { enqueueProviderDeletionTx } = dispatchDeps.deletion;
  async function dispatchProvisioningJob(
    jobId: string,
    propagateFailure: boolean,
  ): Promise<'completed' | 'failed' | 'skipped' | 'pending'> {
    const claimedAt = now();
    const pendingJob = await getProvisioningJob(deps.db, jobId);
    if (
      pendingJob?.status === 'running'
      && pendingJob.attempts >= MAX_PROVISIONING_JOB_ATTEMPTS
      && pendingJob.leaseExpiresAt
      && pendingJob.leaseExpiresAt <= claimedAt.toISOString()
    ) {
      await runInPlatformTransaction(deps.db, async (trx) => {
        await updateUserMachine(trx, pendingJob.machineId, {
          status: 'failed',
          failureCode: 'retry_exhausted',
          failureAt: claimedAt.toISOString(),
        });
        await failProvisioningJob(
          trx,
          pendingJob.jobId,
          claimedAt.toISOString(),
          'retry_exhausted',
        );
      });
      if (propagateFailure) {
        throw new CustomerVpsError(500, 'retry_exhausted', 'Provisioning failed');
      }
      return 'failed';
    }
    const job = await claimProvisioningJob(
      deps.db,
      jobId,
      claimedAt.toISOString(),
      new Date(claimedAt.getTime() + PROVISIONING_JOB_LEASE_MS).toISOString(),
    );
    if (!job) return 'skipped';

    const row = await getUserMachine(deps.db, job.machineId);
    if (!row || row.deletedAt || row.status !== 'provisioning' || !job.encryptedPayload) {
      const failedAt = now().toISOString();
      await failProvisioningJob(deps.db, job.jobId, failedAt, 'invalid_state');
      if (row && !row.deletedAt && row.status === 'provisioning') {
        await updateUserMachine(deps.db, row.machineId, {
          status: 'failed',
          failureCode: 'invalid_state',
          failureAt: failedAt,
        });
      }
      if (propagateFailure) {
        throw new CustomerVpsError(500, 'invalid_state', 'Provisioning failed');
      }
      return 'failed';
    }

    if (!await isProvisioningJobAuthorized(deps.db, job, row, now().toISOString())) {
        const failedAt = now().toISOString();
        await failProvisioningJob(deps.db, job.jobId, failedAt, 'authorization_expired');
        await updateUserMachine(deps.db, row.machineId, {
          status: 'failed',
          failureCode: 'authorization_expired',
          failureAt: failedAt,
        });
        if (propagateFailure) {
          throw new CustomerVpsError(409, 'invalid_state', 'Provisioning unavailable');
        }
        return 'failed';
    }

    let serverIdForCompensation: number | null = null;
    let adoptedExistingServer = false;
    const persistWhileProvisioningClaimIsActive = async (
      mutate: (trx: PlatformDB) => Promise<void>,
    ) => persistProvisioningClaimMutation(
      deps.db,
      { machineId: row.machineId, jobId: job.jobId, mutate },
    );
    const reconcileServerAfterLostClaim = async (
      server: { id: number },
      prebillingCleanupWon: boolean,
    ): Promise<'failed'> => {
      if (!prebillingCleanupWon) {
        throw new Error('Provisioning job lost its active claim');
      }
      try {
        await deps.hetzner.deleteServer(server.id);
        if (await deps.hetzner.getServer(server.id)) {
          await enqueueProviderDeletionTx(deps.db, {
            providerServerId: server.id,
            reason: 'prebilling_cleanup_race',
            machineId: row.machineId,
            handle: row.handle,
            detail: 'provider server remained after signed checkout cleanup',
          });
        }
      } catch (cleanupErr: unknown) {
        logCustomerVpsError('prebilling cleanup race provider deletion failed', cleanupErr);
        await polling.queueProviderDeletion({
          providerServerId: server.id,
          reason: 'prebilling_cleanup_race',
          machineId: row.machineId,
          handle: row.handle,
          err: cleanupErr,
        });
      }
      serverIdForCompensation = null;
      return 'failed';
    };
    try {
      const payload = openProvisioningPayload(job.encryptedPayload, deps.config.platformSecret);
      const imageVersion = row.imageVersion ?? deps.config.imageVersion;
      let imageDecision: ProvisioningImageDecision;
      let transitionedToFallback = false;
      let effectiveProviderCreateActionId = job.providerCreateActionId;
      if (job.imageSource === 'snapshot' && job.snapshotId && job.snapshotLeaseId) {
        const resolved = await resolvePersistedProvisioningImage({
          db: deps.db,
          config: deps.config.goldenSnapshots,
          machine: row,
          job,
          imageVersion,
          claimedAt,
        });
        imageDecision = resolved.imageDecision;
        transitionedToFallback = resolved.transitionedToFallback;
        effectiveProviderCreateActionId = resolved.effectiveProviderCreateActionId;
      } else if (job.imageSource === 'clean_image') {
        imageDecision = {
          imageSource: 'clean_image',
          targetBundleVersion: imageVersion,
          targetBundleSha256: job.targetBundleSha256 ?? '0'.repeat(64),
        };
      } else {
        imageDecision = await chooseProvisioningImage(deps.db, deps.config.goldenSnapshots, {
          jobId: job.jobId,
          machineId: row.machineId,
          targetBundleVersion: imageVersion,
          serverType: row.serverType ?? deps.config.serverType,
          purpose: 'provision',
          leaseId: randomUUID(),
          now: claimedAt.toISOString(),
        });
      }
      if (deps.config.goldenSnapshots.enabled
        && imageDecision.targetBundleSha256 === '0'.repeat(64)) {
        throw new CustomerVpsError(503, 'provider_unavailable', 'Provisioning unavailable');
      }
      if (!row.registrationTokenExpiresAt) {
        throw new CustomerVpsError(409, 'registration_rejected', 'Registration rejected');
      }
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
        row.registrationTokenExpiresAt,
        payload.postgresPassword,
        {
          imageVersion,
          hostBundleUrl: hostBundleUrlForImageVersion(deps.config, imageVersion),
        },
      );
      const userData = renderCloudInitTemplate(
        deps.cloudInitTemplate ?? DEFAULT_CLOUD_INIT_TEMPLATE,
        {
          ...hostConfig,
          imageSource: imageDecision.imageSource,
          targetBundleSha256: imageDecision.targetBundleSha256 === '0'.repeat(64) ? '' : imageDecision.targetBundleSha256,
          snapshotSourceVersion: imageDecision.imageSource === 'snapshot' ? imageDecision.sourceBundleVersion : '',
        },
      );
      let existingServers = deps.hetzner.listServersByLabel
        ? (await deps.hetzner.listServersByLabel(`machine_id=${row.machineId}`))
          .toSorted((left, right) => left.id - right.id)
        : [];
      if (imageDecision.imageSource === 'clean_image' && (job.fallbackReason || transitionedToFallback)) {
        const staleSnapshotServers = existingServers.filter((candidate) => candidate.labels?.snapshot_id);
        for (const stale of staleSnapshotServers) {
          try {
            await deps.hetzner.deleteServer(stale.id);
            if (await deps.hetzner.getServer(stale.id)) return 'pending';
          } catch (cleanupErr: unknown) {
            logCustomerVpsError('snapshot fallback server cleanup failed', cleanupErr);
            await polling.queueProviderDeletion({
              providerServerId: stale.id, reason: 'snapshot_fallback_server',
              machineId: row.machineId, handle: row.handle, err: cleanupErr,
            });
            return 'pending';
          }
        }
        existingServers = existingServers.filter((candidate) => !candidate.labels?.snapshot_id);
      }
      const selectedSnapshotId = imageDecision.imageSource === 'snapshot' ? imageDecision.snapshotId : undefined;
      const matchingServers = selectedSnapshotId
        ? existingServers.filter((server) => server.labels?.snapshot_id === selectedSnapshotId)
        : existingServers.filter((server) => !server.labels?.snapshot_id);
      if (existingServers.length > 0 && matchingServers.length === 0) {
        throw new Error('Existing provider server image provenance is ambiguous');
      }
      let existingServer = matchingServers[0];
      if (!existingServer && isPreviewTestSnapshotDecision(imageDecision)
        && effectiveProviderCreateActionId !== null) {
        const persistedServer = row.hetznerServerId === null
          ? null
          : await deps.hetzner.getServer(row.hetznerServerId);
        if (persistedServer) {
          if (persistedServer.labels?.machine_id !== row.machineId
            || persistedServer.labels?.snapshot_id !== imageDecision.snapshotId) {
            throw new Error('Persisted preview-test server provenance is ambiguous');
          }
          existingServer = persistedServer;
        } else {
          const priorCreateResult = await polling.waitForProvisioningCreateAction(
            effectiveProviderCreateActionId,
          );
          if (priorCreateResult === 'pending') return 'pending';
          throw new PreviewSnapshotUnavailableError('provider_create_action_rejected');
        }
      }
      const createInput = {
          name: buildServerName(row.handle),
          serverType: row.serverType ?? deps.config.serverType,
          location: row.location ?? deps.config.location,
          userData,
          labels: {
            app: 'matrix-os',
            clerk_user_id: row.clerkUserId,
            runtime_slot: row.runtimeSlot,
            machine_id: row.machineId,
            image_source: imageDecision.imageSource,
            ...(imageDecision.imageSource === 'snapshot' ? { snapshot_id: imageDecision.snapshotId } : {}),
          },
          ...(imageDecision.imageSource === 'snapshot' ? { image: imageDecision.providerImageId } : {}),
        };
      let server = existingServer;
      if (!server) {
        await assertMachineProviderMutationAllowed(
          deps,
          row,
          createInput.serverType,
          now(),
          job.authorizationBasis,
        );
        try {
          if (imageDecision.imageSource === 'snapshot') {
            const selectableSnapshot = await getGoldenSnapshot(deps.db, imageDecision.snapshotId);
            if (selectableSnapshot?.state !== 'ready'
              || selectableSnapshot.providerImageId !== imageDecision.providerImageId) {
              if (isPreviewTestSnapshotDecision(imageDecision)) {
                throw new PreviewSnapshotUnavailableError('pre_create_snapshot_changed');
              }
              throw new CustomerVpsError(409, 'snapshot_clone_rejected', 'Provisioning image unavailable');
            }
            const intent = isPreviewTestSnapshotDecision(imageDecision)
              ? await createPreviewTestSnapshotCreateIntent(deps.db, {
                  intentId: randomUUID(), snapshotId: imageDecision.snapshotId,
                  leaseId: imageDecision.snapshotLeaseId, machineId: row.machineId,
                  providerImageId: imageDecision.providerImageId,
                  now: now().toISOString(),
                })
              : await createGoldenSnapshotCreateIntent(deps.db, {
                  intentId: randomUUID(), snapshotId: imageDecision.snapshotId,
                  leaseId: imageDecision.snapshotLeaseId, machineId: row.machineId,
                  purpose: 'provision', rolloutGeneration: imageDecision.rolloutGeneration,
                  now: now().toISOString(),
                });
            if (!intent || intent.state === 'denied') {
              if (isPreviewTestSnapshotDecision(imageDecision)) {
                throw new PreviewSnapshotUnavailableError(
                  intent?.state === 'denied' ? 'create_intent_denied' : 'create_intent_unavailable',
                );
              }
              throw new CustomerVpsError(409, 'snapshot_clone_rejected', 'Provisioning image unavailable');
            }
          }
          server = await deps.hetzner.createServer(createInput);
          if (imageDecision.imageSource === 'snapshot') {
            const accepted = await markGoldenSnapshotCreateIntentAccepted(
              deps.db, imageDecision.snapshotLeaseId, server.createActionId ?? null, now().toISOString(),
            );
            if (!accepted || accepted.state === 'denied') {
              try {
                await deps.hetzner.deleteServer(server.id);
              } catch (cleanupErr: unknown) {
                await polling.queueProviderDeletion({
                  providerServerId: server.id, reason: 'denied_snapshot_create',
                  machineId: row.machineId, handle: row.handle, err: cleanupErr,
                });
              }
              if (isPreviewTestSnapshotDecision(imageDecision)) {
                throw new PreviewSnapshotUnavailableError(
                  accepted?.state === 'denied' ? 'create_intent_denied' : 'create_intent_unavailable',
                );
              }
              throw new CustomerVpsError(409, 'snapshot_clone_rejected', 'Provisioning image unavailable');
            }
          }
        } catch (createErr: unknown) {
          if (isAmbiguousProviderCreateError(createErr)) {
            logCustomerVpsError('provision create outcome is ambiguous; awaiting exact-label reconciliation', createErr);
            return 'pending';
          }
          if (!(createErr instanceof CustomerVpsError)
            || createErr.code !== 'snapshot_clone_rejected'
            || imageDecision.imageSource !== 'snapshot') throw createErr;
          if (isPreviewTestSnapshotDecision(imageDecision)) throw createErr;
          await fallbackProvisioningImage(deps.db, {
            jobId: job.jobId,
            reason: 'clone_rejected',
            now: now().toISOString(),
          });
          effectiveProviderCreateActionId = null;
          imageDecision = {
            imageSource: 'clean_image',
            targetBundleVersion: imageDecision.targetBundleVersion,
            targetBundleSha256: imageDecision.targetBundleSha256,
          };
          await assertMachineProviderMutationAllowed(
            deps,
            row,
            createInput.serverType,
            now(),
            job.authorizationBasis,
          );
          try {
            server = await deps.hetzner.createServer({
              name: createInput.name,
              serverType: createInput.serverType,
              location: createInput.location,
              userData: renderCloudInitTemplate(
                deps.cloudInitTemplate ?? DEFAULT_CLOUD_INIT_TEMPLATE,
                {
                  ...hostConfig,
                  imageSource: 'clean_image',
                  targetBundleSha256: imageDecision.targetBundleSha256,
                  snapshotSourceVersion: '',
                },
              ),
              labels: {
                app: 'matrix-os', clerk_user_id: row.clerkUserId, runtime_slot: row.runtimeSlot,
                machine_id: row.machineId, image_source: 'clean_image',
              },
            });
          } catch (fallbackCreateErr: unknown) {
            if (isAmbiguousProviderCreateError(fallbackCreateErr)) {
              logCustomerVpsError(
                'clean fallback create outcome is ambiguous; awaiting exact-label reconciliation',
                fallbackCreateErr,
              );
              return 'pending';
            }
            throw fallbackCreateErr;
          }
        }
      }
      adoptedExistingServer = Boolean(existingServer);
      if (!adoptedExistingServer) serverIdForCompensation = server.id;
      for (const duplicate of matchingServers.slice(1)) {
        try {
          await deps.hetzner.deleteServer(duplicate.id);
        } catch (cleanupErr: unknown) {
          logCustomerVpsError('duplicate provisioning server cleanup failed', cleanupErr);
          await polling.queueProviderDeletion({
            providerServerId: duplicate.id,
            reason: 'duplicate_provisioning_server',
            machineId: row.machineId,
            handle: row.handle,
            err: cleanupErr,
          });
        }
      }
      const createActionId = effectiveProviderCreateActionId ?? server.createActionId ?? null;
      if (adoptedExistingServer && createActionId === null && server.status !== 'running') {
        const observedAt = now().toISOString();
        const observation = await persistWhileProvisioningClaimIsActive(async (trx) => {
          await updateUserMachine(trx, row.machineId, {
            hetznerServerId: server!.id,
            publicIPv4: server!.publicIPv4,
            publicIPv6: server!.publicIPv6,
          });
          await trx.executor.updateTable('provisioning_jobs').set({
            activation_step: 'creating', updated_at: observedAt,
          }).where('job_id', '=', job.jobId).where('status', '=', 'running').executeTakeFirstOrThrow();
        });
        if (observation.alreadyCompleted) return 'completed';
        if (!observation.persisted) {
          return reconcileServerAfterLostClaim(server, observation.prebillingCleanupWon);
        }
        return 'pending';
      }
      if (createActionId !== null) {
        if (effectiveProviderCreateActionId === null) {
          const observedAt = now().toISOString();
          const observation = await persistWhileProvisioningClaimIsActive(async (trx) => {
            await updateUserMachine(trx, row.machineId, {
              hetznerServerId: server!.id,
              publicIPv4: server!.publicIPv4,
              publicIPv6: server!.publicIPv6,
            });
            await trx.executor.updateTable('provisioning_jobs').set({
              provider_create_action_id: createActionId,
              activation_step: 'creating',
              updated_at: observedAt,
            }).where('job_id', '=', job.jobId).where('status', '=', 'running').executeTakeFirstOrThrow();
          });
          if (observation.alreadyCompleted) return 'completed';
          if (!observation.persisted) {
            return reconcileServerAfterLostClaim(server, observation.prebillingCleanupWon);
          }
        }
        const createResult = await polling.waitForProvisioningCreateAction(createActionId);
        if (createResult === 'pending') return 'pending';
        if (createResult === 'error') {
          if (imageDecision.imageSource !== 'snapshot') {
            throw new Error('Provider create action failed');
          }
          if (isPreviewTestSnapshotDecision(imageDecision)) {
            try {
              await deps.hetzner.deleteServer(server.id);
              if (await deps.hetzner.getServer(server.id)) {
                await enqueueProviderDeletionTx(deps.db, {
                  providerServerId: server.id,
                  reason: 'rejected_snapshot_clone',
                  machineId: row.machineId,
                  handle: row.handle,
                  detail: 'rejected preview-test snapshot clone deletion pending',
                });
              }
              serverIdForCompensation = null;
            } catch (cleanupErr: unknown) {
              logCustomerVpsError('rejected preview-test snapshot clone cleanup failed', cleanupErr);
              await enqueueProviderDeletionTx(deps.db, {
                providerServerId: server.id,
                reason: 'rejected_snapshot_clone',
                machineId: row.machineId,
                handle: row.handle,
                detail: 'rejected preview-test snapshot clone cleanup failed',
              });
              serverIdForCompensation = null;
            }
            throw new PreviewSnapshotUnavailableError('provider_create_action_rejected');
          }
          await fallbackProvisioningImage(deps.db, {
            jobId: job.jobId, reason: 'clone_rejected', now: now().toISOString(),
          });
          try {
            await deps.hetzner.deleteServer(server.id);
            if (await deps.hetzner.getServer(server.id)) return 'pending';
          } catch (cleanupErr: unknown) {
            logCustomerVpsError('rejected snapshot clone cleanup failed', cleanupErr);
            await polling.queueProviderDeletion({
              providerServerId: server.id, reason: 'rejected_snapshot_clone',
              machineId: row.machineId, handle: row.handle, err: cleanupErr,
            });
          }
          return 'pending';
        }
      }
      const completedAt = now().toISOString();
      const completion = await persistWhileProvisioningClaimIsActive(async (trx) => {
        await updateUserMachine(trx, row.machineId, {
          hetznerServerId: server.id,
          publicIPv4: server.publicIPv4,
          publicIPv6: server.publicIPv6,
        });
        await trx.executor.updateTable('provisioning_jobs').set({
          provider_create_action_id: server.createActionId ?? null,
          updated_at: completedAt,
        }).where('job_id', '=', job.jobId).where('status', '=', 'running').execute();
        const completed = await completeProvisioningJob(trx, job.jobId, completedAt);
        if (!completed) {
          const settledJob = await getProvisioningJob(trx, job.jobId);
          if (settledJob?.status !== 'completed') {
            throw new Error('Provisioning job completion lost its lease');
          }
        }
      });
      if (completion.alreadyCompleted) return 'completed';
      if (!completion.persisted) {
        return reconcileServerAfterLostClaim(server, completion.prebillingCleanupWon);
      }
      return 'completed';
    } catch (err: unknown) {
      const mapped = genericProviderError(err);
      if (serverIdForCompensation !== null) {
        try {
          await deps.hetzner.deleteServer(serverIdForCompensation);
        } catch (cleanupErr: unknown) {
          logCustomerVpsError('provision compensation delete failed', cleanupErr);
          await polling.queueProviderDeletion({
            providerServerId: serverIdForCompensation,
            reason: 'provision_compensation',
            machineId: row.machineId,
            handle: row.handle,
            err: cleanupErr,
          });
        }
      }
      if (adoptedExistingServer) {
        logCustomerVpsError(`adopted provisioning server persistence failed machineId=${row.machineId}`, err);
      }
      const failedAt = now().toISOString();
      try {
        await runInPlatformTransaction(deps.db, async (trx) => {
          await updateUserMachine(trx, row.machineId, {
            status: 'failed',
            failureCode: toFailureCode(err),
            failureAt: failedAt,
          });
          const latestJob = await getProvisioningJob(trx, job.jobId);
          if (latestJob?.snapshotLeaseId) {
            await releaseGoldenSnapshotLeaseInTransaction(trx, latestJob.snapshotLeaseId, failedAt);
          }
          await failProvisioningJob(trx, job.jobId, failedAt, toFailureCode(err));
        });
      } catch (statusErr: unknown) {
        logCustomerVpsError('provision failure status update failed', statusErr);
      }
      if (propagateFailure) {
        logCustomerVpsError(`provisioning job failed machineId=${row.machineId}`, err);
        throw mapped;
      }
      logCustomerVpsError(`provisioning job failed machineId=${row.machineId}`, err);
      return 'failed';
    }
  }

  async function dispatchProvisioningJobs(): Promise<{ checked: number; completed: number; failed: number }> {
    const jobs = await listDispatchableProvisioningJobs(
      deps.db,
      now().toISOString(),
      deps.config.reconciliationBatchSize,
    );
    let completed = 0;
    let failed = 0;
    for (const job of jobs) {
      const result = await dispatchProvisioningJob(job.jobId, false);
      if (result === 'completed') completed += 1;
      if (result === 'failed') failed += 1;
    }
    return { checked: jobs.length, completed, failed };
  }

  async function dispatchProvisioningJobBestEffort(jobId: string): Promise<void> {
    try {
      await dispatchProvisioningJob(jobId, true);
    } catch (err: unknown) {
      const code = err instanceof Error ? (err as Error & { code?: unknown }).code : undefined;
      const message = err instanceof Error ? err.message : '';
      if (code !== '25P02' && !message.includes('current transaction is aborted')) {
        throw err;
      }
      logCustomerVpsError('durable provisioning job immediate dispatch unavailable', err);
    }
  }

  async function dispatchProvisioningJobForRequest(
    jobId: string,
    dispatch: NonNullable<ProvisionOptions['dispatch']>,
  ): Promise<void> {
    if (dispatch === 'wait') {
      await dispatchProvisioningJobBestEffort(jobId);
      return;
    }
    try {
      scheduleProvisioningDispatch(async () => {
        try {
          await dispatchProvisioningJobBestEffort(jobId);
        } catch (err: unknown) {
          logCustomerVpsError('detached provisioning job dispatch failed', err);
        }
      });
    } catch (err: unknown) {
      // The job is durable and the reconciliation worker will claim it even if
      // this best-effort low-latency kick cannot be scheduled in this process.
      logCustomerVpsError('detached provisioning job scheduling failed', err);
    }
  }
  return { dispatchProvisioningJob, dispatchProvisioningJobs,
    dispatchProvisioningJobBestEffort, dispatchProvisioningJobForRequest };
}
