/** Stateless customer VPS helpers: constants, responses, server names, and billing guards. */
import type { PlatformDB, UserMachineProvisioningClass, UserMachineRecord } from './db.js';
import { getActiveUserMachineByClerkId } from './db.js';
import { buildPlatformVerificationToken } from './platform-token.js';
import {
  CustomerVpsError,
  genericProviderError,
  type CustomerVpsFailureCode,
} from './customer-vps-errors.js';
import { type CustomerVpsStatus, type ProvisionRequest } from './customer-vps-schema.js';
import { getRuntimeAccessDecision, type BillingEntitlement } from './billing.js';
import type {
  ProvisionResponse,
  StatusResponse,
  CustomerVpsServiceDeps,
} from './customer-vps-types.js';

export const PROVIDER_DELETION_RETRY_BASE_MS = 60_000;
export const PROVIDER_DELETION_RETRY_MAX_MS = 60 * 60_000;
export const RESIZE_STATUS_POLL_INTERVAL_MS = 1_000;
export const RESIZE_STATUS_POLL_TIMEOUT_MS = 90_000;
export const BILLING_RUNTIME_HEALTH_POLL_INTERVAL_MS = 1_000;
export const BILLING_RUNTIME_HEALTH_POLL_TIMEOUT_MS = 90_000;
export const PROVISIONING_JOB_LEASE_MS = 5 * 60_000;
export const PROVISIONING_CREATE_ACTION_POLL_ATTEMPTS = 31;
export const PROVISIONING_CREATE_ACTION_POLL_INTERVAL_MS = 1_000;
export const RECOVERY_CREATE_ACTION_POLL_ATTEMPTS = 6;
export const RECOVERY_CREATE_ACTION_POLL_INTERVAL_MS = 1_000;

export function activeProvisionResponse(row: UserMachineRecord, etaSeconds: number): ProvisionResponse {
  if (row.status !== 'provisioning' && row.status !== 'running') {
    throw new CustomerVpsError(409, 'invalid_state', 'Machine is not provisionable');
  }
  return {
    machineId: row.machineId,
    status: row.status,
    etaSeconds,
  };
}

export function isAmbiguousProviderCreateError(err: unknown): boolean {
  return !(err instanceof CustomerVpsError)
    || err.code === 'provider_timeout'
    || err.code === 'provider_unavailable';
}

export async function findExistingProvisioningMachine(
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

export function statusResponse(row: UserMachineRecord): StatusResponse {
  return {
    machineId: row.machineId,
    clerkUserId: row.clerkUserId,
    handle: row.handle,
    runtimeSlot: row.runtimeSlot,
    provisioningClass: row.provisioningClass,
    activationState: row.activationState,
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

export function toFailureCode(err: unknown): CustomerVpsFailureCode {
  return err instanceof CustomerVpsError ? err.code : genericProviderError(err).code;
}

export const MAX_LOCAL_PROVISION_LOCKS = 1_024;
export const MAX_LOCAL_PROVISION_QUEUE_DEPTH = 20;

export function buildServerName(handle: string): string {
  return `matrix-${handle}`;
}

export function buildRecoveryServerName(handle: string, machineId: string): string {
  const suffix = machineId.replaceAll('-', '').slice(0, 8);
  return `${buildServerName(handle).slice(0, 54)}-${suffix}`;
}

export function billingUpgradeRequired(): CustomerVpsError {
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

export async function resolveBillingProvisionContext(
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

export async function resolveBillingRecoveryContext(
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

export async function assertMachineProviderMutationAllowed(
  deps: CustomerVpsServiceDeps,
  machine: Pick<UserMachineRecord,
    'clerkUserId' | 'runtimeSlot' | 'provisioningClass' | 'activationState' | 'prebillingIntentId'>,
  serverType: string,
  now: Date,
  authorizationBasis: 'billing_entitlement' | 'prebilling_intent' = 'billing_entitlement',
): Promise<void> {
  // Preview and Private Preview authorization is platform scoped and
  // deliberately does not consume or depend on the owner's customer billing
  // entitlement; their own quotas bound them (spec 537 P4).
  if (machine.provisioningClass === 'preview' || machine.provisioningClass === 'private-preview') return;
  // The provisioning worker validates the exact intent, selection, machine
  // binding, and unexpired lease before reaching either provider-create path.
  if (authorizationBasis === 'prebilling_intent'
    && machine.activationState === 'awaiting_billing'
    && machine.prebillingIntentId !== null) return;
  await assertBillingResizeAllowed(deps, machine.clerkUserId, machine.runtimeSlot, serverType, now);
}

/**
 * Asks one running machine's gateway to install a release. The body names an
 * exact version or a channel; the machine's updater fetches the metadata.
 */
export async function triggerMachineSystemUpdate(
  deps: Pick<CustomerVpsServiceDeps, 'config' | 'fetchDispatcher'>,
  machine: Pick<UserMachineRecord, 'handle' | 'publicIPv4'>,
  body: string,
): Promise<Response> {
  const token = buildPlatformVerificationToken(machine.handle, deps.config.platformSecret);
  return fetch(`https://${machine.publicIPv4}:443/api/system/update`, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body,
    signal: AbortSignal.timeout(30_000),
    ...(deps.fetchDispatcher ? { dispatcher: deps.fetchDispatcher } : {}),
  } as RequestInit & { dispatcher?: import('undici').Dispatcher });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
