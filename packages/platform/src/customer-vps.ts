import { randomUUID, randomBytes } from 'node:crypto';
import type { PlatformDB, UserMachineRecord } from './db.js';
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
  listPendingProviderDeletions,
  listAllUserMachines,
  listRunningUserMachines,
  listStaleUserMachines,
  lockUserMachineProvisioning,
  retireUserMachine,
  markProviderDeletionCompleted,
  markProviderDeletionFailed,
  runInPlatformTransaction,
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
  ProvisionRequest,
  RegisterRequest,
  RecoverRequest,
} from './customer-vps-schema.js';
import {
  getRuntimeAccessDecision,
  type BillingEntitlement,
} from './billing.js';

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
  register(token: string | undefined, input: RegisterRequest): Promise<RegisterResponse>;
  recover(input: RecoverRequest): Promise<RecoverResponse>;
  status(machineId: string): Promise<StatusResponse>;
  delete(machineId: string): Promise<DeleteResponse>;
  deploy(target?: DeployTarget): Promise<DeployResult>;
  listAllMachines(): Promise<StatusResponse[]>;
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
  '      NEXT_PUBLIC_POSTHOG_HOST={{posthogHost}}',
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
    posthogApiHost: config.posthogApiHost,
  };
}

const HOST_BUNDLE_CHANNELS = new Set(['stable', 'canary', 'beta', 'dev']);

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

