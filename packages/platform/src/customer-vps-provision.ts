import { withAccountDeletionAdmission } from './account-deletion/admission.js';
/** Customer VPS provisioning requests, split from customer-vps.ts. */
import type { PlatformDB, UserMachineProvisioningClass, UserMachineRecord } from './db.js';
import {
  getActiveUserMachineByClerkId,
  insertUserMachine,
  listActiveUserMachinesByClerkId,
  listNonDeletedUserMachinesByClerkId,
  lockUserMachineProvisioning,
  retireUserMachine,
  runInPlatformTransaction,
  updateUserMachine,
} from './db.js';
import {
  CustomerVpsError,
  PreviewSnapshotUnavailableError,
  logCustomerVpsError,
} from './customer-vps-errors.js';
import { type PreviewProvisionRequest, type ProvisionRequest } from './customer-vps-schema.js';
import { assertPreviewProvisioningCapacity, isPreviewMachine } from './customer-vps-preview.js';
import { resolveHostBundleRef } from './customer-vps-host-bundle.js';
import {
  DEFAULT_DEVELOPER_TOOLS,
  canonicalizeDeveloperTools,
  defaultDeveloperToolsForServerType,
  developerToolsAllowedForServerType,
} from './developer-tools.js';
import {
  getProvisioningJobByMachineId,
  sealProvisioningPayload,
} from './customer-vps-provisioning-jobs.js';
import {
  bindPrebillingIntentMachine,
  validatePrebillingProvisioningIntent,
} from './prebilling-provisioning-store.js';
import { bindTestSnapshotToPreviewProvisionInTransaction } from './golden-snapshot-preview-test.js';
import type { ProvisionResponse, ProvisionOptions } from './customer-vps-types.js';
import {
  activeProvisionResponse,
  findExistingProvisioningMachine,
  billingUpgradeRequired,
  resolveBillingProvisionContext,
} from './customer-vps-support.js';
import type { CustomerVpsContext } from './customer-vps-context.js';
import type { CustomerVpsProvisioningDispatcher } from './customer-vps-provisioning-dispatch.js';

