import {
  assertMachineProviderMutationAllowed,
  allowedEntitlementServerTypes,
  billingUpgradeRequired,
  buildRecoveryServerName,
  buildServerName,
  findExistingProvisioningMachine,
  isAmbiguousProviderCreateError,
  normalizeServerType,
  statusResponse,
  toFailureCode,
  type StatusResponse,
} from './customer-vps-helpers.js';
import { randomUUID, randomBytes } from 'node:crypto';
import { DEFAULT_CLOUD_INIT_TEMPLATE, buildHostConfig } from './customer-vps-host-config.js';
import { sql } from 'kysely';
import type {
  PlatformDB,
  UserMachineProvisioningClass,
  UserMachineRecord,
} from './db.js';
import {
  claimUserMachineDelete,
  claimUserMachineRecovery,
  claimRunningUserMachineBillingSuspend,
  claimSuspendedUserMachineBillingResume,
  completeUserMachineBillingResume,
  completeUserMachineBillingSuspend,
  completeUserMachineRegistration,
  getActiveUserMachineByClerkId,
  getUserMachine,
  insertUserMachine,
  insertProviderDeletion,
  listActiveUserMachinesByClerkId,
  listNonDeletedUserMachinesByClerkId,
  listPendingProviderDeletions,
  listAllUserMachines,
  listRunningUserMachines,
  listStaleResizingUserMachines,
  listStaleUserMachines,
  lockUserMachineProvisioning,
  retireUserMachine,
  markProviderDeletionCompleted,
  markProviderDeletionFailed,
  parseNullableProviderActionId,
  runInPlatformTransaction,
  claimRunningUserMachineResize,
  completeUserMachineResize,
  updateUserMachine,
} from './db.js';
import type { CustomerVpsConfig } from './customer-vps-config.js';
import {
  createRegistrationToken,
  registrationTokenMatches,
  type RegistrationToken,
} from './customer-vps-auth.js';
import {
  buildPlatformVerificationToken,
} from './platform-token.js';
import type { HetznerClient } from './customer-vps-hetzner.js';
import {
  CustomerVpsError,
  PreviewSnapshotUnavailableError,
  genericProviderError,
  logCustomerVpsError,
  type CustomerVpsFailureCode,
} from './customer-vps-errors.js';
import { buildVpsMeta, type CustomerVpsSystemStore } from './customer-vps-r2.js';
import { createVpsPollingOperations } from './customer-vps-polling.js';
import { createVpsDeletionOperations } from './customer-vps-deletion.js';
import { createVpsRecoveryOperations } from './customer-vps-recovery.js';
import { createVpsDispatchOperations } from './customer-vps-dispatch.js';
import {
  renderCloudInitTemplate,
} from './customer-vps-cloud-init.js';
import {
  PreviewProvisionRequestSchema,
  PublicIPv4Schema,
  type CustomerVpsStatus,
  type PreviewProvisionInput,
  type PreviewProvisionRequest,
  type ProvisionRequest,
  type RegisterRequest,
  type RecoverRequest,
  type ResizeMachineRequest,
} from './customer-vps-schema.js';
import { assertPreviewProvisioningCapacity, isPreviewMachine } from './customer-vps-preview.js';
import {
  hostBundleUrlForImageVersion,
  resolveHostBundleRef,
  type HostBundleRef,
} from './customer-vps-host-bundle.js';
import { selectCustomerVpsDeployMachines } from './customer-vps-deploy-selection.js';
import {
  getRuntimeAccessDecision,
  type BillingEntitlement,
} from './billing.js';
import {
  DEFAULT_DEVELOPER_TOOLS,
  canonicalizeDeveloperTools,
  defaultDeveloperToolsForServerType,
  developerToolsAllowedForServerType,
} from './developer-tools.js';
import {
  claimProvisioningJob,
  completeProvisioningJob,
  failProvisioningJob,
  getProvisioningJob,
  getProvisioningJobByMachineId,
  insertProvisioningJob,
  listDispatchableProvisioningJobs,
  MAX_PROVISIONING_JOB_ATTEMPTS,
  openProvisioningPayload,
  sealProvisioningPayload,
  type NewProvisioningJob,
  type ProvisioningPayload,
} from './customer-vps-provisioning-jobs.js';
import {
  bindPrebillingIntentMachine,
  markPrebillingIntentReady,
  validatePrebillingProvisioningIntent,
} from './prebilling-provisioning-store.js';
import { isProvisioningJobAuthorized, persistProvisioningClaimMutation } from './customer-vps-prebilling.js';
import {
  chooseProvisioningImage,
  chooseRecoveryImage,
  fallbackProvisioningImage,
  type ProvisioningImageDecision,
} from './golden-snapshot-activation.js';
import {
  createGoldenSnapshotCreateIntent,
  getGoldenSnapshot,
  getGoldenSnapshotRecoveryRegistrationTarget,
  markGoldenSnapshotCreateIntentAccepted,
  releaseGoldenSnapshotLease,
  releaseGoldenSnapshotLeaseInTransaction,
} from './golden-snapshot-repository.js';
import {
  bindTestSnapshotToPreviewProvisionInTransaction,
  createPreviewTestSnapshotCreateIntent,
  isPreviewTestSnapshotDecision,
  resolvePersistedProvisioningImage,
} from './golden-snapshot-preview-test.js';

