import { randomUUID, randomBytes } from 'node:crypto';
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
  getHostBundleRelease,
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
  buildPlatformRuntimeVerificationToken,
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
import {
  renderCloudInitTemplate,
  type CustomerHostConfig,
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
import { selectCustomerVpsDeployMachines } from './customer-vps-deploy-selection.js';
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
  resolvePinnedPreviewTestSnapshotBundle,
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
  '      MATRIX_IMAGE_SOURCE={{imageSource}}',
  '      MATRIX_TARGET_BUNDLE_SHA256={{targetBundleSha256}}',
  '      MATRIX_SNAPSHOT_SOURCE_VERSION={{snapshotSourceVersion}}',
  '      MATRIX_HOST_BUNDLE_URL={{hostBundleUrl}}',
  '      MATRIX_PLATFORM_REGISTER_URL={{platformRegisterUrl}}',
  '      PLATFORM_INTERNAL_URL={{platformInternalUrl}}',
  '      UPGRADE_TOKEN={{platformVerificationToken}}',
  '      MATRIX_AUTH_TOKEN={{platformVerificationToken}}',
  '      MATRIX_FUNDED_AI_RUNTIME_TOKEN={{fundedAiRuntimeToken}}',
  '      MATRIX_CODE_PROXY_TOKEN={{platformVerificationToken}}',
  '      MATRIX_FUNDED_AI_ENABLED={{fundedAiEnabled}}',
  '      MATRIX_FUNDED_AI_RELAY_URL={{fundedAiRelayUrl}}',
  '      POSTHOG_TOKEN={{posthogToken}}',
  '      POSTHOG_PROJECT_TOKEN={{posthogProjectToken}}',
  '      POSTHOG_HOST={{posthogHost}}',
  '      NEXT_PUBLIC_POSTHOG_KEY={{posthogToken}}',
  '      NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN={{posthogProjectToken}}',
  '      NEXT_PUBLIC_POSTHOG_HOST={{posthogPublicHost}}',
  '      NEXT_PUBLIC_POSTHOG_API_HOST={{posthogApiHost}}',
  '      DATABASE_URL=postgresql://matrix:{{postgresPassword}}@127.0.0.1:5432/matrix',
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
  '      MATRIX_REGISTRATION_TOKEN_EXPIRES_AT={{registrationTokenExpiresAt}}',
].join('\n');

const PROVIDER_DELETION_RETRY_BASE_MS = 60_000;
const PROVIDER_DELETION_RETRY_MAX_MS = 60 * 60_000;
const RESIZE_STATUS_POLL_INTERVAL_MS = 1_000;
const RESIZE_STATUS_POLL_TIMEOUT_MS = 90_000;
const BILLING_RUNTIME_HEALTH_POLL_INTERVAL_MS = 1_000;
const BILLING_RUNTIME_HEALTH_POLL_TIMEOUT_MS = 90_000;
const PROVISIONING_JOB_LEASE_MS = 5 * 60_000;
const PROVISIONING_CREATE_ACTION_POLL_ATTEMPTS = 31;
const PROVISIONING_CREATE_ACTION_POLL_INTERVAL_MS = 1_000;
const RECOVERY_CREATE_ACTION_POLL_ATTEMPTS = 6;
const RECOVERY_CREATE_ACTION_POLL_INTERVAL_MS = 1_000;

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

function isAmbiguousProviderCreateError(err: unknown): boolean {
  return !(err instanceof CustomerVpsError)
    || err.code === 'provider_timeout'
    || err.code === 'provider_unavailable';
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
  registrationTokenExpiresAt: string,
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
    fundedAiRuntimeToken: buildPlatformRuntimeVerificationToken({
      handle: input.handle,
      machineId,
      runtimeSlot: input.runtimeSlot,
    }, config.platformSecret),
    registrationToken,
    registrationTokenExpiresAt,
    postgresPassword,
    posthogToken: config.posthogToken,
    posthogProjectToken: config.posthogProjectToken,
    posthogHost: config.posthogHost,
    posthogPublicHost: config.posthogPublicHost,
    posthogApiHost: config.posthogApiHost,
    fundedAiEnabled: config.fundedAiEnabled ? 'true' : 'false',
    fundedAiRelayUrl: config.fundedAiRelayUrl,
  };
}

const HOST_BUNDLE_CHANNELS = new Set(['stable', 'canary', 'beta', 'dev']);
const MAX_LOCAL_PROVISION_LOCKS = 1_024;
const MAX_LOCAL_PROVISION_QUEUE_DEPTH = 20;

