/**
 * Platform record (domain) types and input schemas.
 *
 * Extracted from ../db.ts (Phase 1-A2). Pure move: no logic changes.
 */
import { z } from 'zod/v4';
import type {
  BillingEntitlementSource,
  BillingEntitlementStatus,
  MatrixBillingInterval,
  MatrixBillingPlanSlug,
} from '../billing.js';
import {
  type DeveloperToolId,
} from '../developer-tools.js';

export interface ContainerRecord {
  handle: string;
  clerkUserId: string;
  containerId: string | null;
  port: number;
  shellPort: number;
  status: string;
  createdAt: string;
  lastActive: string;
}

export interface NewContainer {
  handle: string;
  clerkUserId: string;
  containerId: string | null;
  port: number;
  shellPort: number;
  status: string;
  createdAt?: string;
  lastActive?: string;
}

export interface PlatformUserRecord {
  id: string;
  clerkId: string;
  handle: string;
  displayName: string;
  email: string;
  containerId: string;
  containerVersion: string | null;
  plan: string;
  status: string;
  pipedreamExternalId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PlatformHandleConflict {
  source: 'users' | 'containers' | 'user_machines';
  clerkUserId: string;
}

export interface NewPlatformUser {
  clerkId: string;
  handle: string;
  displayName: string;
  email: string;
  containerId: string;
  containerVersion?: string | null;
  plan?: string;
  status?: string;
  pipedreamExternalId?: string | null;
}

export interface UserMachineRecord {
  machineId: string;
  clerkUserId: string;
  handle: string;
  runtimeSlot: string;
  provisioningClass: UserMachineProvisioningClass;
  accessClerkUserIds: string[];
  developerTools: DeveloperToolId[];
  hetznerServerId: number | null;
  publicIPv4: string | null;
  publicIPv6: string | null;
  status: string;
  imageVersion: string | null;
  sourceSnapshotId: string | null;
  sourceBaseGeneration: string | null;
  targetBundleVersion: string | null;
  targetBundleSha256: string | null;
  recoveryCreateActionId: number | null;
  recoveryEncryptedPayload: string | null;
  recoveryOldServerId: number | null;
  recoveryOldPublicIPv4: string | null;
  serverType: string | null;
  location: string | null;
  registrationTokenHash: string | null;
  registrationTokenExpiresAt: string | null;
  provisionedAt: string;
  lastSeenAt: string | null;
  deletedAt: string | null;
  failureCode: string | null;
  failureAt: string | null;
  resizeStartedAt: string | null;
  resizeTargetServerType: string | null;
  attempt: number;
  activationState: 'awaiting_billing' | 'authorized';
  prebillingIntentId: string | null;
  activationAuthorizedAt: string | null;
}

export type BillingCheckoutAttemptStatus = 'creating' | 'open' | 'paid' | 'expired' | 'abandoned';
const CHECKOUT_IDEMPOTENCY_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;
const CHECKOUT_SESSION_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;

export interface BillingCheckoutAttemptRecord {
  id: string;
  clerkUserId: string;
  stripeSessionId: string | null;
  checkoutUrl: string | null;
  runtimeSlot: string;
  planSlug: MatrixBillingPlanSlug | null;
  billingInterval: MatrixBillingInterval | null;
  regionSlug: string | null;
  serverType: string | null;
  trialPeriodDays: number | null;
  status: BillingCheckoutAttemptStatus;
  developerTools: DeveloperToolId[];
  createdAt: string;
  resolvedAt: string | null;
}

export interface OnboardingFirstRunRecord {
  clerkUserId: string;
  completedAt: string;
  goal: string | null;
  steps: Record<string, unknown>;
  source: string;
}

export interface NewOnboardingFirstRun {
  clerkUserId: string;
  completedAt: string;
  goal?: string | null;
  steps?: Record<string, unknown>;
  source: string;
}

export interface OnboardingJourneyEventRecord {
  id: string;
  clerkUserId: string;
  fromPhase: string | null;
  toPhase: string;
  detail: string | null;
  at: string;
}

export interface HostBundleReleaseRecord {
  version: string;
  channel: string | null;
  gitCommit: string;
  gitRef: string | null;
  snapshotEligible: boolean;
  buildTime: string;
  bundleKey: string;
  checksumKey: string | null;
  incrementalManifestKey: string | null;
  incrementalManifestSha256: string | null;
  sha256: string;
  size: number;
  severity: string;
  updateType: string;
  changelog: string | null;
  createdAt: string;
}

export interface NewHostBundleRelease {
  version: string;
  channel?: string | null;
  gitCommit: string;
  gitRef?: string | null;
  snapshotEligible?: boolean;
  buildTime: string;
  bundleKey: string;
  checksumKey?: string | null;
  incrementalManifestKey?: string | null;
  incrementalManifestSha256?: string | null;
  sha256: string;
  size: number;
  severity?: string;
  updateType?: string;
  changelog?: string | null;
  createdAt?: string;
}

export class HostBundleReleaseConflictError extends Error {
  constructor(version: string) {
    super(`Host bundle release already exists with different artifact fields: ${version}`);
    this.name = 'HostBundleReleaseConflictError';
  }
}

export interface HostBundleChannelRecord {
  channel: string;
  version: string;
  updatedAt: string;
}

export interface ProviderDeletionQueueRecord {
  id: string;
  providerServerId: number;
  reason: string;
  machineId: string | null;
  handle: string | null;
  attempts: number;
  nextAttemptAt: string;
  createdAt: string;
  lastError: string | null;
  completedAt: string | null;
}

export interface BillingCustomerRecord {
  clerkUserId: string;
  stripeCustomerId: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewBillingCustomer {
  clerkUserId: string;
  stripeCustomerId: string;
  createdAt: string;
  updatedAt: string;
}

export interface BillingEntitlementRecord {
  clerkUserId: string;
  source: BillingEntitlementSource;
  planSlug: MatrixBillingPlanSlug | 'internal';
  status: BillingEntitlementStatus;
  maxRuntimeSlots: number;
  includedRuntimeSlots: number;
  addonRuntimeSlots: number;
  defaultServerType: string;
  allowedServerTypes: string[];
  stripeSubscriptionId: string | null;
  stripePriceId: string | null;
  billingInterval: MatrixBillingInterval | null;
  gracePeriodEndsAt: string | null;
  trialStartedAt: string | null;
  trialEndsAt: string | null;
  trialConvertedAt: string | null;
  firstTrialPaymentFailedAt: string | null;
  effectiveFrom: string;
  effectiveUntil: string | null;
  updatedAt: string;
}

export interface BillingSubscriptionRecord {
  stripeSubscriptionId: string;
  stripeCustomerId: string;
  clerkUserId: string;
  runtimeSlot: string;
  planSlug: MatrixBillingPlanSlug;
  stripePriceId: string;
  billingInterval: MatrixBillingInterval | null;
  priceUnitAmountMinor: number | null;
  priceCurrency: string | null;
  priceIntervalCount: number | null;
  priceQuantity: number | null;
  status: BillingEntitlementStatus;
  currentPeriodEnd: string | null;
  gracePeriodEndsAt: string | null;
  trialStartedAt: string | null;
  trialEndsAt: string | null;
  trialConvertedAt: string | null;
  firstTrialPaymentFailedAt: string | null;
  latestEventCreatedAt: string;
  latestEventId: string;
  updatedAt: string;
}

export type NewBillingSubscription = Omit<
  BillingSubscriptionRecord,
  | 'billingInterval'
  | 'priceUnitAmountMinor'
  | 'priceCurrency'
  | 'priceIntervalCount'
  | 'priceQuantity'
  | 'trialStartedAt'
  | 'trialEndsAt'
  | 'trialConvertedAt'
  | 'firstTrialPaymentFailedAt'
> & {
  billingInterval: MatrixBillingInterval;
  priceUnitAmountMinor?: number | null;
  priceCurrency?: string | null;
  priceIntervalCount?: number | null;
  priceQuantity?: number | null;
  trialStartedAt?: string | null;
  trialEndsAt?: string | null;
  trialConvertedAt?: string | null;
  firstTrialPaymentFailedAt?: string | null;
};

export type NewBillingEntitlement = Omit<
  BillingEntitlementRecord,
  | 'billingInterval'
  | 'trialStartedAt'
  | 'trialEndsAt'
  | 'trialConvertedAt'
  | 'firstTrialPaymentFailedAt'
> & {
  billingInterval?: MatrixBillingInterval | null;
  trialStartedAt?: string | null;
  trialEndsAt?: string | null;
  trialConvertedAt?: string | null;
  firstTrialPaymentFailedAt?: string | null;
};

export interface BillingEntitlementOverrideRecord {
  id: string;
  clerkUserId: string;
  planSlug: MatrixBillingPlanSlug | 'internal';
  status: 'active';
  maxRuntimeSlots: number;
  includedRuntimeSlots: number;
  addonRuntimeSlots: number;
  defaultServerType: string;
  allowedServerTypes: string[];
  reason: string;
  createdBy: string;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export type NewBillingEntitlementOverride = BillingEntitlementOverrideRecord;

export interface BillingEntitlementStateRecord {
  entitlement?: BillingEntitlementRecord;
  override?: BillingEntitlementOverrideRecord;
}

export interface BillingWebhookEventRecord {
  stripeEventId: string;
  eventType: string;
  createdAtFromStripe: string;
  processedAt: string;
  status: string;
  errorCode: string | null;
}

export type NewBillingWebhookEvent = BillingWebhookEventRecord;


export interface NewUserMachine {
  machineId: string;
  clerkUserId: string;
  handle: string;
  runtimeSlot?: string;
  provisioningClass?: UserMachineProvisioningClass;
  accessClerkUserIds?: string[];
  developerTools?: DeveloperToolId[];
  hetznerServerId?: number | null;
  publicIPv4?: string | null;
  publicIPv6?: string | null;
  status: string;
  imageVersion?: string | null;
  sourceSnapshotId?: string | null;
  sourceBaseGeneration?: string | null;
  targetBundleVersion?: string | null;
  targetBundleSha256?: string | null;
  recoveryCreateActionId?: number | null;
  recoveryEncryptedPayload?: string | null;
  recoveryOldServerId?: number | null;
  recoveryOldPublicIPv4?: string | null;
  serverType?: string | null;
  location?: string | null;
  registrationTokenHash?: string | null;
  registrationTokenExpiresAt?: string | null;
  provisionedAt: string;
  lastSeenAt?: string | null;
  deletedAt?: string | null;
  failureCode?: string | null;
  failureAt?: string | null;
  resizeStartedAt?: string | null;
  resizeTargetServerType?: string | null;
  attempt?: number;
  activationState?: 'awaiting_billing' | 'authorized';
  prebillingIntentId?: string | null;
  activationAuthorizedAt?: string | null;
}

export const UserMachineProvisioningClassSchema = z.enum(['customer', 'preview']);
export type UserMachineProvisioningClass = z.infer<typeof UserMachineProvisioningClassSchema>;
const NullableProviderActionIdSchema = z.coerce.number().int().positive()
  .max(Number.MAX_SAFE_INTEGER).nullable();

export function parseNullableProviderActionId(value: number | string | null): number | null {
  return NullableProviderActionIdSchema.parse(value);
}

export interface NewProviderDeletionQueueRecord {
  id: string;
  providerServerId: number;
  reason: string;
  machineId?: string | null;
  handle?: string | null;
  attempts?: number;
  nextAttemptAt: string;
  createdAt: string;
  lastError?: string | null;
  completedAt?: string | null;
}