export interface ProvisionResponse {
  machineId: string;
  status: 'provisioning' | 'running';
  etaSeconds: number;
}

export interface ProvisionOptions {
  dispatch?: 'wait' | 'detached';
}

export interface RegisterResponse {
  registered: true;
  status: 'running';
  warnings?: string[];
}

export interface DeleteResponse {
  deleted: true;
  machineId: string;
  status: 'deleted';
}

export interface RecoverResponse {
  oldMachineId: string | null;
  machineId: string;
  runtimeSlot: string;
  status: 'recovering';
  etaSeconds: number;
}

export interface ResizeResponse {
  machineId: string;
  serverType: string;
  status: 'running';
}

export interface DeployResult {
  triggered: number;
  failed: number;
  results: Array<{ machineId: string; handle: string; status: 'triggered' | 'failed'; error?: string }>;
}

export interface DeployTarget {
  version?: string;
  channel?: 'stable' | 'canary' | 'beta' | 'dev';
  handle?: string;
}

export interface CustomerVpsService {
  provision(input: ProvisionRequest, options?: ProvisionOptions): Promise<ProvisionResponse>;
  provisionForCheckout(
    input: ProvisionRequest,
    prebillingIntentId: string,
    options?: ProvisionOptions,
  ): Promise<ProvisionResponse>;
  provisionPreview(input: PreviewProvisionInput): Promise<ProvisionResponse>;
  register(token: string | undefined, input: RegisterRequest): Promise<RegisterResponse>;
  recover(input: RecoverRequest): Promise<RecoverResponse>;
  resize(input: ResizeMachineRequest & { machineId: string }): Promise<ResizeResponse>;
  suspendForBilling(machineId: string, shouldContinue?: () => Promise<boolean>): Promise<void>;
  resumeForBilling(machineId: string, shouldContinue?: () => Promise<boolean>): Promise<void>;
  status(machineId: string): Promise<StatusResponse>;
  delete(machineId: string): Promise<DeleteResponse>;
  deploy(target?: DeployTarget): Promise<DeployResult>;
  listAllMachines(): Promise<StatusResponse[]>;
  dispatchProvisioningJobs(): Promise<{ checked: number; completed: number; failed: number }>;
  setPrebillingFallbackReconciler?(reconcile: (() => Promise<unknown>) | undefined): void;
  reconcileProvisioning(): Promise<{ checked: number; failed: number; running: number }>;
}

export interface CustomerVpsServiceDeps {
  db: PlatformDB;
  config: CustomerVpsConfig;
  hetzner: HetznerClient;
  systemStore: CustomerVpsSystemStore;
  cloudInitTemplate?: string;
  machineIdFactory?: () => string;
  tokenFactory?: (now: Date, ttlMs: number) => RegistrationToken;
  postgresPasswordFactory?: () => string;
  now?: () => Date;
  provisioningJobIdFactory?: () => string;
  enqueueProvisioningJob?: (db: PlatformDB, job: NewProvisioningJob) => Promise<void>;
  scheduleProvisioningDispatch?: (dispatch: () => Promise<void>) => void;
  fetchDispatcher?: import('undici').Dispatcher;
  resolveBillingEntitlement?: (
    db: PlatformDB,
    clerkUserId: string,
    runtimeSlot: string,
  ) => Promise<BillingEntitlement | null | undefined>;
}

function activeProvisionResponse(row: UserMachineRecord, etaSeconds: number): ProvisionResponse {
  if (row.status !== 'provisioning' && row.status !== 'running') {
    throw new CustomerVpsError(409, 'invalid_state', 'Machine is not provisionable');
  }
  return {
    machineId: row.machineId,
    status: row.status,
    etaSeconds,
  };
}

function resolveDefaultEntitlementServerType(entitlement: BillingEntitlement): string {
  const allowedServerTypes = allowedEntitlementServerTypes(entitlement);
  const defaultServerType = normalizeServerType(entitlement.defaultServerType);
  if (defaultServerType && allowedServerTypes.includes(defaultServerType)) {
    return defaultServerType;
  }
  const fallbackServerType = allowedServerTypes[0];
  if (!fallbackServerType) {
    throw billingUpgradeRequired();
  }
  return fallbackServerType;
}