interface HostBundleRef {
  imageVersion: string;
  hostBundleUrl: string;
  sha256?: string | null;
}

function tryPinHostBundleUrlForImageVersion(
  config: CustomerVpsConfig,
  imageVersion: string,
): string | undefined {
  const currentSegment = `/system-bundles/${encodeURIComponent(config.imageVersion)}/`;
  const url = new URL(config.hostBundleUrl);
  if (!url.pathname.includes(currentSegment)) return undefined;
  const pinnedSegment = `/system-bundles/${encodeURIComponent(imageVersion)}/`;
  url.pathname = url.pathname.replaceAll(currentSegment, pinnedSegment);
  return url.toString();
}

function hostBundleUrlForImageVersion(config: CustomerVpsConfig, imageVersion: string): string {
  const pinnedUrl = tryPinHostBundleUrlForImageVersion(config, imageVersion);
  if (pinnedUrl) return pinnedUrl;
  // Defensive fallback for future URL-template changes. The current generated
  // URL always contains the encoded image-version segment above.
  const url = new URL(config.hostBundleUrl);
  url.pathname = `/system-bundles/${encodeURIComponent(imageVersion)}/matrix-host-bundle.tar.gz`;
  return url.toString();
}

async function resolveHostBundleRef(
  db: PlatformDB,
  config: CustomerVpsConfig,
  previewTestSnapshotId?: string,
): Promise<HostBundleRef> {
  if (previewTestSnapshotId) {
    return resolvePinnedPreviewTestSnapshotBundle({
      db,
      snapshotId: previewTestSnapshotId,
      currentBundleVersion: config.imageVersion,
      currentBundleUrl: config.hostBundleUrl,
    });
  }
  if (config.hostBundleUrlOverride || !HOST_BUNDLE_CHANNELS.has(config.imageVersion)) {
    const release = await getHostBundleRelease(db, config.imageVersion);
    return {
      imageVersion: config.imageVersion,
      hostBundleUrl: config.hostBundleUrl,
      sha256: release?.sha256 ?? null,
    };
  }

  const release = await getHostBundleReleaseByChannel(db, config.imageVersion);
  if (!release) {
    logCustomerVpsError(
      `host bundle channel missing release channel=${config.imageVersion}`,
      new Error('falling back to configured host bundle URL without immutable version pin'),
    );
    return { imageVersion: config.imageVersion, hostBundleUrl: config.hostBundleUrl, sha256: null };
  }

  return {
    imageVersion: release.version,
    hostBundleUrl: hostBundleUrlForImageVersion(config, release.version),
    sha256: release.sha256,
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

function normalizeServerType(serverType: string): string {
  return serverType.trim().toLowerCase();
}

function allowedEntitlementServerTypes(entitlement: BillingEntitlement): string[] {
  return entitlement.allowedServerTypes
    .map(normalizeServerType)
    .filter((serverType) => serverType.length > 0);
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

async function assertBillingResizeAllowed(
  deps: CustomerVpsServiceDeps,
  clerkUserId: string,
  runtimeSlot: string,
  serverType: string,
  now: Date,
): Promise<void> {
  if (!deps.resolveBillingEntitlement) {
    return;
  }
  const entitlement = await deps.resolveBillingEntitlement(deps.db, clerkUserId, runtimeSlot);
  const access = getRuntimeAccessDecision(entitlement, now);
  if (
    !entitlement ||
    !access.runtimeProxyAllowed ||
    !allowedEntitlementServerTypes(entitlement).includes(normalizeServerType(serverType))
  ) {
    throw billingUpgradeRequired();
  }
}

async function assertMachineProviderMutationAllowed(
  deps: CustomerVpsServiceDeps,
  machine: Pick<UserMachineRecord,
    'clerkUserId' | 'runtimeSlot' | 'provisioningClass' | 'activationState' | 'prebillingIntentId'>,
  serverType: string,
  now: Date,
  authorizationBasis: 'billing_entitlement' | 'prebilling_intent' = 'billing_entitlement',
): Promise<void> {
  // Preview authorization is platform/operator scoped and deliberately does
  // not consume or depend on the owner's customer billing entitlement.
  if (machine.provisioningClass === 'preview') return;
  // The provisioning worker validates the exact intent, selection, machine
  // binding, and unexpired lease before reaching either provider-create path.
  if (authorizationBasis === 'prebilling_intent'
    && machine.activationState === 'awaiting_billing'
    && machine.prebillingIntentId !== null) return;
  await assertBillingResizeAllowed(deps, machine.clerkUserId, machine.runtimeSlot, serverType, now);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

  async function waitForServerStatus(
    serverId: number,
    expectedStatus: string,
    context: string,
    shouldContinue?: () => Promise<boolean>,
  ): Promise<boolean> {
    const deadline = Date.now() + RESIZE_STATUS_POLL_TIMEOUT_MS;
    for (;;) {
      if (shouldContinue && !(await shouldContinue())) return false;
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
        return true;
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

  async function waitForRuntimeHealth(
    row: UserMachineRecord,
    shouldContinue?: () => Promise<boolean>,
  ): Promise<boolean> {
    if (!row.publicIPv4) {
      throw new CustomerVpsError(500, 'invalid_state', 'Computer is unavailable');
    }
    const deadline = Date.now() + BILLING_RUNTIME_HEALTH_POLL_TIMEOUT_MS;
    for (;;) {
      if (shouldContinue && !(await shouldContinue())) return false;
      try {
        const response = await fetch(`https://${row.publicIPv4}:443/health`, {
          signal: AbortSignal.timeout(3_000),
          redirect: 'error',
          ...(deps.fetchDispatcher ? { dispatcher: deps.fetchDispatcher } : {}),
        } as RequestInit & { dispatcher?: import('undici').Dispatcher });
        if (response.ok) return true;
      } catch (err: unknown) {
        if (Date.now() >= deadline) {
          throw new CustomerVpsError(500, 'provider_timeout', 'Computer is unavailable');
        }
        logCustomerVpsError(`billing resume health check failed machineId=${row.machineId}`, err);
      }
      if (Date.now() >= deadline) {
        throw new CustomerVpsError(500, 'provider_timeout', 'Computer is unavailable');
      }
      await sleep(BILLING_RUNTIME_HEALTH_POLL_INTERVAL_MS);
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

  async function waitForProvisioningCreateAction(actionId: number): Promise<'success' | 'error' | 'pending'> {
    for (let attempt = 0; attempt < PROVISIONING_CREATE_ACTION_POLL_ATTEMPTS; attempt += 1) {
      let action;
      try {
        action = await deps.hetzner.getAction(actionId);
      } catch (err: unknown) {
        logCustomerVpsError(`provision create action refresh failed actionId=${actionId}`, err);
        return 'pending';
      }
      if (action?.status === 'success') return 'success';
      if (action?.status === 'error') return 'error';
      if (attempt + 1 < PROVISIONING_CREATE_ACTION_POLL_ATTEMPTS) {
        await sleep(PROVISIONING_CREATE_ACTION_POLL_INTERVAL_MS);
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
        await queueProviderDeletion({
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
            await queueProviderDeletion({
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
          const priorCreateResult = await waitForProvisioningCreateAction(
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
                await queueProviderDeletion({
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
          await queueProviderDeletion({
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
        const createResult = await waitForProvisioningCreateAction(createActionId);
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
            await queueProviderDeletion({
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

  async function provision(
    input: ProvisionRequest | PreviewProvisionRequest,
    provisioningClass: UserMachineProvisioningClass,
    dispatch: NonNullable<ProvisionOptions['dispatch']>,
    prebillingIntentId?: string,
  ): Promise<ProvisionResponse> {
    const testSnapshotId = provisioningClass === 'preview' && 'testSnapshotId' in input
      ? input.testSnapshotId
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

    const bundleRef = await resolveHostBundleRef(deps.db, deps.config, testSnapshotId);

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
        developerTools: request.developerTools,
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
          if (!(await waitForServerStatus(
            providerServerId,
            'off',
            'billing-shutdown',
            shouldContinue,
          ))) return;
        } catch (err: unknown) {
          logCustomerVpsError(`billing graceful shutdown failed machineId=${claimed.machineId}`, err);
          if (shouldContinue && !(await shouldContinue())) return;
          await deps.hetzner.powerOffServer(providerServerId);
          if (!(await waitForServerStatus(
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
        if (!(await waitForServerStatus(
          providerServerId,
          'running',
          'billing-poweron',
          shouldContinue,
        ))) return;
      }
      if (!(await waitForRuntimeHealth(claimed, shouldContinue))) return;
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
      await dispatchProvisioningJobs();
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
          const recoveryCreate = await reconcilePendingRecoveryCreate(row);
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
