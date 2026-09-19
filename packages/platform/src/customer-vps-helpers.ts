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

export const DEFAULT_CLOUD_INIT_TEMPLATE = [
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
  '      MATRIX_COLLABORATION_ENABLED=false',
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

export function isAmbiguousProviderCreateError(err: unknown): boolean {
  return !(err instanceof CustomerVpsError)
    || err.code === 'provider_timeout'
    || err.code === 'provider_unavailable';
}

export function toFailureCode(err: unknown): CustomerVpsFailureCode {
  return err instanceof CustomerVpsError ? err.code : genericProviderError(err).code;
}

export function buildHostConfig(
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