async function resolveBillingProvisionContext(
  deps: CustomerVpsServiceDeps,
  db: PlatformDB,
  input: ProvisionRequest,
  now: Date,
): Promise<{ entitlement: BillingEntitlement; serverType: string } | null> {
  if (!deps.resolveBillingEntitlement) {
    return null;
  }
  const entitlement = await deps.resolveBillingEntitlement(db, input.clerkUserId, input.runtimeSlot ?? 'primary');
  const access = getRuntimeAccessDecision(entitlement, now);
  if (!entitlement || !access.runtimeProxyAllowed) {
    throw billingUpgradeRequired();
  }
  const serverType = input.serverType
    ? normalizeServerType(input.serverType)
    : resolveDefaultEntitlementServerType(entitlement);
  if (!allowedEntitlementServerTypes(entitlement).includes(serverType)) {
    throw billingUpgradeRequired();
  }
  return { entitlement, serverType };
}

async function resolveBillingRecoveryContext(
  deps: CustomerVpsServiceDeps,
  clerkUserId: string,
  runtimeSlot: string,
  existingServerType: string | null,
  now: Date,
): Promise<{ serverType: string } | null> {
  if (!deps.resolveBillingEntitlement) {
    return null;
  }
  const entitlement = await deps.resolveBillingEntitlement(deps.db, clerkUserId, runtimeSlot);
  const access = getRuntimeAccessDecision(entitlement, now);
  if (!entitlement || !access.runtimeProxyAllowed) {
    throw billingUpgradeRequired();
  }
  const normalizedExistingServerType = existingServerType ? normalizeServerType(existingServerType) : null;
  const allowedServerTypes = allowedEntitlementServerTypes(entitlement);
  const serverType = normalizedExistingServerType && allowedServerTypes.includes(normalizedExistingServerType)
    ? normalizedExistingServerType
    : resolveDefaultEntitlementServerType(entitlement);
  if (!allowedServerTypes.includes(serverType)) {
    throw billingUpgradeRequired();
  }
  return { serverType };
}

const MAX_LOCAL_PROVISION_LOCKS = 1_024;
const MAX_LOCAL_PROVISION_QUEUE_DEPTH = 20;