export function createCustomerVpsService(deps: CustomerVpsServiceDeps): CustomerVpsService {
  const machineIdFactory = deps.machineIdFactory ?? randomUUID;
  const tokenFactory = deps.tokenFactory ?? createRegistrationToken;
  const postgresPasswordFactory = deps.postgresPasswordFactory ?? (() => randomBytes(24).toString('base64url'));
  const now = deps.now ?? (() => new Date());

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

  return {
    async provision(input) {
      const request = { ...input, runtimeSlot: input.runtimeSlot ?? 'primary' };
      const currentTime = now();
      const machineId = machineIdFactory();
      const registration = tokenFactory(currentTime, deps.config.registrationTokenTtlMs);
      const postgresPassword = postgresPasswordFactory();
      const billingContext = await resolveBillingProvisionContext(deps, request, currentTime);

      // A non-failed active machine (provisioning/running converge; recovering
      // is rejected by activeProvisionResponse). A `failed` row is retryable, so
      // it must NOT short-circuit here — it is retired inside the transaction.
      const existingBeforeBundleResolve = await getActiveUserMachineByClerkId(
        deps.db,
        request.clerkUserId,
        request.runtimeSlot,
      );
      if (existingBeforeBundleResolve && existingBeforeBundleResolve.status !== 'failed') {
        return activeProvisionResponse(existingBeforeBundleResolve, deps.config.provisionEtaSeconds);
      }

      const bundleRef = await resolveHostBundleRef(deps.db, deps.config);
      const hostConfig = buildHostConfig(
        deps.config,
        request,
        machineId,
        registration.token,
        postgresPassword,
        bundleRef,
      );

      const provisionRow = await runInPlatformTransaction(deps.db, async (trx) => {
        if (billingContext) {
          await lockUserMachineProvisioning(trx, request.clerkUserId);
        }
        const existing = await getActiveUserMachineByClerkId(trx, request.clerkUserId, request.runtimeSlot);
        let attempt = 1;
        let retiredServerId: number | null = null;
        let retiredMachineId: string | null = null;
        if (existing) {
          if (existing.status !== 'failed') {
            return { existing, retiredServerId: null, retiredMachineId: null };
          }
          // The active slot is held by a failed attempt. Retire it and provision
          // a fresh one in the same transaction so the unique (clerk, slot) slot
          // is satisfied at every instant and the user is never blocked.
          attempt = existing.attempt + 1;
          if (attempt > deps.config.maxProvisionAttempts) {
            throw new CustomerVpsError(409, 'retry_exhausted', 'Provisioning retry limit reached');
          }
          await retireUserMachine(trx, existing.machineId, currentTime.toISOString());
          retiredServerId = existing.hetznerServerId;
          retiredMachineId = existing.machineId;
        }
        if (billingContext) {
          const activeMachines = await listActiveUserMachinesByClerkId(trx, request.clerkUserId);
          if (activeMachines.length >= billingContext.entitlement.maxRuntimeSlots) {
            throw billingUpgradeRequired();
          }
        }
        await insertUserMachine(trx, {
          machineId,
          clerkUserId: request.clerkUserId,
          handle: request.handle,
          runtimeSlot: request.runtimeSlot,
          status: 'provisioning',
          imageVersion: bundleRef.imageVersion,
          serverType: billingContext?.serverType ?? deps.config.serverType,
          registrationTokenHash: registration.hash,
          registrationTokenExpiresAt: registration.expiresAt,
          provisionedAt: currentTime.toISOString(),
          attempt,
        });
        return { existing: null, retiredServerId, retiredMachineId };
      });
      if (provisionRow.existing) {
        return activeProvisionResponse(provisionRow.existing, deps.config.provisionEtaSeconds);
      }
      // Reap the retired failed attempt's server outside the transaction so the
      // abandoned VPS does not accrue cost (network call never inside the txn).
      if (provisionRow.retiredServerId !== null) {
        await queueProviderDeletion({
          providerServerId: provisionRow.retiredServerId,
          reason: 'failed_retry_retire',
          machineId: provisionRow.retiredMachineId,
          handle: request.handle,
          err: new Error('retiring failed machine before retry'),
        });
      }

      const userData = renderCloudInitTemplate(
        deps.cloudInitTemplate ?? DEFAULT_CLOUD_INIT_TEMPLATE,
        hostConfig,
      );

      let serverIdForCompensation: number | null = null;
      try {
        const server = await deps.hetzner.createServer({
          name: buildServerName(request.handle),
          serverType: billingContext?.serverType ?? deps.config.serverType,
          userData,
          labels: {
            app: 'matrix-os',
            clerk_user_id: request.clerkUserId,
            runtime_slot: request.runtimeSlot,
            machine_id: machineId,
          },
        });
        serverIdForCompensation = server.id;
        await updateUserMachine(deps.db, machineId, {
          hetznerServerId: server.id,
          publicIPv4: server.publicIPv4,
          publicIPv6: server.publicIPv6,
        });
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
              machineId,
              handle: request.handle,
              err: cleanupErr,
            });
          }
        }
        try {
          await updateUserMachine(deps.db, machineId, {
            status: 'failed',
            failureCode: toFailureCode(err),
            failureAt: now().toISOString(),
          });
        } catch (statusErr: unknown) {
          logCustomerVpsError('provision failure status update failed', statusErr);
        }
        throw mapped;
      }

      return {
        machineId,
        status: 'provisioning',
        etaSeconds: deps.config.provisionEtaSeconds,
      };
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
        { clerkUserId: active.clerkUserId, handle: active.handle, runtimeSlot: active.runtimeSlot },
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
      const staleBefore = new Date(now().getTime() - deps.config.reconciliationStaleAfterMs).toISOString();
      const rows = await listStaleUserMachines(
        deps.db,
        ['provisioning', 'recovering'],
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
          await updateUserMachine(deps.db, row.machineId, {
            status: 'failed',
            failureCode: 'registration_timeout',
            failureAt: now().toISOString(),
          });
          await queueProviderDeletion({
            providerServerId: row.hetznerServerId,
            reason: 'registration_timeout',
            machineId: row.machineId,
            handle: row.handle,
            err: new Error('registration token expired before register()'),
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
      await retryProviderDeletions();
      await retryRunningMachineMetadata();
      return { checked: rows.length, failed, running };
    },
  };
}
