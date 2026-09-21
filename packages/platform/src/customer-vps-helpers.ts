/**
 * VPS provisioning pure helpers (naming, host config, failure codes, guards).
 *
 * Extracted from ./customer-vps.ts (Phase 1-A4). Pure move: no logic changes.
 */
import type { HetznerClient } from './customer-vps-hetzner.js';
import {
  CustomerVpsError,
  genericProviderError,
  type CustomerVpsFailureCode,
} from './customer-vps-errors.js';
import type { PlatformDB } from './db.js';
import type { BillingEntitlement } from './billing.js';
import type { UserMachineRecord } from './db.js';
import type { CustomerVpsServiceDeps } from './customer-vps.js';
import type { CustomerVpsConfig } from './customer-vps-config.js';
import type { ProvisionRequest } from './customer-vps-schema.js';
import type { UserMachineProvisioningClass } from './db.js';
import type { HostBundleRef } from './customer-vps-host-bundle.js';
import type { CustomerHostConfig } from './customer-vps-cloud-init.js';
import { developerToolsShellList, DEFAULT_DEVELOPER_TOOLS } from './developer-tools.js';
import { buildPlatformRuntimeVerificationToken, buildPlatformVerificationToken } from './platform-token.js';
import { getActiveUserMachineByClerkId } from './db.js';
import { getRuntimeAccessDecision } from './billing.js';
import type { CustomerVpsStatus } from './customer-vps-schema.js';

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

export { DEFAULT_CLOUD_INIT_TEMPLATE, buildHostConfig } from './customer-vps-host-config.js';

export function isAmbiguousProviderCreateError(err: unknown): boolean {
  return !(err instanceof CustomerVpsError)
    || err.code === 'provider_timeout'
    || err.code === 'provider_unavailable';
}

export function toFailureCode(err: unknown): CustomerVpsFailureCode {
  return err instanceof CustomerVpsError ? err.code : genericProviderError(err).code;
}


export function buildServerName(handle: string): string {
  return `matrix-${handle}`;
}

export function buildRecoveryServerName(handle: string, machineId: string): string {
  const suffix = machineId.replaceAll('-', '').slice(0, 8);
  return `${buildServerName(handle).slice(0, 54)}-${suffix}`;
}

export async function assertMachineProviderMutationAllowed(
  deps: Pick<CustomerVpsServiceDeps, 'db' | 'resolveBillingEntitlement'>,
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

export function billingUpgradeRequired(): CustomerVpsError {
  return new CustomerVpsError(402, 'billing_required', 'Billing upgrade required');
}

export function normalizeServerType(serverType: string): string {
  return serverType.trim().toLowerCase();
}

export function allowedEntitlementServerTypes(entitlement: BillingEntitlement): string[] {
  return entitlement.allowedServerTypes
    .map(normalizeServerType)
    .filter((serverType) => serverType.length > 0);
}

export async function assertBillingResizeAllowed(
  deps: Pick<CustomerVpsServiceDeps, 'db' | 'resolveBillingEntitlement'>,
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