/** Validates a provisioning request and records its machine and durable job. */
export function createCustomerVpsProvisioner(
  context: CustomerVpsContext,
  dispatcher: CustomerVpsProvisioningDispatcher,
) {
  const { deps, machineIdFactory, provisioningJobIdFactory, enqueueProvisioningJob, tokenFactory, postgresPasswordFactory, now, enqueueProviderDeletionTx } = context;
  const { dispatchProvisioningJobForRequest } = dispatcher;

  async function provision(
    input: ProvisionRequest | PreviewProvisionRequest,
    provisioningClass: UserMachineProvisioningClass,
    dispatch: NonNullable<ProvisionOptions['dispatch']>,
    prebillingIntentId?: string,
  ): Promise<ProvisionResponse> {
    const hasExplicitDeveloperTools = input.developerTools !== undefined;
    const testSnapshotId = provisioningClass === 'preview' && 'testSnapshotId' in input
      ? input.testSnapshotId
      : undefined;
    const previewBundleVersion = provisioningClass === 'preview' && 'bundleVersion' in input
      ? input.bundleVersion
      : undefined;
    const request = {
      ...input,
      runtimeSlot: input.runtimeSlot ?? 'primary',
      developerTools: canonicalizeDeveloperTools(input.developerTools ?? DEFAULT_DEVELOPER_TOOLS),
      accessClerkUserIds: provisioningClass === 'preview' && 'accessClerkUserIds' in input
        ? input.accessClerkUserIds
        : [],
    };
    const requestServerType = 'serverType' in request ? request.serverType : undefined;
    const requestLocation = 'location' in request ? request.location : undefined;
    const reconcilePreviewAccess = async (
      db: PlatformDB,
      machine: UserMachineRecord,
    ): Promise<UserMachineRecord> => {
      if (provisioningClass !== 'preview') return machine;
      if (testSnapshotId) {
        const existingJob = await getProvisioningJobByMachineId(db, machine.machineId);
        const matchesRequestedSnapshot = machine.provisioningClass === 'preview'
          && (machine.sourceSnapshotId === testSnapshotId || existingJob?.snapshotId === testSnapshotId);
        if (!matchesRequestedSnapshot) {
          throw new PreviewSnapshotUnavailableError('existing_machine_snapshot_mismatch');
        }
      }
      await updateUserMachine(db, machine.machineId, {
        accessClerkUserIds: request.accessClerkUserIds,
      });
      return { ...machine, accessClerkUserIds: request.accessClerkUserIds };
    };
    const currentTime = now();
    const machineId = machineIdFactory();
    const jobId = provisioningJobIdFactory();
    const registration = tokenFactory(currentTime, deps.config.registrationTokenTtlMs);
    const postgresPassword = postgresPasswordFactory();
    const encryptedPayload = sealProvisioningPayload({
      registrationToken: registration.token,
      postgresPassword,
    }, deps.config.platformSecret);
    const prebillingIntent = provisioningClass === 'customer' && prebillingIntentId
      ? await validatePrebillingProvisioningIntent(deps.db, {
          intentId: prebillingIntentId,
          clerkUserId: request.clerkUserId,
          runtimeSlot: request.runtimeSlot,
          serverType: requestServerType ?? '',
          regionSlug: `region_${requestLocation ?? deps.config.location}`,
          developerTools: request.developerTools,
          now: currentTime.toISOString(),
        })
      : undefined;
    if (prebillingIntentId && !prebillingIntent) {
      throw new CustomerVpsError(409, 'invalid_state', 'Provisioning unavailable');
    }
    const billingContext = provisioningClass === 'preview' || prebillingIntent
      ? null
      : await resolveBillingProvisionContext(deps, deps.db, request, currentTime);

    const resolvedServerType = prebillingIntent?.serverType
      ?? billingContext?.serverType
      ?? deps.config.serverType;
    if (
      provisioningClass === 'customer'
      && hasExplicitDeveloperTools
      && !developerToolsAllowedForServerType(resolvedServerType, request.developerTools)
    ) {
      throw new CustomerVpsError(400, 'invalid_state', 'Invalid request');
    }

    // Validate operator-selected preview bundles before the idempotent existing
    // machine return so retries cannot bypass the immutable release registry.
    const explicitPreviewBundleRef = previewBundleVersion
      ? await resolveHostBundleRef(deps.db, deps.config, undefined, previewBundleVersion)
      : undefined;

    // A non-failed active machine (provisioning/running converge; recovering
    // is rejected by activeProvisionResponse). A `failed` row is retryable, so
    // it must NOT short-circuit here — it is retired inside the transaction.
    const existingBeforeBundleResolve = await findExistingProvisioningMachine(
      deps.db,
      request,
      provisioningClass,
    );
    if (
      existingBeforeBundleResolve
      && existingBeforeBundleResolve.status !== 'failed'
      && !(provisioningClass === 'preview' && existingBeforeBundleResolve.runtimeSlot !== request.runtimeSlot)
      && (provisioningClass === 'customer' || existingBeforeBundleResolve.provisioningClass === 'preview')
    ) {
      if (prebillingIntentId && existingBeforeBundleResolve.prebillingIntentId !== prebillingIntentId) {
        throw new CustomerVpsError(409, 'invalid_state', 'Provisioning unavailable');
      }
      const reconciled = await reconcilePreviewAccess(deps.db, existingBeforeBundleResolve);
      const existingJob = await getProvisioningJobByMachineId(deps.db, existingBeforeBundleResolve.machineId);
      if (existingJob && (existingJob.status === 'queued' || existingJob.status === 'running')) {
        await dispatchProvisioningJobForRequest(existingJob.jobId, dispatch);
      }
      return activeProvisionResponse(reconciled, deps.config.provisionEtaSeconds);
    }

    const bundleRef = explicitPreviewBundleRef
      ?? await resolveHostBundleRef(deps.db, deps.config, testSnapshotId);

    let provisionRow: { existing: UserMachineRecord | null };
    try {
      provisionRow = await withAccountDeletionAdmission(deps.db, request.clerkUserId, async (trx) => {
      // Preview capacity and customer entitlement checks share the owner lock
      // with insertion so concurrent platform instances cannot over-allocate.
      if (billingContext || prebillingIntent || provisioningClass === 'preview') {
        await lockUserMachineProvisioning(trx, request.clerkUserId);
      }
      const transactionPrebillingIntent = prebillingIntentId
        ? await validatePrebillingProvisioningIntent(trx, {
            intentId: prebillingIntentId,
            clerkUserId: request.clerkUserId,
            runtimeSlot: request.runtimeSlot,
            serverType: requestServerType ?? '',
            regionSlug: `region_${requestLocation ?? deps.config.location}`,
            developerTools: request.developerTools,
            now: currentTime.toISOString(),
          })
        : undefined;
      if (prebillingIntentId && !transactionPrebillingIntent) {
        throw new CustomerVpsError(409, 'invalid_state', 'Provisioning unavailable');
      }
      const transactionBillingContext = provisioningClass === 'preview' || transactionPrebillingIntent
        ? null
        : await resolveBillingProvisionContext(deps, trx, request, currentTime);
      const existing = await findExistingProvisioningMachine(trx, request, provisioningClass);
      const retireFailedProvisioningMachine = async (failedMachine: UserMachineRecord): Promise<void> => {
        await retireUserMachine(trx, failedMachine.machineId, currentTime.toISOString());
        if (failedMachine.hetznerServerId !== null) {
          await enqueueProviderDeletionTx(trx, {
            providerServerId: failedMachine.hetznerServerId,
            reason: 'failed_retry_retire',
            machineId: failedMachine.machineId,
            handle: request.handle,
            detail: 'retiring failed machine before retry',
          });
        }
      };
      let attempt = 1;
      if (existing) {
        if (existing.status !== 'failed') {
          if (prebillingIntentId && existing.prebillingIntentId !== prebillingIntentId) {
            throw new CustomerVpsError(409, 'invalid_state', 'Provisioning unavailable');
          }
          if (testSnapshotId) {
            await reconcilePreviewAccess(trx, existing);
          }
          if (provisioningClass === 'preview' && existing.runtimeSlot !== request.runtimeSlot) {
            const failedExact = await getActiveUserMachineByClerkId(
              trx,
              request.clerkUserId,
              request.runtimeSlot,
            );
            if (failedExact?.status === 'failed' && failedExact.handle === request.handle) {
              await retireFailedProvisioningMachine(failedExact);
            }
          }
          if (provisioningClass === 'preview' && existing.provisioningClass !== 'preview') {
            const retainedMachines = await listNonDeletedUserMachinesByClerkId(trx, request.clerkUserId);
            assertPreviewProvisioningCapacity(retainedMachines, deps.config.previewProvisioningLimit);
            await updateUserMachine(trx, existing.machineId, {
              provisioningClass: 'preview',
              accessClerkUserIds: request.accessClerkUserIds,
            });
            return {
              existing: {
                ...existing,
                provisioningClass: 'preview' as const,
                accessClerkUserIds: request.accessClerkUserIds,
              },
            };
          }
          return { existing: await reconcilePreviewAccess(trx, existing) };
        }
        // The active slot is held by a failed attempt. Retire it, enqueue its
        // server for reaping, and provision a fresh one — all in one
        // transaction so the unique (clerk, slot) slot is satisfied at every
        // instant, the user is never blocked, and the retired server is never
        // orphaned (a failed enqueue rolls back the whole retry).
        attempt = existing.attempt + 1;
        if (attempt > deps.config.maxProvisionAttempts) {
          throw new CustomerVpsError(409, 'retry_exhausted', 'Provisioning retry limit reached');
        }
        if (provisioningClass === 'preview' && request.runtimeSlot !== 'preview') {
          const failedLegacy = await getActiveUserMachineByClerkId(
            trx,
            request.clerkUserId,
            'preview',
          );
          if (
            failedLegacy?.status === 'failed'
            && failedLegacy.handle === request.handle
            && failedLegacy.machineId !== existing.machineId
          ) {
            await retireFailedProvisioningMachine(failedLegacy);
          }
        }
        await retireFailedProvisioningMachine(existing);
      }
      if (provisioningClass === 'preview') {
        const retainedMachines = await listNonDeletedUserMachinesByClerkId(trx, request.clerkUserId);
        assertPreviewProvisioningCapacity(retainedMachines, deps.config.previewProvisioningLimit);
      } else if (transactionBillingContext?.entitlement.source === 'override') {
        const activeMachines = await listActiveUserMachinesByClerkId(trx, request.clerkUserId);
        const customerMachines = activeMachines.filter((machine) => !isPreviewMachine(machine));
        if (customerMachines.length >= transactionBillingContext.entitlement.maxRuntimeSlots) {
          throw billingUpgradeRequired();
        }
      }
      const serverType = transactionPrebillingIntent?.serverType
        ?? transactionBillingContext?.serverType
        ?? deps.config.serverType;
      const developerTools = provisioningClass === 'customer' && !hasExplicitDeveloperTools
        ? defaultDeveloperToolsForServerType(serverType)
        : request.developerTools;
      if (
        provisioningClass === 'customer'
        && !developerToolsAllowedForServerType(serverType, developerTools)
      ) {
        throw new CustomerVpsError(400, 'invalid_state', 'Invalid request');
      }
      await insertUserMachine(trx, {
        machineId,
        clerkUserId: request.clerkUserId,
        handle: request.handle,
        runtimeSlot: request.runtimeSlot,
        provisioningClass,
        accessClerkUserIds: request.accessClerkUserIds,
        status: 'provisioning',
        imageVersion: bundleRef.imageVersion,
        serverType,
        location: ('location' in request ? request.location : undefined) ?? deps.config.location,
        developerTools,
        registrationTokenHash: registration.hash,
        registrationTokenExpiresAt: registration.expiresAt,
        provisionedAt: currentTime.toISOString(),
        attempt,
        activationState: transactionPrebillingIntent ? 'awaiting_billing' : 'authorized',
        prebillingIntentId: transactionPrebillingIntent?.id ?? null,
      });
      await enqueueProvisioningJob(trx, {
        jobId,
        machineId,
        encryptedPayload,
        availableAt: currentTime.toISOString(),
        createdAt: currentTime.toISOString(),
        authorizationBasis: transactionPrebillingIntent ? 'prebilling_intent' : 'billing_entitlement',
        prebillingIntentId: transactionPrebillingIntent?.id ?? null,
      });
      if (transactionPrebillingIntent && !await bindPrebillingIntentMachine(trx, {
        intentId: transactionPrebillingIntent.id,
        machineId,
        expectedRevision: transactionPrebillingIntent.revision,
        now: currentTime.toISOString(),
      })) {
        throw new CustomerVpsError(409, 'invalid_state', 'Provisioning unavailable');
      }
      if (testSnapshotId) {
        const bound = await bindTestSnapshotToPreviewProvisionInTransaction(trx, {
          snapshotId: testSnapshotId,
          targetBundleVersion: bundleRef.imageVersion,
          serverType,
          machineId,
          provisioningJobId: jobId,
          now: currentTime.toISOString(),
        }, deps.config.goldenSnapshots);
        if (!bound) {
          throw new PreviewSnapshotUnavailableError('snapshot_binding_failed');
        }
      }
      return { existing: null };
      });
    } catch (err: unknown) {
      const errorCode = err instanceof Error
        ? (err as Error & { code?: unknown }).code
        : undefined;
      const errorMessage = err instanceof Error ? err.message : '';
      const raceLookupAttempts = errorCode === '23505'
        || errorMessage.includes('idx_user_machines_clerk_slot_active')
        || errorMessage.includes('current transaction is aborted')
        ? 3
        : 1;
      let concurrent: UserMachineRecord | undefined;
      for (let attempt = 0; attempt < raceLookupAttempts; attempt += 1) {
        try {
          concurrent = await findExistingProvisioningMachine(deps.db, request, provisioningClass);
        } catch (lookupErr: unknown) {
          logCustomerVpsError('provisioning convergence lookup unavailable', lookupErr);
          throw err;
        }
        if (concurrent?.status !== 'failed') break;
        if (attempt + 1 < raceLookupAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      if (
        concurrent
        && concurrent.status !== 'failed'
        && !(provisioningClass === 'preview' && concurrent.runtimeSlot !== request.runtimeSlot)
        && (provisioningClass === 'customer' || concurrent.provisioningClass === 'preview')
      ) {
        const reconciled = await reconcilePreviewAccess(deps.db, concurrent);
        const concurrentJob = await getProvisioningJobByMachineId(deps.db, concurrent.machineId);
        if (concurrentJob && (concurrentJob.status === 'queued' || concurrentJob.status === 'running')) {
          await dispatchProvisioningJobForRequest(concurrentJob.jobId, dispatch);
        }
        return activeProvisionResponse(reconciled, deps.config.provisionEtaSeconds);
      }
      throw err;
    }
    if (provisionRow.existing) {
      const existingJob = await getProvisioningJobByMachineId(deps.db, provisionRow.existing.machineId);
      if (existingJob && (existingJob.status === 'queued' || existingJob.status === 'running')) {
        await dispatchProvisioningJobForRequest(existingJob.jobId, dispatch);
      }
      return activeProvisionResponse(provisionRow.existing, deps.config.provisionEtaSeconds);
    }

    await dispatchProvisioningJobForRequest(jobId, dispatch);

    return {
      machineId,
      status: 'provisioning',
      etaSeconds: deps.config.provisionEtaSeconds,
    };
  }

  return { provision };
}
