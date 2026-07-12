import { randomUUID, randomBytes } from 'node:crypto';
import type {
  PlatformDB,
  UserMachineProvisioningClass,
  UserMachineRecord,
} from './db.js';
import {
  claimUserMachineDelete,
  claimUserMachineRecovery,
  completeUserMachineRegistration,
  getActiveUserMachineByClerkId,
  getHostBundleReleaseByChannel,
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
import { buildPlatformVerificationToken } from './platform-token.js';
import type { HetznerClient } from './customer-vps-hetzner.js';
import {
  CustomerVpsError,
  genericProviderError,
  logCustomerVpsError,
  type CustomerVpsFailureCode,
} from './customer-vps-errors.js';
import { buildVpsMeta, type CustomerVpsSystemStore } from './customer-vps-r2.js';
import {
  renderCloudInitTemplate,
  type CustomerHostConfig,
} from './customer-vps-cloud-init.js';
import { PublicIPv4Schema, type CustomerVpsStatus } from './customer-vps-schema.js';
import type {
  PreviewProvisionRequest,
  ProvisionRequest,
  RegisterRequest,
  RecoverRequest,
  ResizeMachineRequest,
} from './customer-vps-schema.js';
import { assertPreviewProvisioningCapacity, isPreviewMachine } from './customer-vps-preview.js';
import {
  getRuntimeAccessDecision,
  type BillingEntitlement,
} from './billing.js';
import {
  DEFAULT_DEVELOPER_TOOLS,
  canonicalizeDeveloperTools,
  developerToolsShellList,
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
} from './customer-vps-provisioning-jobs.js';

export interface ProvisionResponse {
  machineId: string;
  status: 'provisioning' | 'running';
  etaSeconds: number;
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

export interface StatusResponse {
  machineId: string;
  clerkUserId: string;
  handle: string;
  runtimeSlot: string;
  status: CustomerVpsStatus;
  imageVersion: string | null;
  publicIPv4: string | null;
  publicIPv6: string | null;
  provisionedAt: string;
  lastSeenAt: string | null;
  deletedAt: string | null;
  failureCode: string | null;
  failureAt: string | null;
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
  provision(input: ProvisionRequest): Promise<ProvisionResponse>;
  provisionPreview(input: PreviewProvisionRequest): Promise<ProvisionResponse>;
  register(token: string | undefined, input: RegisterRequest): Promise<RegisterResponse>;
  recover(input: RecoverRequest): Promise<RecoverResponse>;
  resize(input: ResizeMachineRequest & { machineId: string }): Promise<ResizeResponse>;
  status(machineId: string): Promise<StatusResponse>;
  delete(machineId: string): Promise<DeleteResponse>;
  deploy(target?: DeployTarget): Promise<DeployResult>;
  listAllMachines(): Promise<StatusResponse[]>;
  dispatchProvisioningJobs(): Promise<{ checked: number; completed: number; failed: number }>;
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
  fetchDispatcher?: import('undici').Dispatcher;
  resolveBillingEntitlement?: (clerkUserId: string) => Promise<BillingEntitlement | null | undefined>;
}

const DEFAULT_CLOUD_INIT_TEMPLATE = [
  '#cloud-config',
  'write_files:',
  '  - path: /opt/matrix/env/host.env',
  '    content: |',
  '      MATRIX_MACHINE_ID={{machineId}}',
  '      MATRIX_CLERK_USER_ID={{clerkUserId}}',
  '      MATRIX_HANDLE={{handle}}',
  '      MATRIX_RUNTIME_SLOT={{runtimeSlot}}',
  "      MATRIX_DEVELOPER_TOOLS='{{developerTools}}'",
  '      MATRIX_IMAGE_VERSION={{imageVersion}}',
  '      MATRIX_UPDATE_CHANNEL={{updateChannel}}',
  '      MATRIX_HOST_BUNDLE_URL={{hostBundleUrl}}',
  '      MATRIX_PLATFORM_REGISTER_URL={{platformRegisterUrl}}',
  '      PLATFORM_INTERNAL_URL={{platformInternalUrl}}',
  '      UPGRADE_TOKEN={{platformVerificationToken}}',
  '      MATRIX_AUTH_TOKEN={{platformVerificationToken}}',
  '      MATRIX_CODE_PROXY_TOKEN={{platformVerificationToken}}',
  '      MATRIX_R2_BUCKET={{r2Bucket}}',
  '      MATRIX_R2_PREFIX={{r2Prefix}}',
  '      POSTHOG_TOKEN={{posthogToken}}',
  '      POSTHOG_PROJECT_TOKEN={{posthogProjectToken}}',
  '      POSTHOG_HOST={{posthogHost}}',
  '      NEXT_PUBLIC_POSTHOG_KEY={{posthogToken}}',
  '      NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN={{posthogProjectToken}}',
  '      NEXT_PUBLIC_POSTHOG_HOST={{posthogPublicHost}}',
  '      NEXT_PUBLIC_POSTHOG_API_HOST={{posthogApiHost}}',
  '      DATABASE_URL=postgresql://matrix:{{postgresPassword}}@127.0.0.1:5432/matrix',
  '  - path: /opt/matrix/env/r2.env',
  '    permissions: "0640"',
  '    content: |',
  "      AWS_ACCESS_KEY_ID='{{r2AccessKeyId}}'",
  "      AWS_SECRET_ACCESS_KEY='{{r2SecretAccessKey}}'",
  "      R2_ENDPOINT='{{r2Endpoint}}'",
  "      R2_ACCOUNT_ID='{{r2AccountId}}'",
  '  - path: /opt/matrix/env/postgres.env',
  '    permissions: "0640"',
  '    content: |',
  '      POSTGRES_DB=matrix',
  '      POSTGRES_USER=matrix',
  '      POSTGRES_PASSWORD={{postgresPassword}}',
  '  - path: /opt/matrix/env/registration.env',
  '    permissions: "0640"',
  '    content: |',
  '      MATRIX_REGISTRATION_TOKEN={{registrationToken}}',
].join('\n');

const PROVIDER_DELETION_RETRY_BASE_MS = 60_000;
const PROVIDER_DELETION_RETRY_MAX_MS = 60 * 60_000;
const RESIZE_STATUS_POLL_INTERVAL_MS = 1_000;
const RESIZE_STATUS_POLL_TIMEOUT_MS = 90_000;
const PROVISIONING_JOB_LEASE_MS = 5 * 60_000;

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

async function findExistingProvisioningMachine(
  db: PlatformDB,
  request: Pick<ProvisionRequest, 'clerkUserId' | 'handle' | 'runtimeSlot'>,
  provisioningClass: UserMachineProvisioningClass,
): Promise<UserMachineRecord | undefined> {
  const exact = await getActiveUserMachineByClerkId(db, request.clerkUserId, request.runtimeSlot);
  if (provisioningClass !== 'preview' || request.runtimeSlot === 'preview') {
    return exact;
  }
  if (exact && exact.handle !== request.handle) {
    throw new CustomerVpsError(409, 'invalid_state', 'Preview slot unavailable');
  }
  const legacy = await getActiveUserMachineByClerkId(db, request.clerkUserId, 'preview');
  const matchingLegacy = legacy?.handle === request.handle ? legacy : undefined;
  if (exact?.status === 'failed' && matchingLegacy && matchingLegacy.status !== 'failed') {
    return matchingLegacy;
  }
  return exact ?? matchingLegacy;
}

function statusResponse(row: UserMachineRecord): StatusResponse {
  return {
    machineId: row.machineId,
    clerkUserId: row.clerkUserId,
    handle: row.handle,
    runtimeSlot: row.runtimeSlot,
    status: row.status as CustomerVpsStatus,
    imageVersion: row.imageVersion,
    publicIPv4: row.publicIPv4,
    publicIPv6: row.publicIPv6,
    provisionedAt: row.provisionedAt,
    lastSeenAt: row.lastSeenAt,
    deletedAt: row.deletedAt,
    failureCode: row.failureCode,
    failureAt: row.failureAt,
  };
}

function toFailureCode(err: unknown): CustomerVpsFailureCode {
  return err instanceof CustomerVpsError ? err.code : genericProviderError(err).code;
}

function buildHostConfig(
  config: CustomerVpsConfig,
  input: ProvisionRequest,
  machineId: string,
  registrationToken: string,
  postgresPassword: string,
  bundleRef: HostBundleRef,
): CustomerHostConfig {
  return {
    machineId,
    clerkUserId: input.clerkUserId,
    handle: input.handle,
    runtimeSlot: input.runtimeSlot,
    developerTools: developerToolsShellList(input.developerTools ?? DEFAULT_DEVELOPER_TOOLS),
    imageVersion: bundleRef.imageVersion,
    updateChannel: config.imageVersion,
    hostBundleUrl: bundleRef.hostBundleUrl,
    platformRegisterUrl: config.platformRegisterUrl,
    platformInternalUrl: new URL(config.platformRegisterUrl).origin,
    platformVerificationToken: buildPlatformVerificationToken(input.handle, config.platformSecret),
    registrationToken,
    r2AccessKeyId: config.r2AccessKeyId,
    r2SecretAccessKey: config.r2SecretAccessKey,
    r2Endpoint: config.r2Endpoint,
    r2AccountId: config.r2AccountId,
    r2Bucket: config.r2Bucket,
    r2Prefix: `${config.r2PrefixRoot}/${input.clerkUserId}/` as `matrixos-sync/${string}/`,
    postgresPassword,
    posthogToken: config.posthogToken,
    posthogProjectToken: config.posthogProjectToken,
    posthogHost: config.posthogHost,
    posthogPublicHost: config.posthogPublicHost,
    posthogApiHost: config.posthogApiHost,
  };
}

const HOST_BUNDLE_CHANNELS = new Set(['stable', 'canary', 'beta', 'dev']);
const MAX_LOCAL_PROVISION_LOCKS = 1_024;
const MAX_LOCAL_PROVISION_QUEUE_DEPTH = 20;

interface HostBundleRef {
  imageVersion: string;
  hostBundleUrl: string;
}

function hostBundleUrlForImageVersion(config: CustomerVpsConfig, imageVersion: string): string {
  const currentSegment = `/system-bundles/${encodeURIComponent(config.imageVersion)}/`;
  const pinnedSegment = `/system-bundles/${encodeURIComponent(imageVersion)}/`;
  if (config.hostBundleUrl.includes(currentSegment)) {
    return config.hostBundleUrl.replaceAll(currentSegment, pinnedSegment);
  }
  // Defensive fallback for future URL-template changes. The current generated
  // URL always contains the encoded image-version segment above.
  const url = new URL(config.hostBundleUrl);
  url.pathname = `/system-bundles/${encodeURIComponent(imageVersion)}/matrix-host-bundle.tar.gz`;
  return url.toString();
}

async function resolveHostBundleRef(db: PlatformDB, config: CustomerVpsConfig): Promise<HostBundleRef> {
  if (config.hostBundleUrlOverride || !HOST_BUNDLE_CHANNELS.has(config.imageVersion)) {
    return { imageVersion: config.imageVersion, hostBundleUrl: config.hostBundleUrl };
  }

  const release = await getHostBundleReleaseByChannel(db, config.imageVersion);
  if (!release) {
    logCustomerVpsError(
      `host bundle channel missing release channel=${config.imageVersion}`,
      new Error('falling back to configured host bundle URL without immutable version pin'),
    );
    return { imageVersion: config.imageVersion, hostBundleUrl: config.hostBundleUrl };
  }

  return {
    imageVersion: release.version,
    hostBundleUrl: hostBundleUrlForImageVersion(config, release.version),
  };
}

function buildServerName(handle: string): string {
  return `matrix-${handle}`;
}

function buildRecoveryServerName(handle: string, machineId: string): string {
  const suffix = machineId.replaceAll('-', '').slice(0, 8);
  return `${buildServerName(handle).slice(0, 54)}-${suffix}`;
}

function billingUpgradeRequired(): CustomerVpsError {
  return new CustomerVpsError(402, 'billing_required', 'Billing upgrade required');
}

function resolveDefaultEntitlementServerType(entitlement: BillingEntitlement): string {
  const allowedServerTypes = entitlement.allowedServerTypes.filter((serverType) => serverType.length > 0);
  if (entitlement.defaultServerType && allowedServerTypes.includes(entitlement.defaultServerType)) {
    return entitlement.defaultServerType;
  }
  const fallbackServerType = allowedServerTypes[0];
  if (!fallbackServerType) {
    throw billingUpgradeRequired();
  }
  return fallbackServerType;
}

async function resolveBillingProvisionContext(
  deps: CustomerVpsServiceDeps,
  input: ProvisionRequest,
  now: Date,
): Promise<{ entitlement: BillingEntitlement; serverType: string } | null> {
  if (!deps.resolveBillingEntitlement) {
    return null;
  }
  const entitlement = await deps.resolveBillingEntitlement(input.clerkUserId);
  const access = getRuntimeAccessDecision(entitlement, now);
  if (!entitlement || !access.runtimeProxyAllowed) {
    throw billingUpgradeRequired();
  }
  const serverType = input.serverType ?? resolveDefaultEntitlementServerType(entitlement);
  if (!entitlement.allowedServerTypes.includes(serverType)) {
    throw billingUpgradeRequired();
  }
  return { entitlement, serverType };
}

async function resolveBillingRecoveryContext(
  deps: CustomerVpsServiceDeps,
  clerkUserId: string,
  existingServerType: string | null,
  now: Date,
): Promise<{ serverType: string } | null> {
  if (!deps.resolveBillingEntitlement) {
    return null;
  }
  const entitlement = await deps.resolveBillingEntitlement(clerkUserId);
  const access = getRuntimeAccessDecision(entitlement, now);
  if (!entitlement || !access.runtimeProxyAllowed) {
    throw billingUpgradeRequired();
  }
  const serverType = existingServerType && entitlement.allowedServerTypes.includes(existingServerType)
    ? existingServerType
    : resolveDefaultEntitlementServerType(entitlement);
  if (!entitlement.allowedServerTypes.includes(serverType)) {
    throw billingUpgradeRequired();
  }
  return { serverType };
}

async function assertBillingResizeAllowed(
  deps: CustomerVpsServiceDeps,
  clerkUserId: string,
  serverType: string,
  now: Date,
): Promise<void> {
  if (!deps.resolveBillingEntitlement) {
    return;
  }
  const entitlement = await deps.resolveBillingEntitlement(clerkUserId);
  const access = getRuntimeAccessDecision(entitlement, now);
  if (!entitlement || !access.runtimeProxyAllowed || !entitlement.allowedServerTypes.includes(serverType)) {
    throw billingUpgradeRequired();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createCustomerVpsService(deps: CustomerVpsServiceDeps): CustomerVpsService {
  const machineIdFactory = deps.machineIdFactory ?? randomUUID;
  const provisioningJobIdFactory = deps.provisioningJobIdFactory ?? randomUUID;
  const localProvisionLocks = new Map<string, { tail: Promise<void>; depth: number }>();

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
  const tokenFactory = deps.tokenFactory ?? createRegistrationToken;
  const postgresPasswordFactory = deps.postgresPasswordFactory ?? (() => randomBytes(24).toString('base64url'));
  const now = deps.now ?? (() => new Date());

  async function waitForServerStatus(
    serverId: number,
    expectedStatus: string,
    context: string,
  ): Promise<void> {
    const deadline = Date.now() + RESIZE_STATUS_POLL_TIMEOUT_MS;
    for (;;) {
      let server: Awaited<ReturnType<typeof deps.hetzner.getServer>>;
      try {
        server = await deps.hetzner.getServer(serverId);
      } catch (err: unknown) {
        if (Date.now() >= deadline) {
          throw new CustomerVpsError(500, 'provider_timeout', 'Provisioning provider unavailable');
        }
        logCustomerVpsError(`resize ${context} server read failed serverId=${serverId}`, err);
        await sleep(RESIZE_STATUS_POLL_INTERVAL_MS);
        continue;
      }
      if (!server) {
        throw new CustomerVpsError(500, 'provider_unavailable', 'Provisioning provider unavailable');
      }
      if (server.status === expectedStatus) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new CustomerVpsError(500, 'provider_timeout', 'Provisioning provider unavailable');
      }
      logCustomerVpsError(
        `resize ${context} waiting for serverId=${serverId}`,
        new Error(`expected ${expectedStatus}, got ${server.status}`),
      );
      await sleep(RESIZE_STATUS_POLL_INTERVAL_MS);
    }
  }

  async function queueProviderDeletion(input: {
    providerServerId: number;
    reason: string;
    machineId?: string | null;
    handle?: string | null;
    err: unknown;
  }): Promise<void> {
    const currentTime = now().toISOString();
    try {
      await insertProviderDeletion(deps.db, {
        id: randomUUID(),
        providerServerId: input.providerServerId,
        reason: input.reason,
        machineId: input.machineId,
        handle: input.handle,
        nextAttemptAt: currentTime,
        createdAt: currentTime,
        lastError: input.err instanceof Error ? input.err.message : String(input.err),
      });
    } catch (queueErr: unknown) {
      logCustomerVpsError(
        `provider deletion enqueue failed orphanedHetznerServerId=${input.providerServerId} reason=${input.reason}`,
        queueErr,
      );
    }
  }

  // Enqueues a provider-server deletion on the given transaction-or-db handle.
  // Unlike queueProviderDeletion, this propagates insert failures so a caller
  // can keep the status change and the deletion enqueue in one atomic unit —
  // if the enqueue fails the whole transaction rolls back and the machine is
  // retried on the next reconciler pass instead of orphaning its server.
  async function enqueueProviderDeletionTx(
    handle: PlatformDB,
    input: {
      providerServerId: number;
      reason: string;
      machineId?: string | null;
      handle?: string | null;
      detail: string;
    },
  ): Promise<void> {
    const currentTime = now().toISOString();
    await insertProviderDeletion(handle, {
      id: randomUUID(),
      providerServerId: input.providerServerId,
      reason: input.reason,
      machineId: input.machineId ?? null,
      handle: input.handle ?? null,
      nextAttemptAt: currentTime,
      createdAt: currentTime,
      lastError: input.detail,
    });
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
        await queueProviderDeletion({
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

  async function dispatchProvisioningJob(
    jobId: string,
    propagateFailure: boolean,
  ): Promise<'completed' | 'failed' | 'skipped'> {
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

    let serverIdForCompensation: number | null = null;
    let adoptedExistingServer = false;
    try {
      const payload = openProvisioningPayload(job.encryptedPayload, deps.config.platformSecret);
      const imageVersion = row.imageVersion ?? deps.config.imageVersion;
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
        payload.postgresPassword,
        {
          imageVersion,
          hostBundleUrl: hostBundleUrlForImageVersion(deps.config, imageVersion),
        },
      );
      const userData = renderCloudInitTemplate(
        deps.cloudInitTemplate ?? DEFAULT_CLOUD_INIT_TEMPLATE,
        hostConfig,
      );
      const existingServers = deps.hetzner.listServersByLabel
        ? (await deps.hetzner.listServersByLabel(`machine_id=${row.machineId}`))
          .toSorted((left, right) => left.id - right.id)
        : [];
      const existingServer = existingServers[0];
      const server = existingServer ?? await deps.hetzner.createServer({
          name: buildServerName(row.handle),
          serverType: row.serverType ?? deps.config.serverType,
          userData,
          labels: {
            app: 'matrix-os',
            clerk_user_id: row.clerkUserId,
            runtime_slot: row.runtimeSlot,
            machine_id: row.machineId,
          },
        });
      adoptedExistingServer = Boolean(existingServer);
      if (!adoptedExistingServer) serverIdForCompensation = server.id;
      for (const duplicate of existingServers.slice(1)) {
        try {
          await deps.hetzner.deleteServer(duplicate.id);
        } catch (cleanupErr: unknown) {
          logCustomerVpsError('duplicate provisioning server cleanup failed', cleanupErr);
          await queueProviderDeletion({
            providerServerId: duplicate.id,
            reason: 'duplicate_provisioning_server',
            machineId: row.machineId,
            handle: row.handle,
            err: cleanupErr,
          });
        }
      }
      const completedAt = now().toISOString();
      await runInPlatformTransaction(deps.db, async (trx) => {
        await updateUserMachine(trx, row.machineId, {
          hetznerServerId: server.id,
          publicIPv4: server.publicIPv4,
          publicIPv6: server.publicIPv6,
        });
        const completed = await completeProvisioningJob(trx, job.jobId, completedAt);
        if (!completed) {
          throw new Error('Provisioning job completion lost its lease');
        }
      });
      return 'completed';
    } catch (err: unknown) {
      const mapped = genericProviderError(err);
      if (serverIdForCompensation !== null) {
        try {
          await deps.hetzner.deleteServer(serverIdForCompensation);
        } catch (cleanupErr: unknown) {
          logCustomerVpsError('provision compensation delete failed', cleanupErr);
          await queueProviderDeletion({
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
        if (propagateFailure) throw mapped;
        return 'skipped';
      }
      const failedAt = now().toISOString();
      try {
        await runInPlatformTransaction(deps.db, async (trx) => {
          await updateUserMachine(trx, row.machineId, {
            status: 'failed',
            failureCode: toFailureCode(err),
            failureAt: failedAt,
          });
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
      logCustomerVpsError('durable provisioning job immediate dispatch unavailable', err);
    }
  }

  async function provision(
    input: ProvisionRequest,
    provisioningClass: UserMachineProvisioningClass,
  ): Promise<ProvisionResponse> {
    const request = {
      ...input,
      runtimeSlot: input.runtimeSlot ?? 'primary',
      developerTools: canonicalizeDeveloperTools(input.developerTools ?? DEFAULT_DEVELOPER_TOOLS),
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
    const billingContext = provisioningClass === 'preview'
      ? null
      : await resolveBillingProvisionContext(deps, request, currentTime);

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
      const existingJob = await getProvisioningJobByMachineId(deps.db, existingBeforeBundleResolve.machineId);
      if (existingJob && (existingJob.status === 'queued' || existingJob.status === 'running')) {
        await dispatchProvisioningJobBestEffort(existingJob.jobId);
      }
      return activeProvisionResponse(existingBeforeBundleResolve, deps.config.provisionEtaSeconds);
    }

    const bundleRef = await resolveHostBundleRef(deps.db, deps.config);

    let provisionRow: { existing: UserMachineRecord | null };
    try {
      provisionRow = await runInPlatformTransaction(deps.db, async (trx) => {
      // Preview capacity and customer entitlement checks share the owner lock
      // with insertion so concurrent platform instances cannot over-allocate.
      if (billingContext || provisioningClass === 'preview') {
        await lockUserMachineProvisioning(trx, request.clerkUserId);
      }
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
            await updateUserMachine(trx, existing.machineId, { provisioningClass: 'preview' });
            return { existing: { ...existing, provisioningClass: 'preview' as const } };
          }
          return { existing };
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
      } else if (billingContext) {
        const activeMachines = await listActiveUserMachinesByClerkId(trx, request.clerkUserId);
        const customerMachines = activeMachines.filter((machine) => !isPreviewMachine(machine));
        if (customerMachines.length >= billingContext.entitlement.maxRuntimeSlots) {
          throw billingUpgradeRequired();
        }
      }
      await insertUserMachine(trx, {
        machineId,
        clerkUserId: request.clerkUserId,
        handle: request.handle,
        runtimeSlot: request.runtimeSlot,
        provisioningClass,
        status: 'provisioning',
        imageVersion: bundleRef.imageVersion,
        serverType: billingContext?.serverType ?? deps.config.serverType,
        developerTools: request.developerTools,
        registrationTokenHash: registration.hash,
        registrationTokenExpiresAt: registration.expiresAt,
        provisionedAt: currentTime.toISOString(),
        attempt,
      });
      await enqueueProvisioningJob(trx, {
        jobId,
        machineId,
        encryptedPayload,
        availableAt: currentTime.toISOString(),
        createdAt: currentTime.toISOString(),
      });
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
        const concurrentJob = await getProvisioningJobByMachineId(deps.db, concurrent.machineId);
        if (concurrentJob && (concurrentJob.status === 'queued' || concurrentJob.status === 'running')) {
          await dispatchProvisioningJobBestEffort(concurrentJob.jobId);
        }
        return activeProvisionResponse(concurrent, deps.config.provisionEtaSeconds);
      }
      throw err;
    }
    if (provisionRow.existing) {
      const existingJob = await getProvisioningJobByMachineId(deps.db, provisionRow.existing.machineId);
      if (existingJob && (existingJob.status === 'queued' || existingJob.status === 'running')) {
        await dispatchProvisioningJobBestEffort(existingJob.jobId);
      }
      return activeProvisionResponse(provisionRow.existing, deps.config.provisionEtaSeconds);
    }

    await dispatchProvisioningJobBestEffort(jobId);

    return {
      machineId,
      status: 'provisioning',
      etaSeconds: deps.config.provisionEtaSeconds,
    };
  }

  return {
    async provision(input) {
      return withLocalProvisionLock(
        `${input.clerkUserId}:${input.runtimeSlot ?? 'primary'}`,
        () => provision(input, 'customer'),
      );
    },

    async provisionPreview(input) {
      return withLocalProvisionLock(
        `${input.clerkUserId}:${input.runtimeSlot ?? 'primary'}`,
        () => provision(input, 'preview'),
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

      const lastSeenAt = now().toISOString();
      const updated = await completeUserMachineRegistration(
        deps.db,
        input.machineId,
        input.hetznerServerId,
        expectedRegistrationTokenHash,
        lastSeenAt,
        {
          status: 'running',
          publicIPv4: input.publicIPv4,
          publicIPv6: input.publicIPv6,
          imageVersion: input.imageVersion,
          lastSeenAt,
          registrationTokenHash: null,
          registrationTokenExpiresAt: null,
          failureCode: null,
          failureAt: null,
        },
      );
      if (!updated) {
        throw new CustomerVpsError(409, 'invalid_state', 'Machine cannot register');
      }

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
        active.serverType,
        currentTime,
      );
      const machineId = machineIdFactory();
      const registration = tokenFactory(currentTime, deps.config.registrationTokenTtlMs);
      const postgresPassword = postgresPasswordFactory();
      // Resolve before claiming recovery so bundle lookup failures do not clear
      // the old provider server id and leave a billable VPS untracked.
      const bundleRef = await resolveHostBundleRef(deps.db, deps.config);
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
        postgresPassword,
        bundleRef,
      );
      const existing = await claimUserMachineRecovery(deps.db, input.clerkUserId, input.runtimeSlot);
      if (!existing) {
        const latest = await getActiveUserMachineByClerkId(deps.db, input.clerkUserId, input.runtimeSlot);
        if (latest?.status === 'recovering') {
          throw new CustomerVpsError(409, 'invalid_state', 'Recovery already in progress');
        }
        throw new CustomerVpsError(404, 'not_found', 'Machine not found');
      }
      const oldMachineId = existing.machineId;
      const oldServerId = active.hetznerServerId;

      let newServerId: number | null = null;
      try {
        const userData = renderCloudInitTemplate(
          deps.cloudInitTemplate ?? DEFAULT_CLOUD_INIT_TEMPLATE,
          hostConfig,
        );
        const server = await deps.hetzner.createServer({
          name: buildRecoveryServerName(existing.handle, machineId),
          serverType: billingContext?.serverType ?? active.serverType ?? deps.config.serverType,
          userData,
          labels: {
            app: 'matrix-os',
            clerk_user_id: existing.clerkUserId,
            runtime_slot: existing.runtimeSlot,
            machine_id: machineId,
          },
        });
        newServerId = server.id;
        await runInPlatformTransaction(deps.db, async (trx) => {
          await updateUserMachine(trx, oldMachineId, {
            machineId,
            status: 'recovering',
            hetznerServerId: server.id,
            publicIPv4: server.publicIPv4,
            publicIPv6: server.publicIPv6,
            imageVersion: bundleRef.imageVersion,
            serverType: deps.config.serverType,
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
          await updateUserMachine(deps.db, oldMachineId, {
            status: 'failed',
            failureCode: toFailureCode(err),
            failureAt: now().toISOString(),
          });
        } catch (statusErr: unknown) {
          logCustomerVpsError('recover failure status update failed', statusErr);
        }
        throw mapped;
      }

      if (oldServerId) {
        try {
          await deps.hetzner.deleteServer(oldServerId);
        } catch (err: unknown) {
          logCustomerVpsError('recover old server cleanup failed', err);
          await queueProviderDeletion({
            providerServerId: oldServerId,
            reason: 'recover_old_server',
            machineId: oldMachineId,
            handle: existing.handle,
            err,
          });
        }
      }

      return {
        oldMachineId,
        machineId,
        runtimeSlot: existing.runtimeSlot,
        status: 'recovering',
        etaSeconds: deps.config.provisionEtaSeconds,
      };
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

      await assertBillingResizeAllowed(deps, row.clerkUserId, input.serverType, now());
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
          await waitForServerStatus(claimed.hetznerServerId!, 'off', 'shutdown');
        } catch (shutdownErr: unknown) {
          logCustomerVpsError(`resize graceful shutdown failed machineId=${claimed.machineId}`, shutdownErr);
          await deps.hetzner.powerOffServer(claimed.hetznerServerId!);
          powerOffAccepted = true;
          await waitForServerStatus(claimed.hetznerServerId!, 'off', 'poweroff');
        }
        serverConfirmedOff = true;
        await deps.hetzner.resizeServer(claimed.hetznerServerId!, {
          serverType: input.serverType,
          upgradeDisk: false,
        });
        resizeAccepted = true;
        await waitForServerStatus(claimed.hetznerServerId!, 'off', 'resize');
        await deps.hetzner.powerOnServer(claimed.hetznerServerId!);
        serverConfirmedOff = false;
        powerOnAccepted = true;
        await waitForServerStatus(claimed.hetznerServerId!, 'running', 'poweron');
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
            await waitForServerStatus(claimed.hetznerServerId!, 'running', 'rollback-poweron');
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
          await queueProviderDeletion({
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

    dispatchProvisioningJobs,

    async deploy(target?: DeployTarget): Promise<DeployResult> {
      const runningMachines = await listRunningUserMachines(deps.db, 500);
      const machines = target?.handle
        ? runningMachines.filter((machine) => machine.handle === target.handle)
        : runningMachines;
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
      await dispatchProvisioningJobs();
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
      for (const row of rows) {
        if (!row.hetznerServerId) {
          await cleanupUntrackedServersForMachine(row);
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
            await enqueueProviderDeletionTx(trx, {
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
            await waitForServerStatus(row.hetznerServerId, 'running', 'reconcile-resize-poweron');
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
      await retryProviderDeletions();
      await retryRunningMachineMetadata();
      return { checked: rows.length + resizingRows.length, failed, running };
    },
  };
}