export function createCustomerVpsService(deps: CustomerVpsServiceDeps): CustomerVpsService {
  const machineIdFactory = deps.machineIdFactory ?? randomUUID;
  const provisioningJobIdFactory = deps.provisioningJobIdFactory ?? randomUUID;
  const localProvisionLocks = new Map<string, { tail: Promise<void>; depth: number }>();
  let prebillingFallbackReconciler: (() => Promise<unknown>) | undefined;

  async function withLocalProvisionLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let lock = localProvisionLocks.get(key);
    if (!lock) {
      if (localProvisionLocks.size >= MAX_LOCAL_PROVISION_LOCKS) {
        throw new CustomerVpsError(503, 'provider_unavailable', 'Provisioning unavailable');
      }
      lock = { tail: Promise.resolve(), depth: 0 };
      localProvisionLocks.set(key, lock);
    }
    if (lock.depth >= MAX_LOCAL_PROVISION_QUEUE_DEPTH) {
      throw new CustomerVpsError(429, 'provider_unavailable', 'Try again later');
    }

    const predecessor = lock.tail;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    lock.tail = predecessor.then(() => gate);
    lock.depth += 1;
    await predecessor;
    try {
      return await fn();
    } finally {
      release();
      lock.depth -= 1;
      if (lock.depth === 0 && localProvisionLocks.get(key) === lock) {
        localProvisionLocks.delete(key);
      }
    }
  }
  const enqueueProvisioningJob = deps.enqueueProvisioningJob ?? insertProvisioningJob;
  const scheduleProvisioningDispatch = deps.scheduleProvisioningDispatch
    ?? ((dispatch: () => Promise<void>) => queueMicrotask(() => { void dispatch(); }));
  const tokenFactory = deps.tokenFactory ?? createRegistrationToken;
  const postgresPasswordFactory = deps.postgresPasswordFactory ?? (() => randomBytes(24).toString('base64url'));
  const now = deps.now ?? (() => new Date());

  const polling = createVpsPollingOperations({
    db: deps.db,
    hetzner: deps.hetzner,
    fetchDispatcher: deps.fetchDispatcher,
    now,
  });

  const deletionOps = createVpsDeletionOperations({
    db: deps.db,
    hetzner: deps.hetzner,
    systemStore: deps.systemStore,
    config: deps.config,
    polling,
    now,
  });

  const recoveryOps = createVpsRecoveryOperations({
    db: deps.db,
    hetzner: deps.hetzner,
    config: deps.config,
    cloudInitTemplate: deps.cloudInitTemplate ?? DEFAULT_CLOUD_INIT_TEMPLATE,
    polling,
    now,
  });

  const dispatchOps = createVpsDispatchOperations({
    db: deps.db,
    hetzner: deps.hetzner,
    config: deps.config,
    cloudInitTemplate: deps.cloudInitTemplate ?? DEFAULT_CLOUD_INIT_TEMPLATE,
    polling,
    deletion: deletionOps,
    scheduleProvisioningDispatch,
    resolveBillingEntitlement: deps.resolveBillingEntitlement,
    now,
  });


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
        await dispatchOps.dispatchProvisioningJobForRequest(existingJob.jobId, dispatch);
      }
      return activeProvisionResponse(reconciled, deps.config.provisionEtaSeconds);
    }

    const bundleRef = explicitPreviewBundleRef
      ?? await resolveHostBundleRef(deps.db, deps.config, testSnapshotId);

    let provisionRow: { existing: UserMachineRecord | null };
    try {
      provisionRow = await runInPlatformTransaction(deps.db, async (trx) => {
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
          await deletionOps.enqueueProviderDeletionTx(trx, {
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
          await dispatchOps.dispatchProvisioningJobForRequest(concurrentJob.jobId, dispatch);
        }
        return activeProvisionResponse(reconciled, deps.config.provisionEtaSeconds);
      }
      throw err;
    }
    if (provisionRow.existing) {
      const existingJob = await getProvisioningJobByMachineId(deps.db, provisionRow.existing.machineId);
      if (existingJob && (existingJob.status === 'queued' || existingJob.status === 'running')) {
        await dispatchOps.dispatchProvisioningJobForRequest(existingJob.jobId, dispatch);
      }
      return activeProvisionResponse(provisionRow.existing, deps.config.provisionEtaSeconds);
    }

    await dispatchOps.dispatchProvisioningJobForRequest(jobId, dispatch);

    return {
      machineId,
      status: 'provisioning',
      etaSeconds: deps.config.provisionEtaSeconds,
    };
  }

  return {
    async provision(input, options) {
      return withLocalProvisionLock(
        `${input.clerkUserId}:${input.runtimeSlot ?? 'primary'}`,
        () => provision(input, 'customer', options?.dispatch ?? 'wait'),
      );
    },

    async provisionForCheckout(input, intentId, options) {
      return withLocalProvisionLock(
        `${input.clerkUserId}:${input.runtimeSlot ?? 'primary'}`,
        () => provision(input, 'customer', options?.dispatch ?? 'wait', intentId),
      );
    },

    async provisionPreview(input) {
      const request = PreviewProvisionRequestSchema.parse(input);
      return withLocalProvisionLock(
        `${request.clerkUserId}:${request.runtimeSlot}`,
        () => provision(request, 'preview', 'wait'),
      );
    },

    async register(token, input) {
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
          await deletionOps.enqueueProviderDeletionTx(trx, {
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
    },

    async recover(input) {
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
              await polling.removeRejectedRecoveryServer({ serverId: server.id, machineId, handle: existing.handle });
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
          const createResult = await polling.waitForRecoveryCreateAction(server.createActionId);
          if (createResult === 'error') {
            if (recoveryImage.imageSource !== 'snapshot') {
              throw new CustomerVpsError(500, 'provider_unavailable', 'Provisioning provider unavailable');
            }
            const removed = await polling.removeRejectedRecoveryServer({
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
              const fallbackCreateResult = await polling.waitForRecoveryCreateAction(server.createActionId);
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
            await polling.queueProviderDeletion({
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
    },

    async suspendForBilling(machineId, shouldContinue) {
      if (shouldContinue && !(await shouldContinue())) return;
      const current = await getUserMachine(deps.db, machineId);
      if (!current || current.deletedAt) {
        throw new CustomerVpsError(404, 'not_found', 'Machine not found');
      }
      if (current.status === 'suspended') return;
      if (current.hetznerServerId === null) {
        throw new CustomerVpsError(409, 'invalid_state', 'Machine cannot suspend');
      }
      if (shouldContinue && !(await shouldContinue())) return;
      let claimed = current;
      if (current.status === 'running' || current.status === 'resuming') {
        const transitioned = await claimRunningUserMachineBillingSuspend(
          deps.db,
          current.machineId,
          current.hetznerServerId,
        );
        if (!transitioned) {
          throw new CustomerVpsError(409, 'invalid_state', 'Machine cannot suspend');
        }
        claimed = transitioned;
      } else if (current.status !== 'suspending') {
        throw new CustomerVpsError(409, 'invalid_state', 'Machine cannot suspend');
      }
      const providerServerId = claimed.hetznerServerId;
      if (providerServerId === null) {
        throw new CustomerVpsError(409, 'invalid_state', 'Machine cannot suspend');
      }

      const server = await deps.hetzner.getServer(providerServerId);
      if (!server) {
        throw new CustomerVpsError(500, 'provider_unavailable', 'Provisioning provider unavailable');
      }
      if (server.status !== 'off') {
        if (shouldContinue && !(await shouldContinue())) return;
        try {
          await deps.hetzner.shutdownServer(providerServerId);
          if (!(await polling.waitForServerStatus(
            providerServerId,
            'off',
            'billing-shutdown',
            shouldContinue,
          ))) return;
        } catch (err: unknown) {
          logCustomerVpsError(`billing graceful shutdown failed machineId=${claimed.machineId}`, err);
          if (shouldContinue && !(await shouldContinue())) return;
          await deps.hetzner.powerOffServer(providerServerId);
          if (!(await polling.waitForServerStatus(
            providerServerId,
            'off',
            'billing-poweroff',
            shouldContinue,
          ))) return;
        }
      }
      if (shouldContinue && !(await shouldContinue())) return;
      const completed = await completeUserMachineBillingSuspend(
        deps.db,
        claimed.machineId,
        providerServerId,
      );
      if (!completed) {
        const latest = await getUserMachine(deps.db, claimed.machineId);
        if (latest?.status !== 'suspended') {
          throw new CustomerVpsError(409, 'invalid_state', 'Machine cannot suspend');
        }
      }
    },

    async resumeForBilling(machineId, shouldContinue) {
      if (shouldContinue && !(await shouldContinue())) return;
      const current = await getUserMachine(deps.db, machineId);
      if (!current || current.deletedAt) {
        throw new CustomerVpsError(404, 'not_found', 'Machine not found');
      }
      if (current.status === 'running') return;
      if (current.hetznerServerId === null) {
        throw new CustomerVpsError(409, 'invalid_state', 'Machine cannot resume');
      }
      if (shouldContinue && !(await shouldContinue())) return;
      let claimed = current;
      if (current.status === 'suspended' || current.status === 'suspending') {
        const transitioned = await claimSuspendedUserMachineBillingResume(
          deps.db,
          current.machineId,
          current.hetznerServerId,
        );
        if (!transitioned) {
          throw new CustomerVpsError(409, 'invalid_state', 'Machine cannot resume');
        }
        claimed = transitioned;
      } else if (current.status !== 'resuming') {
        throw new CustomerVpsError(409, 'invalid_state', 'Machine cannot resume');
      }
      const providerServerId = claimed.hetznerServerId;
      if (providerServerId === null) {
        throw new CustomerVpsError(409, 'invalid_state', 'Machine cannot resume');
      }

      const server = await deps.hetzner.getServer(providerServerId);
      if (!server) {
        throw new CustomerVpsError(500, 'provider_unavailable', 'Provisioning provider unavailable');
      }
      if (server.status !== 'running') {
        if (shouldContinue && !(await shouldContinue())) return;
        await deps.hetzner.powerOnServer(providerServerId);
        if (!(await polling.waitForServerStatus(
          providerServerId,
          'running',
          'billing-poweron',
          shouldContinue,
        ))) return;
      }
      if (!(await polling.waitForRuntimeHealth(claimed, shouldContinue))) return;
      if (shouldContinue && !(await shouldContinue())) return;
      const completed = await completeUserMachineBillingResume(
        deps.db,
        claimed.machineId,
        providerServerId,
      );
      if (!completed) {
        const latest = await getUserMachine(deps.db, claimed.machineId);
        if (latest?.status !== 'running') {
          throw new CustomerVpsError(409, 'invalid_state', 'Machine cannot resume');
        }
      }
    },

    async resize(input) {
      const row = await getUserMachine(deps.db, input.machineId);
      if (!row || row.deletedAt) {
        throw new CustomerVpsError(404, 'not_found', 'Machine not found');
      }
      if (row.status !== 'running' || row.hetznerServerId === null) {
        throw new CustomerVpsError(409, 'invalid_state', 'Machine cannot resize');
      }
      if (row.serverType === input.serverType) {
        return {
          machineId: row.machineId,
          serverType: input.serverType,
          status: 'running',
        };
      }

      await assertMachineProviderMutationAllowed(deps, row, input.serverType, now());
      const claimed = await claimRunningUserMachineResize(
        deps.db,
        row.machineId,
        row.hetznerServerId,
        now().toISOString(),
        input.serverType,
      );
      if (!claimed) {
        throw new CustomerVpsError(409, 'invalid_state', 'Machine cannot resize');
      }

      let serverConfirmedOff = false;
      let resizeAccepted = false;
      let powerOffAccepted = false;
      let powerOnAccepted = false;
      try {
        try {
          await deps.hetzner.shutdownServer(claimed.hetznerServerId!);
          await polling.waitForServerStatus(claimed.hetznerServerId!, 'off', 'shutdown');
        } catch (shutdownErr: unknown) {
          logCustomerVpsError(`resize graceful shutdown failed machineId=${claimed.machineId}`, shutdownErr);
          await deps.hetzner.powerOffServer(claimed.hetznerServerId!);
          powerOffAccepted = true;
          await polling.waitForServerStatus(claimed.hetznerServerId!, 'off', 'poweroff');
        }
        serverConfirmedOff = true;
        await deps.hetzner.resizeServer(claimed.hetznerServerId!, {
          serverType: input.serverType,
          upgradeDisk: false,
        });
        resizeAccepted = true;
        await polling.waitForServerStatus(claimed.hetznerServerId!, 'off', 'resize');
        await deps.hetzner.powerOnServer(claimed.hetznerServerId!);
        serverConfirmedOff = false;
        powerOnAccepted = true;
        await polling.waitForServerStatus(claimed.hetznerServerId!, 'running', 'poweron');
        const updated = await completeUserMachineResize(
          deps.db,
          claimed.machineId,
          claimed.hetznerServerId!,
          {
            status: 'running',
            serverType: input.serverType,
            failureCode: null,
            failureAt: null,
            resizeStartedAt: null,
            resizeTargetServerType: null,
          },
        );
        if (!updated) {
          logCustomerVpsError(
            `resize completion lost machineId=${claimed.machineId} hetznerServerId=${claimed.hetznerServerId}`,
            new Error('resizing row no longer matched guarded completion update'),
          );
          throw new CustomerVpsError(409, 'invalid_state', 'Machine cannot resize');
        }
        return {
          machineId: updated.machineId,
          serverType: updated.serverType ?? input.serverType,
          status: 'running',
        };
      } catch (err: unknown) {
        const mapped = genericProviderError(err);
        if (powerOnAccepted) {
          logCustomerVpsError(
            `resize poweron pending machineId=${claimed.machineId}`,
            new Error('poweron accepted but running status was not confirmed'),
          );
          throw mapped;
        }
        if (powerOffAccepted && !serverConfirmedOff) {
          logCustomerVpsError(
            `resize poweroff pending machineId=${claimed.machineId}`,
            new Error('poweroff accepted but off status was not confirmed'),
          );
          throw mapped;
        }
        if (resizeAccepted && serverConfirmedOff) {
          logCustomerVpsError(
            `resize provider change pending machineId=${claimed.machineId}`,
            new Error('resize accepted but settled off status was not confirmed'),
          );
          throw mapped;
        }
        let restoredRunning = !serverConfirmedOff;
        if (serverConfirmedOff) {
          let rollbackPowerOnAccepted = false;
          try {
            await deps.hetzner.powerOnServer(claimed.hetznerServerId!);
            rollbackPowerOnAccepted = true;
            await polling.waitForServerStatus(claimed.hetznerServerId!, 'running', 'rollback-poweron');
            restoredRunning = true;
          } catch (powerOnErr: unknown) {
            logCustomerVpsError(`resize rollback poweron failed machineId=${claimed.machineId}`, powerOnErr);
            if (rollbackPowerOnAccepted) {
              logCustomerVpsError(
                `resize rollback poweron pending machineId=${claimed.machineId}`,
                new Error('rollback poweron accepted but running status was not confirmed'),
              );
              throw mapped;
            }
          }
        }

        const restored = await completeUserMachineResize(
          deps.db,
          claimed.machineId,
          claimed.hetznerServerId!,
          restoredRunning
            ? {
                status: 'running',
                serverType: resizeAccepted ? input.serverType : row.serverType,
                failureCode: null,
                failureAt: null,
                resizeStartedAt: null,
                resizeTargetServerType: null,
              }
            : {
                status: 'failed',
                serverType: resizeAccepted ? input.serverType : row.serverType,
                failureCode: toFailureCode(err),
                failureAt: now().toISOString(),
                resizeStartedAt: null,
                resizeTargetServerType: null,
              },
        );
        if (!restored) {
          logCustomerVpsError(
            `resize rollback lost machineId=${claimed.machineId} hetznerServerId=${claimed.hetznerServerId}`,
            new Error('resizing row no longer matched guarded rollback update'),
          );
        }
        throw mapped;
      }
    },

    async status(machineId) {
      const row = await getUserMachine(deps.db, machineId);
      if (!row) {
        throw new CustomerVpsError(404, 'not_found', 'Machine not found');
      }
      return statusResponse(row);
    },

    async delete(machineId) {
      const row = await claimUserMachineDelete(deps.db, machineId, now().toISOString());
      if (!row) {
        const existing = await getUserMachine(deps.db, machineId);
        if (existing && !existing.deletedAt) {
          throw new CustomerVpsError(409, 'invalid_state', 'Machine cannot delete');
        }
        throw new CustomerVpsError(404, 'not_found', 'Machine not found');
      }
      if (row.hetznerServerId) {
        try {
          await deps.hetzner.deleteServer(row.hetznerServerId);
        } catch (err: unknown) {
          logCustomerVpsError('delete server cleanup failed', err);
          await polling.queueProviderDeletion({
            providerServerId: row.hetznerServerId,
            reason: 'delete',
            machineId,
            handle: row.handle,
            err,
          });
        }
      }
      return { deleted: true, machineId, status: 'deleted' };
    },

    async listAllMachines(): Promise<StatusResponse[]> {
      const machines = await listAllUserMachines(deps.db, 500);
      return machines.map(statusResponse);
    },

    dispatchProvisioningJobs: () => dispatchOps.dispatchProvisioningJobs(),
    setPrebillingFallbackReconciler(reconcile) { prebillingFallbackReconciler = reconcile; },

    async deploy(target?: DeployTarget): Promise<DeployResult> {
      const runningMachines = await listRunningUserMachines(
        deps.db,
        500,
        target?.handle
          ? { handle: target.handle }
          : { provisioningClass: 'customer' },
      );
      const machines = selectCustomerVpsDeployMachines(runningMachines, target);
      const results: DeployResult['results'] = [];
      let triggered = 0;
      let failed = 0;

      await Promise.allSettled(machines.map(async (machine) => {
        if (!machine.publicIPv4) {
          results.push({ machineId: machine.machineId, handle: machine.handle, status: 'failed', error: 'no IP' });
          failed++;
          return;
        }
        const token = buildPlatformVerificationToken(machine.handle, deps.config.platformSecret);
        const body = target?.version
          ? JSON.stringify({ version: target.version })
          : target?.channel
            ? JSON.stringify({ channel: target.channel })
            : '{}';
        try {
          const res = await fetch(`https://${machine.publicIPv4}:443/api/system/update`, {
            method: 'POST',
            headers: {
              'authorization': `Bearer ${token}`,
              'content-type': 'application/json',
            },
            body,
            signal: AbortSignal.timeout(10_000),
            ...(deps.fetchDispatcher ? { dispatcher: deps.fetchDispatcher } : {}),
          } as RequestInit & { dispatcher?: import('undici').Dispatcher });
          if (res.ok) {
            results.push({ machineId: machine.machineId, handle: machine.handle, status: 'triggered' });
            triggered++;
          } else {
            results.push({ machineId: machine.machineId, handle: machine.handle, status: 'failed', error: `HTTP ${res.status}` });
            failed++;
          }
        } catch (err) {
          results.push({ machineId: machine.machineId, handle: machine.handle, status: 'failed', error: (err as Error).message });
          failed++;
        }
      }));

      return { triggered, failed, results };
    },

    async reconcileProvisioning() {
      await dispatchOps.dispatchProvisioningJobs();
      await prebillingFallbackReconciler?.();
      const staleBefore = new Date(now().getTime() - deps.config.reconciliationStaleAfterMs).toISOString();
      const rows = await listStaleUserMachines(
        deps.db,
        ['provisioning', 'recovering'],
        staleBefore,
        deps.config.reconciliationBatchSize,
      );
      const resizingRows = await listStaleResizingUserMachines(
        deps.db,
        staleBefore,
        deps.config.reconciliationBatchSize,
      );
      let failed = 0;
      let running = 0;
      for (let row of rows) {
        if (row.status === 'recovering') {
          const recoveryCreate = await recoveryOps.reconcilePendingRecoveryCreate(row);
          if (recoveryCreate === 'pending') continue;
          if (recoveryCreate === 'failed') {
            failed += 1;
            continue;
          }
          const refreshed = await getUserMachine(deps.db, row.machineId)
            ?? await getActiveUserMachineByClerkId(deps.db, row.clerkUserId, row.runtimeSlot);
          if (!refreshed) continue;
          row = refreshed;
        }
        if (!row.hetznerServerId) {
          await deletionOps.cleanupUntrackedServersForMachine(row);
          await updateUserMachine(deps.db, row.machineId, {
            status: 'failed',
            failureCode: 'provider_unavailable',
            failureAt: now().toISOString(),
          });
          failed += 1;
          continue;
        }
        const server = await deps.hetzner.getServer(row.hetznerServerId);
        if (!server) {
          await updateUserMachine(deps.db, row.machineId, {
            status: 'failed',
            failureCode: 'not_found',
            failureAt: now().toISOString(),
          });
          failed += 1;
          continue;
        }
        // The server booted but the host never called register() before its
        // registration token expired. It can never become routable, so fail it
        // (freeing the slot for retry) and reap the abandoned server.
        if (
          row.registrationTokenExpiresAt &&
          new Date(row.registrationTokenExpiresAt).getTime() < now().getTime()
        ) {
          // Mark failed and enqueue the server for reaping atomically: once the
          // row is `failed` it leaves listStaleUserMachines, so if the enqueue
          // were a separate write that failed, the server would be orphaned
          // forever. Rolling back keeps the row reconcilable next pass.
          const serverId = row.hetznerServerId;
          await runInPlatformTransaction(deps.db, async (trx) => {
            await updateUserMachine(trx, row.machineId, {
              status: 'failed',
              failureCode: 'registration_timeout',
              failureAt: now().toISOString(),
            });
            await deletionOps.enqueueProviderDeletionTx(trx, {
              providerServerId: serverId,
              reason: 'registration_timeout',
              machineId: row.machineId,
              handle: row.handle,
              detail: 'registration token expired before register()',
            });
          });
          failed += 1;
          continue;
        }
        if (server.status === 'running' && server.publicIPv4) {
          // Hetzner "running" only proves the VM booted; the host must call
          // register() before this machine becomes routable.
          await updateUserMachine(deps.db, row.machineId, {
            publicIPv4: server.publicIPv4,
            publicIPv6: server.publicIPv6,
          });
          running += 1;
        }
      }
      for (const row of resizingRows) {
        if (!row.hetznerServerId) {
          await updateUserMachine(deps.db, row.machineId, {
            status: 'failed',
            failureCode: 'provider_unavailable',
            failureAt: now().toISOString(),
            resizeStartedAt: null,
            resizeTargetServerType: null,
          });
          failed += 1;
          continue;
        }
        const server = await deps.hetzner.getServer(row.hetznerServerId);
        if (!server) {
          await updateUserMachine(deps.db, row.machineId, {
            status: 'failed',
            failureCode: 'not_found',
            failureAt: now().toISOString(),
            resizeStartedAt: null,
            resizeTargetServerType: null,
          });
          failed += 1;
          continue;
        }
        if (server.status === 'off') {
          try {
            await deps.hetzner.powerOnServer(row.hetznerServerId);
            await polling.waitForServerStatus(row.hetznerServerId, 'running', 'reconcile-resize-poweron');
          } catch (err: unknown) {
            logCustomerVpsError(`resize reconcile poweron failed machineId=${row.machineId}`, err);
            continue;
          }
        } else if (server.status !== 'running') {
          logCustomerVpsError(
            `resize reconcile waiting machineId=${row.machineId}`,
            new Error(`server status ${server.status}`),
          );
          continue;
        }
        let latestServer = server.status === 'running' ? server : null;
        if (!latestServer) {
          try {
            latestServer = await deps.hetzner.getServer(row.hetznerServerId);
          } catch (err: unknown) {
            logCustomerVpsError(`resize reconcile server refresh failed machineId=${row.machineId}`, err);
            continue;
          }
        }
        if (!latestServer || latestServer.status !== 'running') {
          continue;
        }
        const targetServerType = row.resizeTargetServerType;
        if (targetServerType && !latestServer.serverType) {
          logCustomerVpsError(
            `resize reconcile missing server type machineId=${row.machineId}`,
            new Error(`target ${targetServerType}`),
          );
          continue;
        }
        if (targetServerType && latestServer.serverType !== targetServerType) {
          const completed = await completeUserMachineResize(
            deps.db,
            row.machineId,
            row.hetznerServerId,
            {
              status: 'running',
              serverType: latestServer.serverType,
              publicIPv4: latestServer.publicIPv4 ?? row.publicIPv4,
              publicIPv6: latestServer.publicIPv6 ?? row.publicIPv6,
              failureCode: 'resize_interrupted',
              failureAt: now().toISOString(),
              resizeStartedAt: null,
              resizeTargetServerType: null,
            },
          );
          if (completed) {
            failed += 1;
          }
          continue;
        }
        const completed = await completeUserMachineResize(
          deps.db,
          row.machineId,
          row.hetznerServerId,
          {
            status: 'running',
            serverType: latestServer.serverType ?? row.resizeTargetServerType ?? row.serverType,
            publicIPv4: latestServer.publicIPv4 ?? row.publicIPv4,
            publicIPv6: latestServer.publicIPv6 ?? row.publicIPv6,
            failureCode: null,
            failureAt: null,
            resizeStartedAt: null,
            resizeTargetServerType: null,
          },
        );
        if (completed) {
          running += 1;
        }
      }
      await deletionOps.retryProviderDeletions();
      await deletionOps.retryRunningMachineMetadata();
      return { checked: rows.length + resizingRows.length, failed, running };
    },
  };
}
