import { randomUUID } from 'node:crypto';
import {
  Kysely,
  PostgresDialect,
  sql,
  type Generated,
  type Insertable,
  type InsertObject,
  type Selectable,
  type Transaction,
  type Updateable,
} from 'kysely';
import pg from 'pg';
import { z } from 'zod/v4';
import type {
  BillingEntitlementSource,
  BillingEntitlementStatus,
  MatrixBillingInterval,
  MatrixBillingPlanSlug,
} from './billing.js';
import {
  DEFAULT_DEVELOPER_TOOLS,
  parseDeveloperToolsJson,
  serializeDeveloperTools,
  type DeveloperToolId,
} from './developer-tools.js';

const DEFAULT_PLATFORM_DB_URL =
  process.env.PLATFORM_DATABASE_URL ??
  (process.env.POSTGRES_URL ? `${process.env.POSTGRES_URL}/matrixos_platform` : undefined);
const HostBundleTimestampSchema = z.string().datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());

type Executor = Kysely<PlatformDatabase> | Transaction<PlatformDatabase>;

interface ContainersTable {
  handle: string;
  clerk_user_id: string;
  container_id: string | null;
  port: number;
  shell_port: number;
  status: string;
  created_at: string;
  last_active: string;
}

interface UsersTable {
  id: string;
  clerk_id: string;
  handle: string;
  display_name: string;
  email: string;
  container_id: string;
  container_version: string | null;
  plan: string;
  status: string;
  pipedream_external_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface UserMachinesTable {
  machine_id: string;
  clerk_user_id: string;
  handle: string;
  runtime_slot: string;
  provisioning_class: string;
  access_clerk_user_ids: string[];
  developer_tools: string;
  hetzner_server_id: number | null;
  public_ipv4: string | null;
  public_ipv6: string | null;
  status: string;
  image_version: string | null;
  source_snapshot_id: string | null;
  source_base_generation: string | null;
  target_bundle_version: string | null;
  target_bundle_sha256: string | null;
  recovery_create_action_id: number | null;
  recovery_encrypted_payload: string | null;
  recovery_old_server_id: number | null;
  recovery_old_public_ipv4: string | null;
  server_type: string | null;
  location: string | null;
  registration_token_hash: string | null;
  registration_token_expires_at: string | null;
  provisioned_at: string;
  last_seen_at: string | null;
  deleted_at: string | null;
  failure_code: string | null;
  failure_at: string | null;
  resize_started_at: string | null;
  resize_target_server_type: string | null;
  attempt: number;
  activation_state: Generated<string>;
  prebilling_intent_id: Generated<string | null>;
  activation_authorized_at: Generated<string | null>;
}

export interface AiFundedGlobalPolicyTable {
  policy_id: string;
  enabled: boolean;
  allowed_model_ids: string;
  revision: number;
  updated_at: string;
}

export interface AiFundedRuntimePoliciesTable {
  machine_id: string;
  owner_id: string;
  runtime_slot: string;
  enabled: boolean;
  allowed_model_ids: string;
  monthly_budget_microusd: number;
  expires_at: string | null;
  next_issue_at: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface AiRuntimeCredentialsTable {
  token_id: string;
  token_hash: string;
  owner_id: string;
  machine_id: string;
  runtime_slot: string;
  audience: string;
  scope: string;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface AiFundedUsageReservationsTable {
  reservation_id: string;
  request_id: string;
  payload_hash: string;
  authorization_response: string;
  settlement_response: string | null;
  finalization_mode: string | null;
  start_response: string | null;
  release_response: string | null;
  release_reason: string | null;
  token_id: string;
  owner_id: string;
  machine_id: string;
  runtime_slot: string;
  model_id: string;
  reserved_microusd: number;
  promotional_reserved_microusd: number | null;
  addon_reserved_microusd: number | null;
  actual_microusd: number | null;
  period_start: string;
  status: string;
  created_at: string;
  started_at: string | null;
  expires_at: string;
  settled_at: string | null;
  released_at: string | null;
}

export interface AiFundedReservationPromotionalAllocationsTable {
  reservation_id: string;
  grant_entry_id: string;
  amount_microusd: number;
  created_at: string;
}

export interface AiFundedRuntimeBalancesTable {
  machine_id: string;
  owner_id: string;
  runtime_slot: string;
  credit_balance_microusd: number;
  promotional_balance_microusd: number;
  addon_balance_microusd: number;
  reserved_microusd: number;
  funding_shortfall_microusd: number;
  month_period_start: string;
  month_spent_microusd: number;
  month_reserved_microusd: number;
  updated_at: string;
}

export interface AiFundedCreditLedgerTable {
  entry_id: string;
  owner_id: string;
  machine_id: string;
  runtime_slot: string;
  kind: string;
  amount_microusd: number;
  source_reference: string;
  reservation_id: string | null;
  period_start: string | null;
  expires_at: string | null;
  created_at: string;
}

export interface AiFundedPromotionalGrantBalancesTable {
  grant_entry_id: string;
  owner_id: string;
  machine_id: string;
  runtime_slot: string;
  remaining_microusd: number;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  revision: number;
}

export interface ProvisioningJobsTable {
  job_id: string;
  machine_id: string;
  status: string;
  attempts: number;
  available_at: string;
  claimed_at: string | null;
  lease_expires_at: string | null;
  encrypted_payload: string | null;
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  target_bundle_version: string | null;
  target_bundle_sha256: string | null;
  image_source: string;
  snapshot_id: string | null;
  snapshot_lease_id: string | null;
  snapshot_create_intent_id: Generated<string | null>;
  activation_step: string;
  provider_create_action_id: number | null;
  fallback_reason: string | null;
  authorization_basis: Generated<string>;
  prebilling_intent_id: Generated<string | null>;
}

interface HostBundleReleasesTable {
  version: string;
  channel: string | null;
  git_commit: string;
  git_ref: string | null;
  snapshot_eligible: boolean;
  snapshot_eligibility_source: string;
  build_time: string;
  bundle_key: string;
  checksum_key: string | null;
  incremental_manifest_key: string | null;
  incremental_manifest_sha256: string | null;
  sha256: string;
  size: number;
  severity: string;
  update_type: string;
  changelog: string | null;
  created_at: string;
}

interface HostBundleChannelsTable {
  channel: string;
  version: string;
  updated_at: string;
}

interface HostBundleReleaseChannelsTable {
  channel: string;
  version: string;
  promoted_at: string;
}

export interface GoldenSnapshotsTable {
  snapshot_id: string;
  bundle_version: string;
  bundle_sha256: string;
  source_git_commit: string;
  compatibility_key: string;
  provider: string;
  architecture: string;
  region: string;
  base_image: string;
  base_generation: string;
  boot_mode: string;
  activation_abi: string;
  minimum_disk_gb: number;
  test_mode: boolean;
  image_generation: number;
  state: string;
  provider_image_id: number | null;
  provider_image_status: string | null;
  image_disk_gb: number | null;
  image_architecture: string | null;
  validation_summary: unknown | null;
  failure_code: string | null;
  ready_at: string | null;
  quarantined_at: string | null;
  retiring_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  revision: number;
}

export interface GoldenSnapshotBuildsTable {
  build_id: string;
  snapshot_id: string;
  phase: string;
  status: string;
  attempts: number;
  available_at: string;
  claimed_at: string | null;
  lease_expires_at: string | null;
  callback_phase: string | null;
  callback_token_hash: string | null;
  callback_expires_at: string | null;
  callback_event_id: string | null;
  callback_payload_sha256: string | null;
  callback_outcome: unknown | null;
  builder_machine_id_sha256: string | null;
  builder_ssh_host_key_sha256: string | null;
  validation_clone_ordinal: number;
  first_validation_machine_id_sha256: string | null;
  first_validation_ssh_host_key_sha256: string | null;
  provider_builder_id: number | null;
  provider_builder_action_id: number | null;
  provider_snapshot_action_id: number | null;
  provider_validation_id: number | null;
  provider_validation_action_id: number | null;
  pending_operation: string | null;
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface GoldenSnapshotLeasesTable {
  lease_id: string;
  snapshot_id: string;
  machine_id: string;
  purpose: string;
  target_bundle_version: string;
  created_at: string;
  expires_at: string;
  released_at: string | null;
}

export interface GoldenSnapshotCallbackReceiptsTable {
  build_id: string;
  event_id: string;
  callback_phase: string;
  token_sha256: string | null;
  payload_sha256: string;
  outcome: unknown;
  created_at: string;
  expires_at: string;
}

export interface GoldenSnapshotCreateIntentsTable {
  intent_id: string;
  snapshot_id: string;
  lease_id: string;
  machine_id: string;
  purpose: string;
  rollout_generation: number;
  state: string;
  provider_create_action_id: number | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface GoldenSnapshotRolloutControlsTable {
  compatibility_key: string;
  enabled: boolean;
  percentage: number;
  generation: number;
  updated_at: string;
}

export interface GoldenSnapshotRevokedBaseGenerationsTable {
  base_generation: string;
  reason: string;
  revoked_at: string;
  updated_at: string;
}

export interface GoldenSnapshotCleanupTable {
  cleanup_id: string;
  snapshot_id: string | null;
  build_id: string | null;
  resource_type: string;
  provider_resource_id: number;
  provenance_key: string;
  reason: string;
  status: string;
  attempts: number;
  next_attempt_at: string;
  lease_expires_at: string | null;
  last_error_code: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface GoldenSnapshotAuditEventsTable {
  event_id: string;
  snapshot_id: string | null;
  build_id: string | null;
  cleanup_id: string | null;
  event_type: string;
  actor_type: string;
  actor_id_hash: string | null;
  from_state: string | null;
  to_state: string | null;
  reason: string | null;
  created_at: string;
}

interface ProviderDeletionQueueTable {
  id: string;
  provider_server_id: number;
  reason: string;
  machine_id: string | null;
  handle: string | null;
  attempts: number;
  next_attempt_at: string;
  created_at: string;
  last_error: string | null;
  completed_at: string | null;
}

interface BillingCustomersTable {
  clerk_user_id: string;
  stripe_customer_id: string;
  created_at: string;
  updated_at: string;
}

interface BillingEntitlementsTable {
  clerk_user_id: string;
  source: string;
  plan_slug: string;
  status: string;
  max_runtime_slots: number;
  included_runtime_slots: number;
  addon_runtime_slots: number;
  default_server_type: string;
  allowed_server_types: string;
  stripe_subscription_id: string | null;
  stripe_price_id: string | null;
  billing_interval: string | null;
  grace_period_ends_at: string | null;
  trial_started_at: string | null;
  trial_ends_at: string | null;
  trial_converted_at: string | null;
  first_trial_payment_failed_at: string | null;
  effective_from: string;
  effective_until: string | null;
  updated_at: string;
}

interface BillingSubscriptionsTable {
  stripe_subscription_id: string;
  stripe_customer_id: string;
  clerk_user_id: string;
  runtime_slot: string;
  plan_slug: string;
  stripe_price_id: string;
  billing_interval: string | null;
  status: string;
  current_period_end: string | null;
  grace_period_ends_at: string | null;
  trial_started_at: string | null;
  trial_ends_at: string | null;
  trial_converted_at: string | null;
  first_trial_payment_failed_at: string | null;
  latest_event_created_at: string;
  latest_event_id: string;
  latest_invoice_event_created_at: string | null;
  latest_invoice_event_id: string | null;
  updated_at: string;
}

interface BillingEntitlementOverridesTable {
  id: string;
  clerk_user_id: string;
  plan_slug: string;
  status: string;
  max_runtime_slots: number;
  included_runtime_slots: number;
  addon_runtime_slots: number;
  default_server_type: string;
  allowed_server_types: string;
  reason: string;
  created_by: string;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

interface BillingWebhookEventsTable {
  stripe_event_id: string;
  event_type: string;
  created_at_from_stripe: string;
  processed_at: string;
  status: string;
  error_code: string | null;
}

interface BillingRuntimeActionsTable {
  id: string;
  machine_id: string;
  stripe_subscription_id: string;
  action: string;
  reason: string;
  status: string;
  execute_after: string;
  attempts: number;
  claimed_at: string | null;
  lease_expires_at: string | null;
  cancel_requested_at: string | null;
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface PortAssignmentsTable {
  port: number;
  handle: string | null;
}

interface DeviceCodesTable {
  device_code: string;
  user_code: string;
  clerk_user_id: string | null;
  runtime_slot: string | null;
  runtime_handle: string | null;
  expires_at: number;
  last_polled_at: number | null;
  created_at: number;
}

interface MatrixUsersTable {
  handle: string;
  human_matrix_id: string;
  ai_matrix_id: string;
  human_access_token: string;
  ai_access_token: string;
  created_at: string;
}

interface AppsRegistryTable {
  id: string;
  name: string;
  slug: string;
  author_id: string;
  description: string | null;
  category: string | null;
  tags: string | null;
  version: string | null;
  source_url: string | null;
  manifest: string | null;
  screenshots: string | null;
  installs: number;
  rating: number;
  ratings_count: number;
  forks_count: number;
  is_public: boolean;
  created_at: string;
  updated_at: string;
}

interface AppRatingsTable {
  app_id: string;
  user_id: string;
  rating: number;
  review: string | null;
  created_at: string;
}

interface AppInstallsTable {
  app_id: string;
  user_id: string;
  installed_at: string;
}

interface SocialPostsTable {
  id: string;
  author_id: string;
  content: string;
  type: string;
  media_urls: string | null;
  app_ref: string | null;
  likes_count: number;
  comments_count: number;
  created_at: string;
}

interface SocialCommentsTable {
  id: string;
  post_id: string;
  author_id: string;
  content: string;
  created_at: string;
}

interface SocialLikesTable {
  post_id: string;
  user_id: string;
  created_at: string;
}

interface SocialFollowsTable {
  follower_id: string;
  following_id: string;
  following_type: string;
  created_at: string;
}

interface BillingCheckoutAttemptsTable {
  id: string;
  clerk_user_id: string;
  stripe_session_id: string | null;
  checkout_url: string | null;
  runtime_slot: string;
  plan_slug: string | null;
  billing_interval: string | null;
  region_slug: string | null;
  server_type: string | null;
  trial_period_days: number | null;
  developer_tools: string;
  status: string;
  created_at: string;
  resolved_at: string | null;
}

export interface PrebillingProvisioningIntentsTable {
  id: string;
  checkout_attempt_id: string;
  clerk_user_id: string;
  runtime_slot: string;
  plan_slug: string;
  billing_interval: string;
  server_type: string;
  region_slug: string;
  developer_tools: string;
  state: string;
  revision: number;
  machine_id: string | null;
  stripe_session_id: string | null;
  stripe_session_expires_at: string | null;
  lease_expires_at: string | null;
  reserved_hourly_cost_micros: number;
  cleanup_claimed_at: string | null;
  cleanup_lease_expires_at: string | null;
  ready_at: string | null;
  payment_confirmed_at: string | null;
  authorized_at: string | null;
  cleaned_at: string | null;
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
}

interface BillingTrialAccountsTable {
  clerk_user_id: string;
  trial_checkout_attempt_id: string | null;
  consumed_at: string | null;
  updated_at: string;
}

interface OnboardingFirstRunTable {
  clerk_user_id: string;
  completed_at: string;
  goal: string | null;
  steps: string;
  source: string;
}

interface OnboardingJourneyEventsTable {
  id: string;
  clerk_user_id: string;
  from_phase: string | null;
  to_phase: string;
  detail: string | null;
  at: string;
}

export interface PlatformDatabase {
  users: UsersTable;
  containers: ContainersTable;
  user_machines: UserMachinesTable;
  ai_funded_global_policy: AiFundedGlobalPolicyTable;
  ai_funded_runtime_policies: AiFundedRuntimePoliciesTable;
  ai_runtime_credentials: AiRuntimeCredentialsTable;
  ai_funded_usage_reservations: AiFundedUsageReservationsTable;
  ai_funded_reservation_promotional_allocations: AiFundedReservationPromotionalAllocationsTable;
  ai_funded_credit_ledger: AiFundedCreditLedgerTable;
  ai_funded_promotional_grant_balances: AiFundedPromotionalGrantBalancesTable;
  ai_funded_runtime_balances: AiFundedRuntimeBalancesTable;
  provisioning_jobs: ProvisioningJobsTable;
  billing_checkout_attempts: BillingCheckoutAttemptsTable;
  prebilling_provisioning_intents: PrebillingProvisioningIntentsTable;
  billing_trial_accounts: BillingTrialAccountsTable;
  onboarding_first_run: OnboardingFirstRunTable;
  onboarding_journey_events: OnboardingJourneyEventsTable;
  host_bundle_releases: HostBundleReleasesTable;
  host_bundle_channels: HostBundleChannelsTable;
  host_bundle_release_channels: HostBundleReleaseChannelsTable;
  golden_snapshots: GoldenSnapshotsTable;
  golden_snapshot_builds: GoldenSnapshotBuildsTable;
  golden_snapshot_callback_receipts: GoldenSnapshotCallbackReceiptsTable;
  golden_snapshot_create_intents: GoldenSnapshotCreateIntentsTable;
  golden_snapshot_rollout_controls: GoldenSnapshotRolloutControlsTable;
  golden_snapshot_leases: GoldenSnapshotLeasesTable;
  golden_snapshot_revoked_base_generations: GoldenSnapshotRevokedBaseGenerationsTable;
  golden_snapshot_cleanup: GoldenSnapshotCleanupTable;
  golden_snapshot_audit_events: GoldenSnapshotAuditEventsTable;
  provider_deletion_queue: ProviderDeletionQueueTable;
  billing_customers: BillingCustomersTable;
  billing_subscriptions: BillingSubscriptionsTable;
  billing_entitlements: BillingEntitlementsTable;
  billing_entitlement_overrides: BillingEntitlementOverridesTable;
  billing_webhook_events: BillingWebhookEventsTable;
  billing_runtime_actions: BillingRuntimeActionsTable;
  port_assignments: PortAssignmentsTable;
  device_codes: DeviceCodesTable;
  matrix_users: MatrixUsersTable;
  apps_registry: AppsRegistryTable;
  app_ratings: AppRatingsTable;
  app_installs: AppInstallsTable;
  social_posts: SocialPostsTable;
  social_comments: SocialCommentsTable;
  social_likes: SocialLikesTable;
  social_follows: SocialFollowsTable;
}

export interface PlatformDB {
  kysely: Kysely<PlatformDatabase>;
  executor: Executor;
  ready: Promise<void>;
  transaction<T>(fn: (trx: PlatformDB) => Promise<T>): Promise<T>;
  destroy(): Promise<void>;
}

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
  | 'trialStartedAt'
  | 'trialEndsAt'
  | 'trialConvertedAt'
  | 'firstTrialPaymentFailedAt'
> & {
  billingInterval: MatrixBillingInterval;
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

export {
  cancelOutstandingBillingRuntimeActions,
  cancelQueuedBillingRuntimeActions,
  claimBillingRuntimeAction,
  completeBillingRuntimeAction,
  enqueueBillingRuntimeAction,
  finalizeBillingRuntimeAction,
  isBillingRuntimeActionRunnable,
  listBillingRuntimeActions,
  listDispatchableBillingRuntimeActions,
  listDispatchableBillingRuntimeActionsForMachine,
  retryBillingRuntimeAction,
} from './billing-runtime-action-store.js';
export type {
  BillingRuntimeAction,
  BillingRuntimeActionRecord,
  BillingRuntimeActionStatus,
} from './billing-runtime-action-store.js';

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

function wrapDb(
  kysely: Kysely<PlatformDatabase>,
  executor: Executor,
  ready: Promise<void>,
  destroyFn: () => Promise<void>,
): PlatformDB {
  return {
    kysely,
    executor,
    ready,
    async transaction(fn) {
      await ready;
      return kysely.transaction().execute((trx) =>
        fn(wrapDb(kysely, trx, Promise.resolve(), destroyFn)),
      );
    },
    destroy: destroyFn,
  };
}

async function migrate(db: Kysely<PlatformDatabase>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      clerk_id             TEXT UNIQUE NOT NULL,
      handle               TEXT UNIQUE NOT NULL,
      display_name         TEXT NOT NULL,
      email                TEXT NOT NULL,
      container_id         TEXT UNIQUE NOT NULL,
      container_version    TEXT,
      plan                 TEXT NOT NULL DEFAULT 'free',
      status               TEXT NOT NULL DEFAULT 'active',
      pipedream_external_id TEXT,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_users_pipedream_ext_id ON users(pipedream_external_id)`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS containers (
      handle TEXT PRIMARY KEY,
      clerk_user_id TEXT UNIQUE NOT NULL,
      container_id TEXT,
      port INTEGER NOT NULL,
      shell_port INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'provisioning',
      created_at TEXT NOT NULL,
      last_active TEXT NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_containers_status ON containers(status)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_containers_clerk ON containers(clerk_user_id)`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS user_machines (
      machine_id TEXT PRIMARY KEY,
      clerk_user_id TEXT NOT NULL,
      handle TEXT NOT NULL,
      runtime_slot TEXT NOT NULL DEFAULT 'primary',
      provisioning_class TEXT NOT NULL DEFAULT 'customer',
      access_clerk_user_ids TEXT[] NOT NULL DEFAULT '{}',
      developer_tools TEXT NOT NULL DEFAULT '["codex","claude-code","opencode","pi"]',
      hetzner_server_id INTEGER,
      public_ipv4 TEXT,
      public_ipv6 TEXT,
      status TEXT NOT NULL DEFAULT 'provisioning',
      image_version TEXT,
      source_snapshot_id TEXT,
      source_base_generation TEXT,
      target_bundle_version TEXT,
      target_bundle_sha256 TEXT,
      recovery_create_action_id BIGINT,
      recovery_encrypted_payload TEXT,
      recovery_old_server_id BIGINT,
      recovery_old_public_ipv4 TEXT,
      server_type TEXT,
      location TEXT,
      registration_token_hash TEXT,
      registration_token_expires_at TEXT,
      provisioned_at TEXT NOT NULL,
      last_seen_at TEXT,
      deleted_at TEXT,
      failure_code TEXT,
      failure_at TEXT,
      resize_started_at TEXT,
      resize_target_server_type TEXT,
      attempt INTEGER NOT NULL DEFAULT 1,
      activation_state TEXT NOT NULL DEFAULT 'authorized',
      prebilling_intent_id TEXT,
      activation_authorized_at TEXT
    )
  `.execute(db);
  await sql`ALTER TABLE user_machines ADD COLUMN IF NOT EXISTS runtime_slot TEXT NOT NULL DEFAULT 'primary'`.execute(db);
  await sql`ALTER TABLE user_machines ADD COLUMN IF NOT EXISTS provisioning_class TEXT NOT NULL DEFAULT 'customer'`.execute(db);
  await sql`ALTER TABLE user_machines ADD COLUMN IF NOT EXISTS access_clerk_user_ids TEXT[] NOT NULL DEFAULT '{}'`.execute(db);
  await sql`ALTER TABLE user_machines ADD COLUMN IF NOT EXISTS developer_tools TEXT NOT NULL DEFAULT '["codex","claude-code","opencode","pi"]'`.execute(db);
  await sql`ALTER TABLE user_machines ADD COLUMN IF NOT EXISTS source_snapshot_id TEXT`.execute(db);
  await sql`ALTER TABLE user_machines ADD COLUMN IF NOT EXISTS source_base_generation TEXT`.execute(db);
  await sql`ALTER TABLE user_machines ADD COLUMN IF NOT EXISTS target_bundle_version TEXT`.execute(db);
  await sql`ALTER TABLE user_machines ADD COLUMN IF NOT EXISTS target_bundle_sha256 TEXT`.execute(db);
  await sql`ALTER TABLE user_machines ADD COLUMN IF NOT EXISTS recovery_create_action_id BIGINT`.execute(db);
  await sql`ALTER TABLE user_machines ADD COLUMN IF NOT EXISTS recovery_encrypted_payload TEXT`.execute(db);
  await sql`ALTER TABLE user_machines ADD COLUMN IF NOT EXISTS recovery_old_server_id BIGINT`.execute(db);
  await sql`ALTER TABLE user_machines ADD COLUMN IF NOT EXISTS recovery_old_public_ipv4 TEXT`.execute(db);
  await sql`ALTER TABLE user_machines ADD COLUMN IF NOT EXISTS server_type TEXT`.execute(db);
  await sql`ALTER TABLE user_machines ADD COLUMN IF NOT EXISTS location TEXT`.execute(db);
  await sql`ALTER TABLE user_machines ADD COLUMN IF NOT EXISTS resize_started_at TEXT`.execute(db);
  await sql`ALTER TABLE user_machines ADD COLUMN IF NOT EXISTS resize_target_server_type TEXT`.execute(db);
  await sql`ALTER TABLE user_machines ADD COLUMN IF NOT EXISTS attempt INTEGER NOT NULL DEFAULT 1`.execute(db);
  await sql`ALTER TABLE user_machines ADD COLUMN IF NOT EXISTS activation_state TEXT NOT NULL DEFAULT 'authorized'`.execute(db);
  await sql`ALTER TABLE user_machines ADD COLUMN IF NOT EXISTS prebilling_intent_id TEXT`.execute(db);
  await sql`ALTER TABLE user_machines ADD COLUMN IF NOT EXISTS activation_authorized_at TEXT`.execute(db);
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_machines_active_prebilling_intent ON user_machines(prebilling_intent_id) WHERE prebilling_intent_id IS NOT NULL AND deleted_at IS NULL`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_user_machines_prebilling_intent`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_user_machines_status ON user_machines(status)`.execute(db);
  await sql`ALTER TABLE user_machines DROP CONSTRAINT IF EXISTS user_machines_clerk_user_id_key`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_user_machines_clerk`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_user_machines_clerk_active`.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_machines_clerk_slot_active
    ON user_machines(clerk_user_id, runtime_slot)
    WHERE deleted_at IS NULL
  `.execute(db);
  // A Matrix login can own more than one active VPS slot. Slot-qualified
  // routing selects the requested runtime; unqualified handle routing resolves
  // deterministically to primary first in the read helpers below.
  await sql`DROP INDEX IF EXISTS idx_user_machines_handle_active`.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_machines_handle_slot_active
    ON user_machines(handle, runtime_slot)
    WHERE deleted_at IS NULL
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_user_machines_clerk_slot_status ON user_machines(clerk_user_id, runtime_slot, status)`.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_user_machines_preview_access
    ON user_machines USING GIN(access_clerk_user_ids)
    WHERE deleted_at IS NULL AND provisioning_class = 'preview'
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_user_machines_hetzner ON user_machines(hetzner_server_id)`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS ai_funded_global_policy (
      policy_id TEXT PRIMARY KEY CHECK (policy_id = 'default'),
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      allowed_model_ids TEXT NOT NULL DEFAULT '[]',
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      updated_at TEXT NOT NULL
    )
  `.execute(db);
  await sql`
    INSERT INTO ai_funded_global_policy (policy_id, enabled, allowed_model_ids, revision, updated_at)
    VALUES ('default', FALSE, '[]', 0, '1970-01-01T00:00:00.000Z')
    ON CONFLICT (policy_id) DO NOTHING
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS ai_funded_runtime_policies (
      machine_id TEXT PRIMARY KEY REFERENCES user_machines(machine_id) ON UPDATE CASCADE ON DELETE CASCADE,
      owner_id TEXT NOT NULL,
      runtime_slot TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      allowed_model_ids TEXT NOT NULL DEFAULT '[]',
      monthly_budget_microusd BIGINT NOT NULL DEFAULT 0 CHECK (monthly_budget_microusd >= 0),
      expires_at TEXT,
      next_issue_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `.execute(db);
  await sql`ALTER TABLE ai_funded_runtime_policies ADD COLUMN IF NOT EXISTS next_issue_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'`.execute(db);
  await sql`ALTER TABLE ai_funded_runtime_policies ADD COLUMN IF NOT EXISTS monthly_budget_microusd BIGINT NOT NULL DEFAULT 0 CHECK (monthly_budget_microusd >= 0)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_ai_funded_runtime_owner ON ai_funded_runtime_policies(owner_id, runtime_slot)`.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS ai_runtime_credentials (
      token_id TEXT PRIMARY KEY,
      token_hash TEXT UNIQUE NOT NULL CHECK (length(token_hash) = 64),
      owner_id TEXT NOT NULL,
      machine_id TEXT NOT NULL REFERENCES user_machines(machine_id) ON UPDATE CASCADE ON DELETE CASCADE,
      runtime_slot TEXT NOT NULL,
      audience TEXT NOT NULL CHECK (audience = 'matrix-funded-relay'),
      scope TEXT NOT NULL CHECK (scope = 'ai:invoke'),
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_ai_runtime_credentials_machine_issued ON ai_runtime_credentials(machine_id, issued_at DESC)`.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS ai_funded_runtime_balances (
      machine_id TEXT PRIMARY KEY REFERENCES user_machines(machine_id) ON UPDATE CASCADE ON DELETE CASCADE,
      owner_id TEXT NOT NULL,
      runtime_slot TEXT NOT NULL,
      credit_balance_microusd BIGINT NOT NULL DEFAULT 0 CHECK (credit_balance_microusd >= 0),
      promotional_balance_microusd BIGINT NOT NULL DEFAULT 0 CHECK (promotional_balance_microusd >= 0),
      addon_balance_microusd BIGINT NOT NULL DEFAULT 0 CHECK (addon_balance_microusd >= 0),
      reserved_microusd BIGINT NOT NULL DEFAULT 0 CHECK (reserved_microusd >= 0),
      funding_shortfall_microusd BIGINT NOT NULL DEFAULT 0 CHECK (funding_shortfall_microusd >= 0),
      month_period_start TEXT NOT NULL,
      month_spent_microusd BIGINT NOT NULL DEFAULT 0 CHECK (month_spent_microusd >= 0),
      month_reserved_microusd BIGINT NOT NULL DEFAULT 0 CHECK (month_reserved_microusd >= 0),
      updated_at TEXT NOT NULL
    )
  `.execute(db);
  await sql`
    ALTER TABLE ai_funded_runtime_balances
    ADD COLUMN IF NOT EXISTS funding_shortfall_microusd BIGINT NOT NULL DEFAULT 0
      CHECK (funding_shortfall_microusd >= 0)
  `.execute(db);
  const fundedAiMigrationTime = new Date();
  const fundedAiMigrationAt = fundedAiMigrationTime.toISOString();
  const fundedAiMigrationPeriodStart = new Date(Date.UTC(
    fundedAiMigrationTime.getUTCFullYear(), fundedAiMigrationTime.getUTCMonth(), 1,
  )).toISOString();
  await sql`
    INSERT INTO ai_funded_runtime_balances (
      machine_id, owner_id, runtime_slot, credit_balance_microusd,
      promotional_balance_microusd, addon_balance_microusd, reserved_microusd,
      month_period_start, month_spent_microusd, month_reserved_microusd, updated_at
    )
    SELECT
      machine_id, owner_id, runtime_slot, 0,
      0, 0, 0,
      ${fundedAiMigrationPeriodStart}, 0, 0, ${fundedAiMigrationAt}
    FROM ai_funded_runtime_policies
    ON CONFLICT (machine_id) DO NOTHING
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS ai_funded_usage_reservations (
      reservation_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
      authorization_response TEXT NOT NULL,
      settlement_response TEXT,
      finalization_mode TEXT CHECK (finalization_mode IN ('exact', 'conservative')),
      start_response TEXT,
      release_response TEXT,
      release_reason TEXT,
      token_id TEXT NOT NULL REFERENCES ai_runtime_credentials(token_id) ON UPDATE CASCADE ON DELETE CASCADE,
      owner_id TEXT NOT NULL,
      machine_id TEXT NOT NULL REFERENCES user_machines(machine_id) ON UPDATE CASCADE ON DELETE CASCADE,
      runtime_slot TEXT NOT NULL,
      model_id TEXT NOT NULL,
      reserved_microusd BIGINT NOT NULL CHECK (reserved_microusd > 0),
      promotional_reserved_microusd BIGINT CHECK (promotional_reserved_microusd >= 0),
      addon_reserved_microusd BIGINT CHECK (addon_reserved_microusd >= 0),
      actual_microusd BIGINT CHECK (actual_microusd >= 0),
      period_start TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('reserved', 'starting', 'in_flight', 'settling', 'releasing', 'settled', 'released', 'expired')),
      created_at TEXT NOT NULL,
      started_at TEXT,
      expires_at TEXT NOT NULL,
      settled_at TEXT,
      released_at TEXT,
      CONSTRAINT ai_funded_reservation_sources_check CHECK (
        (promotional_reserved_microusd IS NULL AND addon_reserved_microusd IS NULL)
        OR (
          promotional_reserved_microusd IS NOT NULL
          AND addon_reserved_microusd IS NOT NULL
          AND promotional_reserved_microusd + addon_reserved_microusd = reserved_microusd
        )
      ),
      UNIQUE (token_id, request_id)
    )
  `.execute(db);
  await sql`ALTER TABLE ai_funded_usage_reservations ADD COLUMN IF NOT EXISTS promotional_reserved_microusd BIGINT CHECK (promotional_reserved_microusd >= 0)`.execute(db);
  await sql`ALTER TABLE ai_funded_usage_reservations ADD COLUMN IF NOT EXISTS addon_reserved_microusd BIGINT CHECK (addon_reserved_microusd >= 0)`.execute(db);
  // Existing reservations intentionally remain NULL/NULL: historical rows do
  // not contain evidence of which funding source paid for them. Runtime expiry
  // reconciliation protects promotion only through explicit allocation rows.
  await sql`
    DO $$
    BEGIN
      BEGIN
        ALTER TABLE ai_funded_usage_reservations
          ADD CONSTRAINT ai_funded_reservation_sources_check CHECK (
            (promotional_reserved_microusd IS NULL AND addon_reserved_microusd IS NULL)
            OR (
              promotional_reserved_microusd IS NOT NULL
              AND addon_reserved_microusd IS NOT NULL
              AND promotional_reserved_microusd + addon_reserved_microusd = reserved_microusd
            )
          );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END;
    END $$
  `.execute(db);
  await sql`
    ALTER TABLE ai_funded_usage_reservations
    ADD COLUMN IF NOT EXISTS finalization_mode TEXT
    CHECK (finalization_mode IN ('exact', 'conservative'))
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_ai_funded_reservations_runtime_status
    ON ai_funded_usage_reservations(machine_id, runtime_slot, status, expires_at)
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS ai_funded_credit_ledger (
      entry_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      machine_id TEXT NOT NULL REFERENCES user_machines(machine_id) ON UPDATE CASCADE ON DELETE CASCADE,
      runtime_slot TEXT NOT NULL,
      kind TEXT NOT NULL CONSTRAINT ai_funded_credit_ledger_kind_v3_check
        CHECK (kind IN ('promotional_grant', 'addon_grant', 'promotional_debit', 'addon_debit', 'promotional_expiry', 'usage_shortfall')),
      amount_microusd BIGINT NOT NULL,
      source_reference TEXT NOT NULL,
      reservation_id TEXT REFERENCES ai_funded_usage_reservations(reservation_id) ON UPDATE CASCADE ON DELETE CASCADE,
      period_start TEXT,
      expires_at TEXT,
      created_at TEXT NOT NULL,
      CONSTRAINT ai_funded_credit_ledger_shape_v3_check CHECK (
        (kind IN ('promotional_grant', 'addon_grant') AND amount_microusd > 0 AND reservation_id IS NULL AND period_start IS NULL)
        OR (kind IN ('promotional_debit', 'addon_debit') AND amount_microusd < 0 AND reservation_id IS NOT NULL AND period_start IS NOT NULL)
        OR (kind = 'usage_shortfall' AND amount_microusd < 0 AND reservation_id IS NOT NULL AND period_start IS NOT NULL AND expires_at IS NULL)
        OR (kind = 'promotional_expiry' AND amount_microusd < 0 AND reservation_id IS NULL AND period_start IS NULL AND expires_at IS NULL)
      )
    )
  `.execute(db);
  await sql`ALTER TABLE ai_funded_credit_ledger ADD COLUMN IF NOT EXISTS expires_at TEXT`.execute(db);
  await sql`ALTER TABLE ai_funded_credit_ledger DROP CONSTRAINT IF EXISTS ai_funded_credit_ledger_kind_check`.execute(db);
  await sql`ALTER TABLE ai_funded_credit_ledger DROP CONSTRAINT IF EXISTS ai_funded_credit_ledger_check`.execute(db);
  await sql`ALTER TABLE ai_funded_credit_ledger DROP CONSTRAINT IF EXISTS ai_funded_credit_ledger_kind_v2_check`.execute(db);
  await sql`ALTER TABLE ai_funded_credit_ledger DROP CONSTRAINT IF EXISTS ai_funded_credit_ledger_shape_v2_check`.execute(db);
  await sql`
    DO $$
    BEGIN
      BEGIN
        ALTER TABLE ai_funded_credit_ledger
          ADD CONSTRAINT ai_funded_credit_ledger_kind_v3_check
          CHECK (kind IN ('promotional_grant', 'addon_grant', 'promotional_debit', 'addon_debit', 'promotional_expiry', 'usage_shortfall'));
      EXCEPTION WHEN duplicate_object THEN NULL;
      END;
      BEGIN
        ALTER TABLE ai_funded_credit_ledger
          ADD CONSTRAINT ai_funded_credit_ledger_shape_v3_check CHECK (
            (kind IN ('promotional_grant', 'addon_grant') AND amount_microusd > 0 AND reservation_id IS NULL AND period_start IS NULL)
            OR (kind IN ('promotional_debit', 'addon_debit') AND amount_microusd < 0 AND reservation_id IS NOT NULL AND period_start IS NOT NULL)
            OR (kind = 'usage_shortfall' AND amount_microusd < 0 AND reservation_id IS NOT NULL AND period_start IS NOT NULL AND expires_at IS NULL)
            OR (kind = 'promotional_expiry' AND amount_microusd < 0 AND reservation_id IS NULL AND period_start IS NULL AND expires_at IS NULL)
          );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END;
    END $$
  `.execute(db);
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_funded_ledger_reservation_kind ON ai_funded_credit_ledger(reservation_id, kind) WHERE reservation_id IS NOT NULL`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_ai_funded_ledger_runtime ON ai_funded_credit_ledger(machine_id, runtime_slot, created_at)`.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_ai_funded_ledger_promotional_expiry
    ON ai_funded_credit_ledger(machine_id, runtime_slot, expires_at)
    WHERE kind = 'promotional_grant' AND expires_at IS NOT NULL
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS ai_funded_promotional_grant_balances (
      grant_entry_id TEXT PRIMARY KEY REFERENCES ai_funded_credit_ledger(entry_id) ON UPDATE CASCADE ON DELETE CASCADE,
      owner_id TEXT NOT NULL,
      machine_id TEXT NOT NULL REFERENCES user_machines(machine_id) ON UPDATE CASCADE ON DELETE CASCADE,
      runtime_slot TEXT NOT NULL,
      remaining_microusd BIGINT NOT NULL CHECK (remaining_microusd >= 0),
      expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
    )
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS ai_funded_reservation_promotional_allocations (
      reservation_id TEXT NOT NULL REFERENCES ai_funded_usage_reservations(reservation_id) ON UPDATE CASCADE ON DELETE CASCADE,
      grant_entry_id TEXT NOT NULL REFERENCES ai_funded_promotional_grant_balances(grant_entry_id) ON UPDATE CASCADE ON DELETE RESTRICT,
      amount_microusd BIGINT NOT NULL CHECK (amount_microusd > 0),
      created_at TEXT NOT NULL,
      PRIMARY KEY (reservation_id, grant_entry_id)
    )
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_ai_funded_reservation_promo_grant
    ON ai_funded_reservation_promotional_allocations(grant_entry_id, reservation_id)
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_ai_funded_promotional_grant_expiry
    ON ai_funded_promotional_grant_balances(machine_id, runtime_slot, expires_at, grant_entry_id)
    WHERE remaining_microusd > 0 AND expires_at IS NOT NULL
  `.execute(db);
  await sql`
    WITH promotional_usage AS (
      SELECT owner_id, machine_id, runtime_slot,
        COALESCE(SUM(-amount_microusd), 0)::BIGINT AS used_microusd
      FROM ai_funded_credit_ledger
      WHERE kind = 'promotional_debit'
      GROUP BY owner_id, machine_id, runtime_slot
    ), ordered_grants AS (
      SELECT
        entry_id, owner_id, machine_id, runtime_slot, amount_microusd, expires_at, created_at,
        COALESCE(SUM(amount_microusd) OVER (
          PARTITION BY owner_id, machine_id, runtime_slot
          ORDER BY created_at, entry_id
          ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
        ), 0)::BIGINT AS prior_grants_microusd
      FROM ai_funded_credit_ledger
      WHERE kind = 'promotional_grant'
    )
    INSERT INTO ai_funded_promotional_grant_balances (
      grant_entry_id, owner_id, machine_id, runtime_slot, remaining_microusd,
      expires_at, created_at, updated_at, revision
    )
    SELECT
      promo.entry_id, promo.owner_id, promo.machine_id, promo.runtime_slot,
      promo.amount_microusd - LEAST(
        promo.amount_microusd,
        GREATEST(0, COALESCE(usage.used_microusd, 0) - promo.prior_grants_microusd)
      ),
      promo.expires_at, promo.created_at, promo.created_at, 0
    FROM ordered_grants promo
    LEFT JOIN promotional_usage usage
      ON usage.owner_id = promo.owner_id
      AND usage.machine_id = promo.machine_id
      AND usage.runtime_slot = promo.runtime_slot
    ON CONFLICT (grant_entry_id) DO NOTHING
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS provisioning_jobs (
      job_id TEXT PRIMARY KEY,
      machine_id TEXT NOT NULL UNIQUE REFERENCES user_machines(machine_id) ON UPDATE CASCADE,
      status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL,
      claimed_at TEXT,
      lease_expires_at TEXT,
      encrypted_payload TEXT,
      last_error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      authorization_basis TEXT NOT NULL DEFAULT 'billing_entitlement',
      prebilling_intent_id TEXT
    )
  `.execute(db);
  await sql`ALTER TABLE provisioning_jobs ADD COLUMN IF NOT EXISTS target_bundle_version TEXT`.execute(db);
  await sql`ALTER TABLE provisioning_jobs ADD COLUMN IF NOT EXISTS target_bundle_sha256 TEXT`.execute(db);
  await sql`ALTER TABLE provisioning_jobs ADD COLUMN IF NOT EXISTS image_source TEXT NOT NULL DEFAULT 'unresolved'`.execute(db);
  await sql`ALTER TABLE provisioning_jobs ADD COLUMN IF NOT EXISTS snapshot_id TEXT`.execute(db);
  await sql`ALTER TABLE provisioning_jobs ADD COLUMN IF NOT EXISTS snapshot_lease_id TEXT`.execute(db);
  await sql`ALTER TABLE provisioning_jobs ADD COLUMN IF NOT EXISTS snapshot_create_intent_id TEXT`.execute(db);
  await sql`ALTER TABLE provisioning_jobs ADD COLUMN IF NOT EXISTS activation_step TEXT NOT NULL DEFAULT 'selecting'`.execute(db);
  await sql`ALTER TABLE provisioning_jobs ADD COLUMN IF NOT EXISTS provider_create_action_id BIGINT`.execute(db);
  await sql`ALTER TABLE provisioning_jobs ADD COLUMN IF NOT EXISTS fallback_reason TEXT`.execute(db);
  await sql`ALTER TABLE provisioning_jobs ADD COLUMN IF NOT EXISTS authorization_basis TEXT NOT NULL DEFAULT 'billing_entitlement'`.execute(db);
  await sql`ALTER TABLE provisioning_jobs ADD COLUMN IF NOT EXISTS prebilling_intent_id TEXT`.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_provisioning_jobs_dispatch
    ON provisioning_jobs(status, available_at, lease_expires_at)
  `.execute(db);

  // Onboarding journey (spec 092): server-owned signup-to-ready state. Schema is
  // uniformly TEXT/uuid/ISO-string to match the rest of this file (no jsonb/serial).
  await sql`
    CREATE TABLE IF NOT EXISTS billing_checkout_attempts (
      id TEXT PRIMARY KEY,
      clerk_user_id TEXT NOT NULL,
      stripe_session_id TEXT UNIQUE,
      checkout_url TEXT,
      runtime_slot TEXT NOT NULL DEFAULT 'primary',
      plan_slug TEXT,
      billing_interval TEXT,
      region_slug TEXT,
      server_type TEXT,
      trial_period_days INTEGER,
      developer_tools TEXT NOT NULL DEFAULT '["codex","claude-code","opencode","pi"]',
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL,
      resolved_at TEXT
    )
  `.execute(db);
  await sql`ALTER TABLE billing_checkout_attempts ALTER COLUMN stripe_session_id DROP NOT NULL`.execute(db);
  await sql`ALTER TABLE billing_checkout_attempts ADD COLUMN IF NOT EXISTS checkout_url TEXT`.execute(db);
  await sql`ALTER TABLE billing_checkout_attempts ADD COLUMN IF NOT EXISTS developer_tools TEXT NOT NULL DEFAULT '["codex","claude-code","opencode","pi"]'`.execute(db);
  await sql`ALTER TABLE billing_checkout_attempts ADD COLUMN IF NOT EXISTS runtime_slot TEXT NOT NULL DEFAULT 'primary'`.execute(db);
  await sql`ALTER TABLE billing_checkout_attempts ADD COLUMN IF NOT EXISTS plan_slug TEXT`.execute(db);
  await sql`ALTER TABLE billing_checkout_attempts ADD COLUMN IF NOT EXISTS billing_interval TEXT`.execute(db);
  await sql`ALTER TABLE billing_checkout_attempts ADD COLUMN IF NOT EXISTS region_slug TEXT`.execute(db);
  await sql`ALTER TABLE billing_checkout_attempts ADD COLUMN IF NOT EXISTS server_type TEXT`.execute(db);
  await sql`ALTER TABLE billing_checkout_attempts ADD COLUMN IF NOT EXISTS trial_period_days INTEGER`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_checkout_attempts_clerk_created ON billing_checkout_attempts(clerk_user_id, created_at)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_checkout_attempts_clerk_slot_created ON billing_checkout_attempts(clerk_user_id, runtime_slot, created_at)`.execute(db);
  await sql`
    WITH ranked AS (
      SELECT id, ROW_NUMBER() OVER (
        PARTITION BY clerk_user_id, runtime_slot
        ORDER BY created_at DESC, id DESC
      ) AS row_number
      FROM billing_checkout_attempts
      WHERE status IN ('creating', 'open')
    )
    UPDATE billing_checkout_attempts attempts
    SET status = 'abandoned', resolved_at = COALESCE(attempts.resolved_at, attempts.created_at)
    FROM ranked
    WHERE attempts.id = ranked.id AND ranked.row_number > 1
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_checkout_attempts_active_slot
    ON billing_checkout_attempts(clerk_user_id, runtime_slot)
    WHERE status IN ('creating', 'open')
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS prebilling_provisioning_intents (
      id TEXT PRIMARY KEY,
      checkout_attempt_id TEXT NOT NULL UNIQUE REFERENCES billing_checkout_attempts(id) ON DELETE CASCADE,
      clerk_user_id TEXT NOT NULL,
      runtime_slot TEXT NOT NULL,
      plan_slug TEXT NOT NULL,
      billing_interval TEXT NOT NULL,
      server_type TEXT NOT NULL,
      region_slug TEXT NOT NULL,
      developer_tools TEXT NOT NULL,
      state TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      machine_id TEXT UNIQUE REFERENCES user_machines(machine_id) ON UPDATE CASCADE,
      stripe_session_id TEXT,
      stripe_session_expires_at TEXT,
      lease_expires_at TEXT,
      reserved_hourly_cost_micros BIGINT NOT NULL DEFAULT 0,
      cleanup_claimed_at TEXT,
      cleanup_lease_expires_at TEXT,
      ready_at TEXT,
      payment_confirmed_at TEXT,
      authorized_at TEXT,
      cleaned_at TEXT,
      last_error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `.execute(db);
  await sql`ALTER TABLE prebilling_provisioning_intents ADD COLUMN IF NOT EXISTS payment_confirmed_at TEXT`.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_prebilling_intents_active_owner_slot
    ON prebilling_provisioning_intents(clerk_user_id, runtime_slot)
    WHERE state IN ('awaiting_checkout', 'preparing', 'ready_waiting_for_billing', 'payment_settling', 'preparation_failed', 'preparation_deferred', 'cleanup_pending')
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_prebilling_intents_stripe_session
    ON prebilling_provisioning_intents(stripe_session_id)
    WHERE stripe_session_id IS NOT NULL
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_prebilling_intents_cleanup ON prebilling_provisioning_intents(state, lease_expires_at)`.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS billing_trial_accounts (
      clerk_user_id TEXT PRIMARY KEY,
      trial_checkout_attempt_id TEXT UNIQUE REFERENCES billing_checkout_attempts(id) ON DELETE SET NULL,
      consumed_at TEXT,
      updated_at TEXT NOT NULL
    )
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS onboarding_first_run (
      clerk_user_id TEXT PRIMARY KEY,
      completed_at TEXT NOT NULL,
      goal TEXT,
      steps TEXT NOT NULL DEFAULT '{}',
      source TEXT NOT NULL
    )
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS onboarding_journey_events (
      id TEXT PRIMARY KEY,
      clerk_user_id TEXT NOT NULL,
      from_phase TEXT,
      to_phase TEXT NOT NULL,
      detail TEXT,
      at TEXT NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_journey_events_clerk_at ON onboarding_journey_events(clerk_user_id, at)`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS billing_customers (
      clerk_user_id TEXT PRIMARY KEY,
      stripe_customer_id TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS billing_subscriptions (
      stripe_subscription_id TEXT PRIMARY KEY,
      stripe_customer_id TEXT NOT NULL,
      clerk_user_id TEXT NOT NULL,
      runtime_slot TEXT NOT NULL,
      plan_slug TEXT NOT NULL,
      stripe_price_id TEXT NOT NULL,
      billing_interval TEXT,
      status TEXT NOT NULL,
      current_period_end TEXT,
      grace_period_ends_at TEXT,
      trial_started_at TEXT,
      trial_ends_at TEXT,
      trial_converted_at TEXT,
      first_trial_payment_failed_at TEXT,
      latest_event_created_at TEXT NOT NULL,
      latest_event_id TEXT NOT NULL,
      latest_invoice_event_created_at TEXT,
      latest_invoice_event_id TEXT,
      updated_at TEXT NOT NULL
    )
  `.execute(db);
  await sql`ALTER TABLE billing_subscriptions ALTER COLUMN billing_interval DROP NOT NULL`.execute(db);
  await sql`ALTER TABLE billing_subscriptions ADD COLUMN IF NOT EXISTS trial_started_at TEXT`.execute(db);
  await sql`ALTER TABLE billing_subscriptions ADD COLUMN IF NOT EXISTS trial_ends_at TEXT`.execute(db);
  await sql`ALTER TABLE billing_subscriptions ADD COLUMN IF NOT EXISTS trial_converted_at TEXT`.execute(db);
  await sql`ALTER TABLE billing_subscriptions ADD COLUMN IF NOT EXISTS first_trial_payment_failed_at TEXT`.execute(db);
  await sql`ALTER TABLE billing_subscriptions ADD COLUMN IF NOT EXISTS latest_invoice_event_created_at TEXT`.execute(db);
  await sql`ALTER TABLE billing_subscriptions ADD COLUMN IF NOT EXISTS latest_invoice_event_id TEXT`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_billing_subscriptions_user_slot ON billing_subscriptions(clerk_user_id, runtime_slot, latest_event_created_at DESC)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_billing_subscriptions_customer ON billing_subscriptions(stripe_customer_id)`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS billing_entitlements (
      clerk_user_id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      plan_slug TEXT NOT NULL,
      status TEXT NOT NULL,
      max_runtime_slots INTEGER NOT NULL,
      included_runtime_slots INTEGER NOT NULL,
      addon_runtime_slots INTEGER NOT NULL,
      default_server_type TEXT NOT NULL,
      allowed_server_types TEXT NOT NULL,
      stripe_subscription_id TEXT,
      stripe_price_id TEXT,
      billing_interval TEXT,
      grace_period_ends_at TEXT,
      effective_from TEXT NOT NULL,
      effective_until TEXT,
      updated_at TEXT NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_billing_entitlements_status ON billing_entitlements(status)`.execute(db);
  await sql`ALTER TABLE billing_entitlements ADD COLUMN IF NOT EXISTS billing_interval TEXT`.execute(db);
  await sql`ALTER TABLE billing_entitlements ADD COLUMN IF NOT EXISTS trial_started_at TEXT`.execute(db);
  await sql`ALTER TABLE billing_entitlements ADD COLUMN IF NOT EXISTS trial_ends_at TEXT`.execute(db);
  await sql`ALTER TABLE billing_entitlements ADD COLUMN IF NOT EXISTS trial_converted_at TEXT`.execute(db);
  await sql`ALTER TABLE billing_entitlements ADD COLUMN IF NOT EXISTS first_trial_payment_failed_at TEXT`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_billing_entitlements_subscription ON billing_entitlements(stripe_subscription_id)`.execute(db);

  // Existing production subscriptions predate runtime-slot metadata. Current
  // fleet evidence guarantees all billable machines are primary; this
  // idempotent backfill keeps them authorized before their next Stripe event.
  await sql`
    INSERT INTO billing_subscriptions (
      stripe_subscription_id,
      stripe_customer_id,
      clerk_user_id,
      runtime_slot,
      plan_slug,
      stripe_price_id,
      billing_interval,
      status,
      current_period_end,
      grace_period_ends_at,
      latest_event_created_at,
      latest_event_id,
      updated_at
    )
    SELECT
      e.stripe_subscription_id,
      c.stripe_customer_id,
      e.clerk_user_id,
      'primary',
      e.plan_slug,
      e.stripe_price_id,
      NULL,
      e.status,
      NULL,
      e.grace_period_ends_at,
      e.updated_at,
      'legacy_backfill',
      e.updated_at
    FROM billing_entitlements e
    JOIN billing_customers c ON c.clerk_user_id = e.clerk_user_id
    WHERE e.source = 'stripe'
      AND e.stripe_subscription_id IS NOT NULL
      AND e.stripe_price_id IS NOT NULL
    ON CONFLICT (stripe_subscription_id) DO NOTHING
  `.execute(db);
  await sql`
    UPDATE billing_entitlements entitlements
    SET max_runtime_slots = 1,
        included_runtime_slots = 1,
        addon_runtime_slots = 0
    WHERE entitlements.source = 'stripe'
      AND EXISTS (
        SELECT 1
        FROM billing_subscriptions subscriptions
        WHERE subscriptions.clerk_user_id = entitlements.clerk_user_id
          AND subscriptions.latest_event_id = 'legacy_backfill'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM billing_subscriptions subscriptions
        WHERE subscriptions.clerk_user_id = entitlements.clerk_user_id
          AND subscriptions.latest_event_id <> 'legacy_backfill'
      )
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS billing_entitlement_overrides (
      id TEXT PRIMARY KEY,
      clerk_user_id TEXT NOT NULL,
      plan_slug TEXT NOT NULL,
      status TEXT NOT NULL,
      max_runtime_slots INTEGER NOT NULL,
      included_runtime_slots INTEGER NOT NULL,
      addon_runtime_slots INTEGER NOT NULL,
      default_server_type TEXT NOT NULL,
      allowed_server_types TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_by TEXT NOT NULL,
      expires_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_billing_overrides_user ON billing_entitlement_overrides(clerk_user_id, revoked_at, expires_at)`.execute(db);

  const unsupportedExistingComputers = await sql<{ count: string }>`
    SELECT COUNT(*)::TEXT AS count
    FROM user_machines m
    WHERE m.deleted_at IS NULL
      AND m.provisioning_class = 'customer'
      AND m.runtime_slot <> 'primary'
      AND m.provisioned_at <= '2026-07-21T16:28:00.000Z'
      AND NOT EXISTS (
        SELECT 1
        FROM billing_subscriptions s
        WHERE s.clerk_user_id = m.clerk_user_id
          AND s.runtime_slot = m.runtime_slot
      )
      AND NOT EXISTS (
        SELECT 1
        FROM billing_entitlement_overrides o
        WHERE o.clerk_user_id = m.clerk_user_id
          AND o.revoked_at IS NULL
          AND (o.expires_at IS NULL OR o.expires_at::TIMESTAMPTZ > NOW())
      )
  `.execute(db);
  if (Number(unsupportedExistingComputers.rows[0]?.count ?? '0') > 0) {
    throw new Error('billing subscription migration blocked by existing unassigned customer computers');
  }

  await sql`
    CREATE TABLE IF NOT EXISTS billing_webhook_events (
      stripe_event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      created_at_from_stripe TEXT NOT NULL,
      processed_at TEXT NOT NULL,
      status TEXT NOT NULL,
      error_code TEXT
    )
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS billing_runtime_actions (
      id TEXT PRIMARY KEY,
      machine_id TEXT NOT NULL REFERENCES user_machines(machine_id) ON UPDATE CASCADE,
      stripe_subscription_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('suspend', 'resume')),
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      execute_after TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      claimed_at TEXT,
      lease_expires_at TEXT,
      cancel_requested_at TEXT,
      last_error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    )
  `.execute(db);
  await sql`ALTER TABLE billing_runtime_actions ADD COLUMN IF NOT EXISTS cancel_requested_at TEXT`.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_runtime_actions_active
    ON billing_runtime_actions(machine_id, action)
    WHERE status IN ('queued', 'running')
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_billing_runtime_actions_dispatch
    ON billing_runtime_actions(status, execute_after, lease_expires_at)
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS host_bundle_releases (
      version TEXT PRIMARY KEY,
      channel TEXT,
      git_commit TEXT NOT NULL,
      git_ref TEXT,
      snapshot_eligible BOOLEAN NOT NULL DEFAULT FALSE,
      snapshot_eligibility_source TEXT NOT NULL DEFAULT 'legacy'
        CHECK (snapshot_eligibility_source IN ('legacy', 'explicit')),
      build_time TEXT NOT NULL,
      bundle_key TEXT NOT NULL,
      checksum_key TEXT,
      incremental_manifest_key TEXT,
      incremental_manifest_sha256 TEXT,
      sha256 TEXT NOT NULL,
      size BIGINT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'normal',
      update_type TEXT NOT NULL DEFAULT 'manual',
      changelog TEXT,
      created_at TEXT NOT NULL
    )
  `.execute(db);
  await sql`ALTER TABLE host_bundle_releases ADD COLUMN IF NOT EXISTS channel TEXT`.execute(db);
  await sql`ALTER TABLE host_bundle_releases ADD COLUMN IF NOT EXISTS snapshot_eligible BOOLEAN NOT NULL DEFAULT FALSE`.execute(db);
  await sql`ALTER TABLE host_bundle_releases ADD COLUMN IF NOT EXISTS snapshot_eligibility_source TEXT NOT NULL DEFAULT 'legacy'`.execute(db);
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'host_bundle_releases'::regclass
          AND conname = 'host_bundle_releases_snapshot_eligibility_source_check'
      ) THEN
        ALTER TABLE host_bundle_releases
          ADD CONSTRAINT host_bundle_releases_snapshot_eligibility_source_check
          CHECK (snapshot_eligibility_source IN ('legacy', 'explicit'));
      END IF;
    END $$
  `.execute(db);
  await sql`ALTER TABLE host_bundle_releases ADD COLUMN IF NOT EXISTS incremental_manifest_key TEXT`.execute(db);
  await sql`ALTER TABLE host_bundle_releases ADD COLUMN IF NOT EXISTS incremental_manifest_sha256 TEXT`.execute(db);
  await sql`ALTER TABLE host_bundle_releases ALTER COLUMN size TYPE BIGINT`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_host_bundle_releases_channel ON host_bundle_releases(channel)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_host_bundle_releases_created_at ON host_bundle_releases(created_at)`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS host_bundle_channels (
      channel TEXT PRIMARY KEY,
      version TEXT NOT NULL REFERENCES host_bundle_releases(version),
      updated_at TEXT NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_host_bundle_channels_version ON host_bundle_channels(version)`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS host_bundle_release_channels (
      channel TEXT NOT NULL,
      version TEXT NOT NULL REFERENCES host_bundle_releases(version),
      promoted_at TEXT NOT NULL,
      PRIMARY KEY (channel, version)
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_host_bundle_release_channels_version ON host_bundle_release_channels(version)`.execute(db);
  await sql`
    INSERT INTO host_bundle_release_channels(channel, version, promoted_at)
    SELECT channel, version, created_at
    FROM host_bundle_releases
    WHERE channel IS NOT NULL
    ON CONFLICT (channel, version) DO NOTHING
  `.execute(db);
  await sql`
    UPDATE host_bundle_releases AS release
    SET snapshot_eligible = TRUE
    WHERE release.snapshot_eligible = FALSE
      AND release.snapshot_eligibility_source = 'legacy'
      AND EXISTS (
        SELECT 1 FROM host_bundle_channels AS channel
        WHERE channel.version = release.version
          AND channel.channel IN ('dev', 'canary', 'beta', 'stable')
      )
  `.execute(db);
  await sql`
    INSERT INTO host_bundle_release_channels(channel, version, promoted_at)
    SELECT channel, version, updated_at
    FROM host_bundle_channels
    ON CONFLICT (channel, version) DO UPDATE SET promoted_at = EXCLUDED.promoted_at
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS golden_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      bundle_version TEXT NOT NULL REFERENCES host_bundle_releases(version),
      bundle_sha256 TEXT NOT NULL CHECK (bundle_sha256 ~ '^[a-f0-9]{64}$'),
      source_git_commit TEXT NOT NULL,
      compatibility_key TEXT NOT NULL CHECK (compatibility_key ~ '^[a-f0-9]{64}$'),
      provider TEXT NOT NULL,
      architecture TEXT NOT NULL,
      region TEXT NOT NULL,
      base_image TEXT NOT NULL,
      base_generation TEXT NOT NULL,
      boot_mode TEXT NOT NULL,
      activation_abi TEXT NOT NULL,
      minimum_disk_gb INTEGER NOT NULL CHECK (minimum_disk_gb > 0),
      test_mode BOOLEAN NOT NULL DEFAULT FALSE,
      image_generation INTEGER NOT NULL DEFAULT 1 CHECK (image_generation > 0),
      state TEXT NOT NULL CHECK (state IN ('candidate', 'building', 'sanitizing', 'validating', 'ready', 'failed', 'quarantined', 'retiring', 'deleted')),
      provider_image_id BIGINT,
      provider_image_status TEXT,
      image_disk_gb INTEGER CHECK (image_disk_gb IS NULL OR image_disk_gb > 0),
      image_architecture TEXT,
      validation_summary JSONB,
      failure_code TEXT,
      ready_at TEXT,
      quarantined_at TEXT,
      retiring_at TEXT,
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
      UNIQUE (bundle_sha256, compatibility_key, test_mode, image_generation),
      UNIQUE (provider_image_id)
    )
  `.execute(db);
  await sql`ALTER TABLE golden_snapshots ADD COLUMN IF NOT EXISTS test_mode BOOLEAN NOT NULL DEFAULT FALSE`.execute(db);
  await sql`ALTER TABLE golden_snapshots ADD COLUMN IF NOT EXISTS image_generation INTEGER NOT NULL DEFAULT 1 CHECK (image_generation > 0)`.execute(db);
  await sql`ALTER TABLE golden_snapshots DROP CONSTRAINT IF EXISTS golden_snapshots_bundle_sha256_compatibility_key_key`.execute(db);
  await sql`ALTER TABLE golden_snapshots DROP CONSTRAINT IF EXISTS golden_snapshots_bundle_sha256_compatibility_key_test_mode_key`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_golden_snapshots_identity`.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_golden_snapshots_identity
    ON golden_snapshots(bundle_sha256, compatibility_key, test_mode, image_generation)
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_golden_snapshots_selectable
    ON golden_snapshots(compatibility_key, ready_at DESC)
    WHERE state = 'ready'
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_golden_snapshots_bundle
    ON golden_snapshots(bundle_version, compatibility_key)
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS golden_snapshot_revoked_base_generations (
      base_generation TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      revoked_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS golden_snapshot_builds (
      build_id TEXT PRIMARY KEY,
      snapshot_id TEXT NOT NULL UNIQUE REFERENCES golden_snapshots(snapshot_id) ON DELETE CASCADE,
      phase TEXT NOT NULL CHECK (phase IN ('requested', 'builder_create', 'builder_boot', 'sanitizing', 'snapshot_create', 'snapshot_wait', 'validation_create', 'validation_boot', 'cleanup', 'completed', 'failed', 'reconciling')),
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      available_at TEXT NOT NULL,
      claimed_at TEXT,
      lease_expires_at TEXT,
      callback_phase TEXT,
      callback_token_hash TEXT,
      callback_expires_at TEXT,
      callback_event_id TEXT,
      callback_payload_sha256 TEXT CHECK (callback_payload_sha256 IS NULL OR callback_payload_sha256 ~ '^[a-f0-9]{64}$'),
      callback_outcome JSONB,
      builder_machine_id_sha256 TEXT CHECK (builder_machine_id_sha256 IS NULL OR builder_machine_id_sha256 ~ '^[a-f0-9]{64}$'),
      builder_ssh_host_key_sha256 TEXT CHECK (builder_ssh_host_key_sha256 IS NULL OR builder_ssh_host_key_sha256 ~ '^[a-f0-9]{64}$'),
      validation_clone_ordinal INTEGER NOT NULL DEFAULT 1 CHECK (validation_clone_ordinal IN (1, 2)),
      first_validation_machine_id_sha256 TEXT CHECK (first_validation_machine_id_sha256 IS NULL OR first_validation_machine_id_sha256 ~ '^[a-f0-9]{64}$'),
      first_validation_ssh_host_key_sha256 TEXT CHECK (first_validation_ssh_host_key_sha256 IS NULL OR first_validation_ssh_host_key_sha256 ~ '^[a-f0-9]{64}$'),
      provider_builder_id BIGINT,
      provider_builder_action_id BIGINT,
      provider_snapshot_action_id BIGINT,
      provider_validation_id BIGINT,
      provider_validation_action_id BIGINT,
      pending_operation TEXT,
      last_error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    )
  `.execute(db);
  await sql`
    ALTER TABLE golden_snapshot_builds
    ADD COLUMN IF NOT EXISTS builder_machine_id_sha256 TEXT
  `.execute(db);
  await sql`
    ALTER TABLE golden_snapshot_builds
    ADD COLUMN IF NOT EXISTS builder_ssh_host_key_sha256 TEXT
  `.execute(db);
  await sql`
    ALTER TABLE golden_snapshot_builds
    ADD COLUMN IF NOT EXISTS provider_builder_action_id BIGINT
  `.execute(db);
  await sql`
    ALTER TABLE golden_snapshot_builds
    ADD COLUMN IF NOT EXISTS callback_event_id TEXT
  `.execute(db);
  await sql`
    ALTER TABLE golden_snapshot_builds
    ADD COLUMN IF NOT EXISTS callback_payload_sha256 TEXT
  `.execute(db);
  await sql`
    ALTER TABLE golden_snapshot_builds
    ADD COLUMN IF NOT EXISTS callback_outcome JSONB
  `.execute(db);
  await sql`
    ALTER TABLE golden_snapshot_builds
    ADD COLUMN IF NOT EXISTS validation_clone_ordinal INTEGER NOT NULL DEFAULT 1
    CHECK (validation_clone_ordinal IN (1, 2))
  `.execute(db);
  await sql`
    ALTER TABLE golden_snapshot_builds
    ADD COLUMN IF NOT EXISTS first_validation_machine_id_sha256 TEXT
  `.execute(db);
  await sql`
    ALTER TABLE golden_snapshot_builds
    ADD COLUMN IF NOT EXISTS first_validation_ssh_host_key_sha256 TEXT
  `.execute(db);
  await sql`
    ALTER TABLE golden_snapshot_builds
    DROP CONSTRAINT IF EXISTS golden_snapshot_builds_first_validation_machine_id_sha256_check
  `.execute(db);
  await sql`
    ALTER TABLE golden_snapshot_builds
    ADD CONSTRAINT golden_snapshot_builds_first_validation_machine_id_sha256_check
    CHECK (first_validation_machine_id_sha256 IS NULL OR first_validation_machine_id_sha256 ~ '^[a-f0-9]{64}$')
  `.execute(db);
  await sql`
    ALTER TABLE golden_snapshot_builds
    DROP CONSTRAINT IF EXISTS golden_snapshot_builds_first_validation_ssh_host_key_sha256_check
  `.execute(db);
  await sql`
    ALTER TABLE golden_snapshot_builds
    ADD CONSTRAINT golden_snapshot_builds_first_validation_ssh_host_key_sha256_check
    CHECK (first_validation_ssh_host_key_sha256 IS NULL OR first_validation_ssh_host_key_sha256 ~ '^[a-f0-9]{64}$')
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_golden_snapshot_builds_dispatch
    ON golden_snapshot_builds(status, available_at, lease_expires_at)
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS golden_snapshot_callback_receipts (
      build_id TEXT NOT NULL REFERENCES golden_snapshot_builds(build_id) ON DELETE CASCADE,
      event_id TEXT NOT NULL,
      callback_phase TEXT NOT NULL CHECK (length(callback_phase) BETWEEN 1 AND 64),
      token_sha256 TEXT CHECK (token_sha256 ~ '^[a-f0-9]{64}$'),
      payload_sha256 TEXT NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
      outcome JSONB NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (build_id, event_id)
    )
  `.execute(db);
  await sql`
    ALTER TABLE golden_snapshot_callback_receipts
    ADD COLUMN IF NOT EXISTS token_sha256 TEXT
      CHECK (token_sha256 ~ '^[a-f0-9]{64}$')
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_golden_snapshot_callback_receipts_expiry
    ON golden_snapshot_callback_receipts(expires_at, build_id, event_id)
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS golden_snapshot_leases (
      lease_id TEXT PRIMARY KEY,
      snapshot_id TEXT NOT NULL REFERENCES golden_snapshots(snapshot_id),
      machine_id TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK (purpose IN ('provision', 'recover')),
      target_bundle_version TEXT NOT NULL REFERENCES host_bundle_releases(version),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      released_at TEXT
    )
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_golden_snapshot_leases_machine_active
    ON golden_snapshot_leases(machine_id)
    WHERE released_at IS NULL
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_golden_snapshot_leases_protection
    ON golden_snapshot_leases(snapshot_id, expires_at)
    WHERE released_at IS NULL
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS golden_snapshot_rollout_controls (
      compatibility_key TEXT PRIMARY KEY CHECK (compatibility_key ~ '^[a-f0-9]{64}$'),
      enabled BOOLEAN NOT NULL DEFAULT false,
      percentage INTEGER NOT NULL DEFAULT 0 CHECK (percentage BETWEEN 0 AND 100),
      generation BIGINT NOT NULL DEFAULT 1 CHECK (generation > 0),
      updated_at TEXT NOT NULL
    )
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS golden_snapshot_create_intents (
      intent_id TEXT PRIMARY KEY,
      snapshot_id TEXT NOT NULL REFERENCES golden_snapshots(snapshot_id),
      lease_id TEXT NOT NULL REFERENCES golden_snapshot_leases(lease_id),
      machine_id TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK (purpose IN ('provision', 'recover')),
      rollout_generation BIGINT NOT NULL CHECK (rollout_generation >= 0),
      state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'denied', 'activated', 'cleaned')),
      provider_create_action_id BIGINT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE (lease_id)
    )
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_golden_snapshot_create_intents_open
    ON golden_snapshot_create_intents(snapshot_id, state)
    WHERE completed_at IS NULL
  `.execute(db);
  await sql`
    ALTER TABLE provisioning_jobs
    DROP CONSTRAINT IF EXISTS provisioning_jobs_snapshot_create_intent_id_fkey
  `.execute(db);
  await sql`
    ALTER TABLE provisioning_jobs
    ADD CONSTRAINT provisioning_jobs_snapshot_create_intent_id_fkey
    FOREIGN KEY (snapshot_create_intent_id)
    REFERENCES golden_snapshot_create_intents(intent_id)
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_provisioning_jobs_snapshot_create_intent
    ON provisioning_jobs(snapshot_create_intent_id)
    WHERE snapshot_create_intent_id IS NOT NULL
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS golden_snapshot_cleanup (
      cleanup_id TEXT PRIMARY KEY,
      snapshot_id TEXT REFERENCES golden_snapshots(snapshot_id),
      build_id TEXT REFERENCES golden_snapshot_builds(build_id),
      resource_type TEXT NOT NULL CHECK (resource_type IN ('builder_server', 'validation_server', 'snapshot_image')),
      provider_resource_id BIGINT NOT NULL CHECK (provider_resource_id > 0),
      provenance_key TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'quarantined')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      next_attempt_at TEXT NOT NULL,
      lease_expires_at TEXT,
      last_error_code TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    )
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS golden_snapshot_audit_events (
      event_id TEXT PRIMARY KEY,
      snapshot_id TEXT REFERENCES golden_snapshots(snapshot_id) ON DELETE SET NULL,
      build_id TEXT REFERENCES golden_snapshot_builds(build_id) ON DELETE SET NULL,
      cleanup_id TEXT REFERENCES golden_snapshot_cleanup(cleanup_id) ON DELETE SET NULL,
      event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 64),
      actor_type TEXT NOT NULL CHECK (actor_type IN ('release', 'worker', 'operator')),
      actor_id_hash TEXT CHECK (actor_id_hash IS NULL OR actor_id_hash ~ '^[a-f0-9]{64}$'),
      from_state TEXT,
      to_state TEXT,
      reason TEXT,
      created_at TEXT NOT NULL
    )
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_golden_snapshot_audit_events_retention
    ON golden_snapshot_audit_events(created_at, event_id)
  `.execute(db);
  await sql`
    DO $$
    DECLARE
      current_definition TEXT;
    BEGIN
      SELECT pg_get_constraintdef(oid) INTO current_definition
      FROM pg_constraint
      WHERE conrelid = 'golden_snapshot_cleanup'::regclass
        AND conname = 'golden_snapshot_cleanup_status_check';
      IF current_definition IS NULL OR current_definition NOT LIKE '%quarantined%' THEN
        ALTER TABLE golden_snapshot_cleanup
          DROP CONSTRAINT IF EXISTS golden_snapshot_cleanup_status_check;
        ALTER TABLE golden_snapshot_cleanup
          ADD CONSTRAINT golden_snapshot_cleanup_status_check
          CHECK (status IN ('queued', 'running', 'completed', 'failed', 'quarantined'));
      END IF;
    END $$
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_golden_snapshot_cleanup_resource_active
    ON golden_snapshot_cleanup(resource_type, provider_resource_id)
    WHERE completed_at IS NULL
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_golden_snapshot_cleanup_dispatch
    ON golden_snapshot_cleanup(status, next_attempt_at, lease_expires_at)
    WHERE completed_at IS NULL
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS provider_deletion_queue (
      id TEXT PRIMARY KEY,
      provider_server_id INTEGER NOT NULL,
      reason TEXT NOT NULL,
      machine_id TEXT,
      handle TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_error TEXT,
      completed_at TEXT
    )
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_provider_deletion_queue_pending
    ON provider_deletion_queue(next_attempt_at)
    WHERE completed_at IS NULL
  `.execute(db);
  await sql`
    WITH ranked AS (
      SELECT id, ROW_NUMBER() OVER (
        PARTITION BY provider_server_id ORDER BY created_at, id
      ) AS ordinal
      FROM provider_deletion_queue
      WHERE completed_at IS NULL
    )
    UPDATE provider_deletion_queue
    SET completed_at = created_at,
        last_error = COALESCE(last_error, 'deduplicated provider deletion')
    WHERE id IN (SELECT id FROM ranked WHERE ordinal > 1)
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_deletion_queue_server_active
    ON provider_deletion_queue(provider_server_id)
    WHERE completed_at IS NULL
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS port_assignments (
      port INTEGER PRIMARY KEY,
      handle TEXT UNIQUE
    )
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS device_codes (
      device_code TEXT PRIMARY KEY,
      user_code TEXT NOT NULL UNIQUE,
      clerk_user_id TEXT,
      runtime_slot TEXT,
      runtime_handle TEXT,
      expires_at BIGINT NOT NULL,
      last_polled_at BIGINT,
      created_at BIGINT NOT NULL
    )
  `.execute(db);
  await sql`ALTER TABLE device_codes ADD COLUMN IF NOT EXISTS runtime_slot TEXT`.execute(db);
  await sql`ALTER TABLE device_codes ADD COLUMN IF NOT EXISTS runtime_handle TEXT`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_device_codes_user_code ON device_codes(user_code)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_device_codes_expires_at ON device_codes(expires_at)`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS matrix_users (
      handle TEXT PRIMARY KEY,
      human_matrix_id TEXT NOT NULL,
      ai_matrix_id TEXT NOT NULL,
      human_access_token TEXT NOT NULL,
      ai_access_token TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_matrix_human_id ON matrix_users(human_matrix_id)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_matrix_ai_id ON matrix_users(ai_matrix_id)`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS apps_registry (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      author_id TEXT NOT NULL,
      description TEXT,
      category TEXT DEFAULT 'utility',
      tags TEXT,
      version TEXT DEFAULT '1.0.0',
      source_url TEXT,
      manifest TEXT,
      screenshots TEXT,
      installs INTEGER NOT NULL DEFAULT 0,
      rating INTEGER NOT NULL DEFAULT 0,
      ratings_count INTEGER NOT NULL DEFAULT 0,
      forks_count INTEGER NOT NULL DEFAULT 0,
      is_public BOOLEAN NOT NULL DEFAULT false,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(author_id, slug)
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_apps_category ON apps_registry(category)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_apps_public ON apps_registry(is_public)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_apps_installs ON apps_registry(installs)`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS app_ratings (
      app_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      rating INTEGER NOT NULL,
      review TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(app_id, user_id)
    )
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS app_installs (
      app_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      installed_at TEXT NOT NULL,
      UNIQUE(app_id, user_id)
    )
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS social_posts (
      id TEXT PRIMARY KEY,
      author_id TEXT NOT NULL,
      content TEXT NOT NULL,
      type TEXT NOT NULL,
      media_urls TEXT,
      app_ref TEXT,
      likes_count INTEGER NOT NULL DEFAULT 0,
      comments_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_posts_author ON social_posts(author_id)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_posts_type ON social_posts(type)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_posts_created ON social_posts(created_at)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_posts_likes ON social_posts(likes_count)`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS social_comments (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_comments_post ON social_comments(post_id)`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS social_likes (
      post_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(post_id, user_id)
    )
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS social_follows (
      follower_id TEXT NOT NULL,
      following_id TEXT NOT NULL,
      following_type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(follower_id, following_id)
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_follows_follower ON social_follows(follower_id)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_follows_following ON social_follows(following_id)`.execute(db);
}

export function createPlatformDb(opts: string | { dialect: unknown } = DEFAULT_PLATFORM_DB_URL ?? ''): PlatformDB {
  if (typeof opts === 'string' && !opts) {
    throw new Error('Platform Postgres URL is required: set PLATFORM_DATABASE_URL or POSTGRES_URL');
  }

  let pool: pg.Pool | null = null;
  const kysely = typeof opts === 'string'
    ? (() => {
        pool = new pg.Pool({ connectionString: opts, max: 10 });
        pool.on('error', (err) => {
          console.error('[platform-db] Idle pool client error:', err.message);
        });
        return new Kysely<PlatformDatabase>({ dialect: new PostgresDialect({ pool }) });
      })()
    : new Kysely<PlatformDatabase>({ dialect: opts.dialect as never });

  const ready = migrate(kysely);
  return wrapDb(kysely, kysely, ready, async () => {
    await kysely.destroy();
    try {
      await pool?.end();
    } catch (err: unknown) {
      if (!(err instanceof Error && err.message === 'Called end on pool more than once')) {
        throw err;
      }
    }
  });
}

let singleton: PlatformDB | undefined;

export function getDb(dbUrl?: string): PlatformDB {
  if (!singleton) {
    singleton = createPlatformDb(dbUrl ?? DEFAULT_PLATFORM_DB_URL);
  }
  return singleton;
}

export async function resetDb(): Promise<void> {
  if (singleton) {
    await singleton.destroy();
    singleton = undefined;
  }
}

export async function runInPlatformTransaction<T>(
  db: PlatformDB,
  fn: (trx: PlatformDB) => Promise<T>,
): Promise<T> {
  return db.transaction(fn);
}

export async function runBillingWebhookTransaction<T>(
  db: PlatformDB,
  fn: (trx: PlatformDB) => Promise<T>,
): Promise<T> {
  return db.transaction(fn);
}

export async function lockUserMachineProvisioning(
  db: PlatformDB,
  clerkUserId: string,
): Promise<void> {
  await db.ready;
  await sql`
    SELECT pg_advisory_xact_lock(
      ('x' || substr(md5(${`user_machines:${clerkUserId}`}), 1, 16))::bit(64)::bigint
    )
  `.execute(db.executor);
}

function mapContainer(row: ContainersTable): ContainerRecord {
  return {
    handle: row.handle,
    clerkUserId: row.clerk_user_id,
    containerId: row.container_id,
    port: row.port,
    shellPort: row.shell_port,
    status: row.status,
    createdAt: row.created_at,
    lastActive: row.last_active,
  };
}

function toContainerRow(record: NewContainer): ContainersTable {
  const now = new Date().toISOString();
  return {
    handle: record.handle,
    clerk_user_id: record.clerkUserId,
    container_id: record.containerId,
    port: record.port,
    shell_port: record.shellPort,
    status: record.status,
    created_at: record.createdAt ?? now,
    last_active: record.lastActive ?? now,
  };
}

function mapPlatformUser(row: UsersTable): PlatformUserRecord {
  return {
    id: row.id,
    clerkId: row.clerk_id,
    handle: row.handle,
    displayName: row.display_name,
    email: row.email,
    containerId: row.container_id,
    containerVersion: row.container_version,
    plan: row.plan,
    status: row.status,
    pipedreamExternalId: row.pipedream_external_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPlatformUserRow(record: NewPlatformUser): InsertObject<PlatformDatabase, 'users'> {
  return {
    id: randomUUID(),
    clerk_id: record.clerkId,
    handle: record.handle,
    display_name: record.displayName,
    email: record.email,
    container_id: record.containerId,
    container_version: record.containerVersion ?? null,
    plan: record.plan ?? 'free',
    status: record.status ?? 'active',
    pipedream_external_id: record.pipedreamExternalId ?? null,
    created_at: sql`now()`,
    updated_at: sql`now()`,
  };
}

function mapUserMachine(row: Selectable<UserMachinesTable>): UserMachineRecord {
  return {
    machineId: row.machine_id,
    clerkUserId: row.clerk_user_id,
    handle: row.handle,
    runtimeSlot: row.runtime_slot,
    provisioningClass: UserMachineProvisioningClassSchema.parse(row.provisioning_class),
    accessClerkUserIds: row.access_clerk_user_ids,
    developerTools: parseDeveloperToolsJson(row.developer_tools),
    hetznerServerId: row.hetzner_server_id,
    publicIPv4: row.public_ipv4,
    publicIPv6: row.public_ipv6,
    status: row.status,
    imageVersion: row.image_version,
    sourceSnapshotId: row.source_snapshot_id,
    sourceBaseGeneration: row.source_base_generation,
    targetBundleVersion: row.target_bundle_version,
    targetBundleSha256: row.target_bundle_sha256,
    recoveryCreateActionId: parseNullableProviderActionId(
      row.recovery_create_action_id as number | string | null,
    ),
    recoveryEncryptedPayload: row.recovery_encrypted_payload,
    recoveryOldServerId: row.recovery_old_server_id,
    recoveryOldPublicIPv4: row.recovery_old_public_ipv4,
    serverType: row.server_type,
    location: row.location,
    registrationTokenHash: row.registration_token_hash,
    registrationTokenExpiresAt: row.registration_token_expires_at,
    provisionedAt: row.provisioned_at,
    lastSeenAt: row.last_seen_at,
    deletedAt: row.deleted_at,
    failureCode: row.failure_code,
    failureAt: row.failure_at,
    resizeStartedAt: row.resize_started_at,
    resizeTargetServerType: row.resize_target_server_type,
    attempt: row.attempt,
    activationState: z.enum(['awaiting_billing', 'authorized']).parse(row.activation_state ?? 'authorized'),
    prebillingIntentId: row.prebilling_intent_id,
    activationAuthorizedAt: row.activation_authorized_at,
  };
}

function toUserMachineRow(record: NewUserMachine): Insertable<UserMachinesTable> {
  return {
    machine_id: record.machineId,
    clerk_user_id: record.clerkUserId,
    handle: record.handle,
    runtime_slot: record.runtimeSlot ?? 'primary',
    provisioning_class: record.provisioningClass ?? 'customer',
    access_clerk_user_ids: record.accessClerkUserIds ?? [],
    developer_tools: serializeDeveloperTools(record.developerTools ?? DEFAULT_DEVELOPER_TOOLS),
    hetzner_server_id: record.hetznerServerId ?? null,
    public_ipv4: record.publicIPv4 ?? null,
    public_ipv6: record.publicIPv6 ?? null,
    status: record.status,
    image_version: record.imageVersion ?? null,
    source_snapshot_id: record.sourceSnapshotId ?? null,
    source_base_generation: record.sourceBaseGeneration ?? null,
    target_bundle_version: record.targetBundleVersion ?? null,
    target_bundle_sha256: record.targetBundleSha256 ?? null,
    recovery_create_action_id: record.recoveryCreateActionId ?? null,
    recovery_encrypted_payload: record.recoveryEncryptedPayload ?? null,
    recovery_old_server_id: record.recoveryOldServerId ?? null,
    recovery_old_public_ipv4: record.recoveryOldPublicIPv4 ?? null,
    server_type: record.serverType ?? null,
    location: record.location ?? null,
    registration_token_hash: record.registrationTokenHash ?? null,
    registration_token_expires_at: record.registrationTokenExpiresAt ?? null,
    provisioned_at: record.provisionedAt,
    last_seen_at: record.lastSeenAt ?? null,
    deleted_at: record.deletedAt ?? null,
    failure_code: record.failureCode ?? null,
    failure_at: record.failureAt ?? null,
    resize_started_at: record.resizeStartedAt ?? null,
    resize_target_server_type: record.resizeTargetServerType ?? null,
    attempt: record.attempt ?? 1,
    activation_state: record.activationState ?? 'authorized',
    prebilling_intent_id: record.prebillingIntentId ?? null,
    activation_authorized_at: record.activationAuthorizedAt ?? null,
  };
}

function toUserMachineUpdate(values: Partial<NewUserMachine>): Updateable<UserMachinesTable> {
  const update: Updateable<UserMachinesTable> = {};
  if (values.machineId !== undefined) update.machine_id = values.machineId;
  if (values.clerkUserId !== undefined) update.clerk_user_id = values.clerkUserId;
  if (values.handle !== undefined) update.handle = values.handle;
  if (values.runtimeSlot !== undefined) update.runtime_slot = values.runtimeSlot;
  if (values.provisioningClass !== undefined) update.provisioning_class = values.provisioningClass;
  if (values.accessClerkUserIds !== undefined) update.access_clerk_user_ids = values.accessClerkUserIds;
  if (values.developerTools !== undefined) update.developer_tools = serializeDeveloperTools(values.developerTools);
  if (values.hetznerServerId !== undefined) update.hetzner_server_id = values.hetznerServerId;
  if (values.publicIPv4 !== undefined) update.public_ipv4 = values.publicIPv4;
  if (values.publicIPv6 !== undefined) update.public_ipv6 = values.publicIPv6;
  if (values.status !== undefined) update.status = values.status;
  if (values.imageVersion !== undefined) update.image_version = values.imageVersion;
  if (values.sourceSnapshotId !== undefined) update.source_snapshot_id = values.sourceSnapshotId;
  if (values.sourceBaseGeneration !== undefined) update.source_base_generation = values.sourceBaseGeneration;
  if (values.targetBundleVersion !== undefined) update.target_bundle_version = values.targetBundleVersion;
  if (values.targetBundleSha256 !== undefined) update.target_bundle_sha256 = values.targetBundleSha256;
  if (values.recoveryCreateActionId !== undefined) update.recovery_create_action_id = values.recoveryCreateActionId;
  if (values.recoveryEncryptedPayload !== undefined) update.recovery_encrypted_payload = values.recoveryEncryptedPayload;
  if (values.recoveryOldServerId !== undefined) update.recovery_old_server_id = values.recoveryOldServerId;
  if (values.recoveryOldPublicIPv4 !== undefined) update.recovery_old_public_ipv4 = values.recoveryOldPublicIPv4;
  if (values.serverType !== undefined) update.server_type = values.serverType;
  if (values.location !== undefined) update.location = values.location;
  if (values.registrationTokenHash !== undefined) update.registration_token_hash = values.registrationTokenHash;
  if (values.registrationTokenExpiresAt !== undefined) update.registration_token_expires_at = values.registrationTokenExpiresAt;
  if (values.provisionedAt !== undefined) update.provisioned_at = values.provisionedAt;
  if (values.lastSeenAt !== undefined) update.last_seen_at = values.lastSeenAt;
  if (values.deletedAt !== undefined) update.deleted_at = values.deletedAt;
  if (values.failureCode !== undefined) update.failure_code = values.failureCode;
  if (values.failureAt !== undefined) update.failure_at = values.failureAt;
  if (values.resizeStartedAt !== undefined) update.resize_started_at = values.resizeStartedAt;
  if (values.resizeTargetServerType !== undefined) update.resize_target_server_type = values.resizeTargetServerType;
  if (values.attempt !== undefined) update.attempt = values.attempt;
  if (values.activationState !== undefined) update.activation_state = values.activationState;
  if (values.prebillingIntentId !== undefined) update.prebilling_intent_id = values.prebillingIntentId;
  if (values.activationAuthorizedAt !== undefined) update.activation_authorized_at = values.activationAuthorizedAt;
  return update;
}

function mapHostBundleRelease(row: HostBundleReleasesTable): HostBundleReleaseRecord {
  return {
    version: row.version,
    channel: row.channel,
    gitCommit: row.git_commit,
    gitRef: row.git_ref,
    snapshotEligible: row.snapshot_eligible,
    buildTime: row.build_time,
    bundleKey: row.bundle_key,
    checksumKey: row.checksum_key,
    incrementalManifestKey: row.incremental_manifest_key,
    incrementalManifestSha256: row.incremental_manifest_sha256,
    sha256: row.sha256,
    size: Number(row.size),
    severity: row.severity,
    updateType: row.update_type,
    changelog: row.changelog,
    createdAt: row.created_at,
  };
}

function toHostBundleReleaseRow(record: NewHostBundleRelease): HostBundleReleasesTable {
  const now = new Date().toISOString();
  return {
    version: record.version,
    channel: record.channel ?? null,
    git_commit: record.gitCommit,
    git_ref: record.gitRef ?? null,
    snapshot_eligible: record.snapshotEligible ?? false,
    snapshot_eligibility_source: record.snapshotEligible === undefined ? 'legacy' : 'explicit',
    build_time: HostBundleTimestampSchema.parse(record.buildTime),
    bundle_key: record.bundleKey,
    checksum_key: record.checksumKey ?? null,
    incremental_manifest_key: record.incrementalManifestKey ?? null,
    incremental_manifest_sha256: record.incrementalManifestSha256 ?? null,
    sha256: record.sha256,
    size: record.size,
    severity: record.severity ?? 'normal',
    update_type: record.updateType ?? 'manual',
    changelog: record.changelog ?? null,
    created_at: record.createdAt === undefined
      ? now
      : HostBundleTimestampSchema.parse(record.createdAt),
  };
}

function mapHostBundleChannel(row: HostBundleChannelsTable): HostBundleChannelRecord {
  return {
    channel: row.channel,
    version: row.version,
    updatedAt: row.updated_at,
  };
}

function mapProviderDeletion(row: ProviderDeletionQueueTable): ProviderDeletionQueueRecord {
  return {
    id: row.id,
    providerServerId: row.provider_server_id,
    reason: row.reason,
    machineId: row.machine_id,
    handle: row.handle,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    lastError: row.last_error,
    completedAt: row.completed_at,
  };
}

function toProviderDeletionRow(record: NewProviderDeletionQueueRecord): ProviderDeletionQueueTable {
  return {
    id: record.id,
    provider_server_id: record.providerServerId,
    reason: record.reason,
    machine_id: record.machineId ?? null,
    handle: record.handle ?? null,
    attempts: record.attempts ?? 0,
    next_attempt_at: record.nextAttemptAt,
    created_at: record.createdAt,
    last_error: record.lastError ?? null,
    completed_at: record.completedAt ?? null,
  };
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch (err: unknown) {
    if (err instanceof SyntaxError) return [];
    throw err;
  }
}

function mapBillingCustomer(row: BillingCustomersTable): BillingCustomerRecord {
  return {
    clerkUserId: row.clerk_user_id,
    stripeCustomerId: row.stripe_customer_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toBillingCustomerRow(record: NewBillingCustomer): BillingCustomersTable {
  return {
    clerk_user_id: record.clerkUserId,
    stripe_customer_id: record.stripeCustomerId,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

function mapBillingEntitlement(row: BillingEntitlementsTable): BillingEntitlementRecord {
  return {
    clerkUserId: row.clerk_user_id,
    source: row.source as BillingEntitlementSource,
    planSlug: row.plan_slug as MatrixBillingPlanSlug | 'internal',
    status: row.status as BillingEntitlementStatus,
    maxRuntimeSlots: row.max_runtime_slots,
    includedRuntimeSlots: row.included_runtime_slots,
    addonRuntimeSlots: row.addon_runtime_slots,
    defaultServerType: row.default_server_type,
    allowedServerTypes: parseStringArray(row.allowed_server_types),
    stripeSubscriptionId: row.stripe_subscription_id,
    stripePriceId: row.stripe_price_id,
    billingInterval: row.billing_interval as MatrixBillingInterval | null,
    gracePeriodEndsAt: row.grace_period_ends_at,
    trialStartedAt: row.trial_started_at,
    trialEndsAt: row.trial_ends_at,
    trialConvertedAt: row.trial_converted_at,
    firstTrialPaymentFailedAt: row.first_trial_payment_failed_at,
    effectiveFrom: row.effective_from,
    effectiveUntil: row.effective_until,
    updatedAt: row.updated_at,
  };
}

function toBillingEntitlementRow(record: NewBillingEntitlement): BillingEntitlementsTable {
  return {
    clerk_user_id: record.clerkUserId,
    source: record.source,
    plan_slug: record.planSlug,
    status: record.status,
    max_runtime_slots: record.maxRuntimeSlots,
    included_runtime_slots: record.includedRuntimeSlots,
    addon_runtime_slots: record.addonRuntimeSlots,
    default_server_type: record.defaultServerType,
    allowed_server_types: JSON.stringify(record.allowedServerTypes),
    stripe_subscription_id: record.stripeSubscriptionId,
    stripe_price_id: record.stripePriceId,
    billing_interval: record.billingInterval ?? null,
    grace_period_ends_at: record.gracePeriodEndsAt,
    trial_started_at: record.trialStartedAt ?? null,
    trial_ends_at: record.trialEndsAt ?? null,
    trial_converted_at: record.trialConvertedAt ?? null,
    first_trial_payment_failed_at: record.firstTrialPaymentFailedAt ?? null,
    effective_from: record.effectiveFrom,
    effective_until: record.effectiveUntil,
    updated_at: record.updatedAt,
  };
}

function mapBillingSubscription(row: BillingSubscriptionsTable): BillingSubscriptionRecord {
  return {
    stripeSubscriptionId: row.stripe_subscription_id,
    stripeCustomerId: row.stripe_customer_id,
    clerkUserId: row.clerk_user_id,
    runtimeSlot: row.runtime_slot,
    planSlug: row.plan_slug as MatrixBillingPlanSlug,
    stripePriceId: row.stripe_price_id,
    billingInterval: row.billing_interval as MatrixBillingInterval | null,
    status: row.status as BillingEntitlementStatus,
    currentPeriodEnd: row.current_period_end,
    gracePeriodEndsAt: row.grace_period_ends_at,
    trialStartedAt: row.trial_started_at,
    trialEndsAt: row.trial_ends_at,
    trialConvertedAt: row.trial_converted_at,
    firstTrialPaymentFailedAt: row.first_trial_payment_failed_at,
    latestEventCreatedAt: row.latest_event_created_at,
    latestEventId: row.latest_event_id,
    updatedAt: row.updated_at,
  };
}

function toBillingSubscriptionRow(record: NewBillingSubscription): BillingSubscriptionsTable {
  return {
    stripe_subscription_id: record.stripeSubscriptionId,
    stripe_customer_id: record.stripeCustomerId,
    clerk_user_id: record.clerkUserId,
    runtime_slot: record.runtimeSlot,
    plan_slug: record.planSlug,
    stripe_price_id: record.stripePriceId,
    billing_interval: record.billingInterval,
    status: record.status,
    current_period_end: record.currentPeriodEnd,
    grace_period_ends_at: record.gracePeriodEndsAt,
    trial_started_at: record.trialStartedAt ?? null,
    trial_ends_at: record.trialEndsAt ?? null,
    trial_converted_at: record.trialConvertedAt ?? null,
    first_trial_payment_failed_at: record.firstTrialPaymentFailedAt ?? null,
    latest_event_created_at: record.latestEventCreatedAt,
    latest_event_id: record.latestEventId,
    latest_invoice_event_created_at: null,
    latest_invoice_event_id: null,
    updated_at: record.updatedAt,
  };
}

function mapBillingOverride(row: BillingEntitlementOverridesTable): BillingEntitlementOverrideRecord {
  return {
    id: row.id,
    clerkUserId: row.clerk_user_id,
    planSlug: row.plan_slug as MatrixBillingPlanSlug | 'internal',
    status: row.status as 'active',
    maxRuntimeSlots: row.max_runtime_slots,
    includedRuntimeSlots: row.included_runtime_slots,
    addonRuntimeSlots: row.addon_runtime_slots,
    defaultServerType: row.default_server_type,
    allowedServerTypes: parseStringArray(row.allowed_server_types),
    reason: row.reason,
    createdBy: row.created_by,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

function toBillingOverrideRow(record: NewBillingEntitlementOverride): BillingEntitlementOverridesTable {
  return {
    id: record.id,
    clerk_user_id: record.clerkUserId,
    plan_slug: record.planSlug,
    status: record.status,
    max_runtime_slots: record.maxRuntimeSlots,
    included_runtime_slots: record.includedRuntimeSlots,
    addon_runtime_slots: record.addonRuntimeSlots,
    default_server_type: record.defaultServerType,
    allowed_server_types: JSON.stringify(record.allowedServerTypes),
    reason: record.reason,
    created_by: record.createdBy,
    expires_at: record.expiresAt,
    revoked_at: record.revokedAt,
    created_at: record.createdAt,
  };
}

function mapBillingWebhookEvent(row: BillingWebhookEventsTable): BillingWebhookEventRecord {
  return {
    stripeEventId: row.stripe_event_id,
    eventType: row.event_type,
    createdAtFromStripe: row.created_at_from_stripe,
    processedAt: row.processed_at,
    status: row.status,
    errorCode: row.error_code,
  };
}

function toBillingWebhookEventRow(record: NewBillingWebhookEvent): BillingWebhookEventsTable {
  return {
    stripe_event_id: record.stripeEventId,
    event_type: record.eventType,
    created_at_from_stripe: record.createdAtFromStripe,
    processed_at: record.processedAt,
    status: record.status,
    error_code: record.errorCode,
  };
}

export async function insertContainer(db: PlatformDB, record: NewContainer): Promise<void> {
  await db.ready;
  await db.executor.insertInto('containers').values(toContainerRow(record)).execute();
}

export async function getContainer(db: PlatformDB, handle: string): Promise<ContainerRecord | undefined> {
  await db.ready;
  const row = await db.executor.selectFrom('containers').selectAll().where('handle', '=', handle).executeTakeFirst();
  return row ? mapContainer(row) : undefined;
}

export async function getContainerByClerkId(db: PlatformDB, clerkUserId: string): Promise<ContainerRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('containers')
    .selectAll()
    .where('clerk_user_id', '=', clerkUserId)
    .executeTakeFirst();
  return row ? mapContainer(row) : undefined;
}

export async function updateContainerStatus(
  db: PlatformDB,
  handle: string,
  status: string,
  containerId?: string,
): Promise<void> {
  await db.ready;
  const values: Partial<ContainersTable> = { status };
  if (containerId !== undefined) values.container_id = containerId;
  await db.executor.updateTable('containers').set(values).where('handle', '=', handle).execute();
}

export async function updateLastActive(db: PlatformDB, handle: string): Promise<void> {
  await db.ready;
  await db.executor
    .updateTable('containers')
    .set({ last_active: new Date().toISOString() })
    .where('handle', '=', handle)
    .execute();
}

export async function listContainers(db: PlatformDB, status?: string): Promise<ContainerRecord[]> {
  await db.ready;
  let query = db.executor.selectFrom('containers').selectAll();
  if (status) query = query.where('status', '=', status);
  const rows = await query
    .orderBy('created_at', 'desc')
    .orderBy('handle', 'desc')
    .execute();
  return rows.map(mapContainer);
}

export async function deleteContainer(db: PlatformDB, handle: string): Promise<void> {
  await db.ready;
  await db.executor.deleteFrom('containers').where('handle', '=', handle).execute();
}

export async function ensurePlatformUser(
  db: PlatformDB,
  record: NewPlatformUser,
): Promise<PlatformUserRecord> {
  await db.ready;
  const row = await db.executor
    .insertInto('users')
    .values(toPlatformUserRow(record))
    .onConflict((oc) => oc.column('clerk_id').doUpdateSet({
      handle: sql`users.handle`,
      display_name: record.displayName,
      email: record.email,
      container_id: sql`
        CASE
          WHEN users.container_id LIKE 'clerk:%' AND EXCLUDED.container_id NOT LIKE 'clerk:%'
            THEN EXCLUDED.container_id
          WHEN EXCLUDED.container_id LIKE 'clerk:%' AND users.container_id NOT LIKE 'clerk:%'
            THEN users.container_id
          ELSE EXCLUDED.container_id
        END
      `,
      container_version: sql`COALESCE(EXCLUDED.container_version, users.container_version)`,
      plan: record.plan ?? 'free',
      status: record.status ?? 'active',
      pipedream_external_id: sql`COALESCE(users.pipedream_external_id, EXCLUDED.pipedream_external_id)`,
      updated_at: sql`now()`,
    }))
    .returningAll()
    .executeTakeFirstOrThrow();
  return mapPlatformUser(row);
}

export async function getPlatformHandleConflict(
  db: PlatformDB,
  handle: string,
  clerkUserId: string,
): Promise<PlatformHandleConflict | undefined> {
  await db.ready;
  const platformUser = await db.executor
    .selectFrom('users')
    .select('clerk_id')
    .where('handle', '=', handle)
    .where('clerk_id', '!=', clerkUserId)
    .executeTakeFirst();
  if (platformUser) {
    return { source: 'users', clerkUserId: platformUser.clerk_id };
  }

  const activeMachine = await db.executor
    .selectFrom('user_machines')
    .select('clerk_user_id')
    .where('handle', '=', handle)
    .where('deleted_at', 'is', null)
    .where('clerk_user_id', '!=', clerkUserId)
    .executeTakeFirst();
  if (activeMachine) {
    return { source: 'user_machines', clerkUserId: activeMachine.clerk_user_id };
  }

  const ownedActiveMachine = await db.executor
    .selectFrom('user_machines')
    .select('machine_id')
    .where('handle', '=', handle)
    .where('deleted_at', 'is', null)
    .where('clerk_user_id', '=', clerkUserId)
    .executeTakeFirst();
  if (ownedActiveMachine) {
    return undefined;
  }

  const legacyContainer = await db.executor
    .selectFrom('containers')
    .select('clerk_user_id')
    .where('handle', '=', handle)
    .where('clerk_user_id', '!=', clerkUserId)
    .executeTakeFirst();
  if (legacyContainer) {
    return { source: 'containers', clerkUserId: legacyContainer.clerk_user_id };
  }

  return undefined;
}

export async function isPlatformHandleAvailableForClerkUser(
  db: PlatformDB,
  handle: string,
  clerkUserId: string,
): Promise<boolean> {
  return !(await getPlatformHandleConflict(db, handle, clerkUserId));
}

export async function getPlatformUserByClerkId(
  db: PlatformDB,
  clerkId: string,
): Promise<PlatformUserRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('users')
    .selectAll()
    .where('clerk_id', '=', clerkId)
    .executeTakeFirst();
  return row ? mapPlatformUser(row) : undefined;
}

export async function getPlatformUserByHandle(
  db: PlatformDB,
  handle: string,
): Promise<PlatformUserRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('users')
    .selectAll()
    .where('handle', '=', handle)
    .executeTakeFirst();
  return row ? mapPlatformUser(row) : undefined;
}

export async function upsertBillingCustomer(db: PlatformDB, record: NewBillingCustomer): Promise<void> {
  await db.ready;
  await db.executor
    .insertInto('billing_customers')
    .values(toBillingCustomerRow(record))
    .onConflict((oc) => oc.column('clerk_user_id').doUpdateSet({
      stripe_customer_id: record.stripeCustomerId,
      updated_at: record.updatedAt,
    }))
    .execute();
}

export async function insertBillingCustomerIfAbsent(db: PlatformDB, record: NewBillingCustomer): Promise<void> {
  await db.ready;
  await db.executor
    .insertInto('billing_customers')
    .values(toBillingCustomerRow(record))
    .onConflict((oc) => oc.column('clerk_user_id').doNothing())
    .execute();
}

export async function getBillingCustomerByClerkUserId(
  db: PlatformDB,
  clerkUserId: string,
): Promise<BillingCustomerRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('billing_customers')
    .selectAll()
    .where('clerk_user_id', '=', clerkUserId)
    .executeTakeFirst();
  return row ? mapBillingCustomer(row) : undefined;
}

export async function getBillingCustomerByStripeCustomerId(
  db: PlatformDB,
  stripeCustomerId: string,
): Promise<BillingCustomerRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('billing_customers')
    .selectAll()
    .where('stripe_customer_id', '=', stripeCustomerId)
    .executeTakeFirst();
  return row ? mapBillingCustomer(row) : undefined;
}

export async function hasBillingSubscriptionHistory(
  db: PlatformDB,
  clerkUserId: string,
): Promise<boolean> {
  await db.ready;
  const row = await db.executor
    .selectFrom('billing_subscriptions')
    .select('stripe_subscription_id')
    .where('clerk_user_id', '=', clerkUserId)
    .limit(1)
    .executeTakeFirst();
  return Boolean(row);
}

export async function upsertBillingSubscription(db: PlatformDB, record: NewBillingSubscription): Promise<boolean> {
  await db.ready;
  const row = toBillingSubscriptionRow(record);
  const applied = await db.executor
    .insertInto('billing_subscriptions')
    .values(row)
    .onConflict((oc) => oc.column('stripe_subscription_id').doUpdateSet({
      stripe_customer_id: row.stripe_customer_id,
      clerk_user_id: row.clerk_user_id,
      runtime_slot: row.runtime_slot,
      plan_slug: row.plan_slug,
      stripe_price_id: row.stripe_price_id,
      billing_interval: row.billing_interval,
      status: row.status,
      current_period_end: row.current_period_end,
      grace_period_ends_at: row.grace_period_ends_at,
      trial_started_at: sql<string | null>`COALESCE(
        billing_subscriptions.trial_started_at,
        EXCLUDED.trial_started_at
      )`,
      trial_ends_at: sql<string | null>`COALESCE(
        billing_subscriptions.trial_ends_at,
        EXCLUDED.trial_ends_at
      )`,
      trial_converted_at: sql<string | null>`COALESCE(
        billing_subscriptions.trial_converted_at,
        EXCLUDED.trial_converted_at
      )`,
      first_trial_payment_failed_at: sql<string | null>`CASE
        WHEN billing_subscriptions.trial_converted_at IS NOT NULL
          OR EXCLUDED.trial_converted_at IS NOT NULL
          THEN NULL
        ELSE COALESCE(
          billing_subscriptions.first_trial_payment_failed_at,
          EXCLUDED.first_trial_payment_failed_at
        )
      END`,
      latest_event_created_at: row.latest_event_created_at,
      latest_event_id: row.latest_event_id,
      updated_at: row.updated_at,
    }).where((eb) => eb.or([
      eb('billing_subscriptions.latest_event_created_at', '<', row.latest_event_created_at),
      eb.and([
        eb('billing_subscriptions.latest_event_created_at', '=', row.latest_event_created_at),
        eb('billing_subscriptions.latest_event_id', '<', row.latest_event_id),
      ]),
    ])))
    .returning('stripe_subscription_id')
    .executeTakeFirst();
  return Boolean(applied);
}

export async function getBillingSubscription(
  db: PlatformDB,
  clerkUserId: string,
  runtimeSlot: string,
  atIso: string,
): Promise<BillingSubscriptionRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('billing_subscriptions')
    .selectAll()
    .where('clerk_user_id', '=', clerkUserId)
    .where('runtime_slot', '=', runtimeSlot)
    .orderBy(sql<number>`CASE
      WHEN billing_subscriptions.status IN ('active', 'trialing') THEN 0
      WHEN billing_subscriptions.grace_period_ends_at IS NOT NULL
        AND billing_subscriptions.grace_period_ends_at >= ${atIso} THEN 1
      ELSE 2
    END`)
    .orderBy('latest_event_created_at', 'desc')
    .orderBy('latest_event_id', 'desc')
    .executeTakeFirst();
  return row ? mapBillingSubscription(row) : undefined;
}

export async function getBillingSubscriptionByStripeId(
  db: PlatformDB,
  stripeSubscriptionId: string,
): Promise<BillingSubscriptionRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('billing_subscriptions')
    .selectAll()
    .where('stripe_subscription_id', '=', stripeSubscriptionId)
    .executeTakeFirst();
  return row ? mapBillingSubscription(row) : undefined;
}

export interface TrialInvoiceEventProjectionResult {
  applied: boolean;
  lifecycleChanged: boolean;
  subscription: BillingSubscriptionRecord;
}

/**
 * Projects a conversion-invoice event under a dedicated monotonic cursor with
 * the same timestamp-and-ID ordering used by subscription webhooks. Keeping
 * the cursors separate prevents a later subscription projection from hiding a
 * valid invoice transition. Callers run this inside the webhook transaction,
 * so the row lock also serializes competing invoice deliveries.
 */
export async function projectTrialInvoiceEvent(
  db: PlatformDB,
  input: {
    stripeSubscriptionId: string;
    type: 'invoice.paid' | 'invoice.payment_failed';
    eventCreatedAt: string;
    eventId: string;
    lifecycleAt: string;
    updatedAt: string;
  },
): Promise<TrialInvoiceEventProjectionResult | undefined> {
  await db.ready;
  const currentRow = await db.executor
    .selectFrom('billing_subscriptions')
    .selectAll()
    .where('stripe_subscription_id', '=', input.stripeSubscriptionId)
    .forUpdate()
    .executeTakeFirst();
  if (!currentRow || currentRow.trial_ends_at === null) return undefined;

  const subscriptionCursorIsNewer = currentRow.latest_event_created_at > input.eventCreatedAt
    || (
      currentRow.latest_event_created_at === input.eventCreatedAt
      && currentRow.latest_event_id > input.eventId
    );
  if (
    subscriptionCursorIsNewer
    && !subscriptionStatusAcceptsOlderTrialInvoice(currentRow.status, input.type)
  ) {
    return {
      applied: false,
      lifecycleChanged: false,
      subscription: mapBillingSubscription(currentRow),
    };
  }

  const eventIsNewer = currentRow.latest_invoice_event_created_at === null
    || currentRow.latest_invoice_event_created_at < input.eventCreatedAt
    || (
      currentRow.latest_invoice_event_created_at === input.eventCreatedAt
      && (currentRow.latest_invoice_event_id === null || currentRow.latest_invoice_event_id < input.eventId)
    );
  if (!eventIsNewer) {
    return {
      applied: false,
      lifecycleChanged: false,
      subscription: mapBillingSubscription(currentRow),
    };
  }

  const paymentFailed = input.type === 'invoice.payment_failed';
  const lifecycleChanged = paymentFailed
    ? currentRow.trial_converted_at === null && currentRow.first_trial_payment_failed_at === null
    : currentRow.trial_converted_at === null;
  const invoiceCursorCreatedAt = currentRow.latest_invoice_event_created_at;
  const invoiceCursorId = currentRow.latest_invoice_event_id;
  const row = await db.executor
    .updateTable('billing_subscriptions')
    .set({
      trial_converted_at: !paymentFailed && lifecycleChanged
        ? input.lifecycleAt
        : currentRow.trial_converted_at,
      first_trial_payment_failed_at: paymentFailed && lifecycleChanged
        ? input.lifecycleAt
        : (!paymentFailed && lifecycleChanged ? null : currentRow.first_trial_payment_failed_at),
      grace_period_ends_at: paymentFailed && lifecycleChanged
        ? null
        : currentRow.grace_period_ends_at,
      latest_invoice_event_created_at: input.eventCreatedAt,
      latest_invoice_event_id: input.eventId,
      updated_at: input.updatedAt,
    })
    .where('stripe_subscription_id', '=', input.stripeSubscriptionId)
    .$if(invoiceCursorCreatedAt === null, (query) => (
      query.where('latest_invoice_event_created_at', 'is', null)
    ))
    .$if(invoiceCursorCreatedAt !== null, (query) => (
      query.where('latest_invoice_event_created_at', '=', invoiceCursorCreatedAt ?? '')
    ))
    .$if(invoiceCursorId === null, (query) => (
      query.where('latest_invoice_event_id', 'is', null)
    ))
    .$if(invoiceCursorId !== null, (query) => (
      query.where('latest_invoice_event_id', '=', invoiceCursorId ?? '')
    ))
    .returningAll()
    .executeTakeFirst();
  if (!row) return undefined;
  return {
    applied: true,
    lifecycleChanged,
    subscription: mapBillingSubscription(row),
  };
}

function subscriptionStatusAcceptsOlderTrialInvoice(
  status: string,
  type: 'invoice.paid' | 'invoice.payment_failed',
): boolean {
  if (type === 'invoice.paid') return status === 'active';
  return status === 'past_due'
    || status === 'unpaid'
    || status === 'canceled'
    || status === 'ended'
    || status === 'incomplete'
    || status === 'incomplete_expired'
    || status === 'paused';
}

export async function listCurrentBillingSubscriptions(
  db: PlatformDB,
  clerkUserId: string,
  atIso: string,
): Promise<BillingSubscriptionRecord[]> {
  await db.ready;
  const rows = await db.executor
    .selectFrom('billing_subscriptions')
    .distinctOn('runtime_slot')
    .selectAll()
    .where('clerk_user_id', '=', clerkUserId)
    .orderBy('runtime_slot', 'asc')
    .orderBy(sql<number>`CASE
      WHEN billing_subscriptions.status IN ('active', 'trialing') THEN 0
      WHEN billing_subscriptions.grace_period_ends_at IS NOT NULL
        AND billing_subscriptions.grace_period_ends_at >= ${atIso} THEN 1
      ELSE 2
    END`)
    .orderBy('latest_event_created_at', 'desc')
    .orderBy('latest_event_id', 'desc')
    .execute();
  return rows.map(mapBillingSubscription);
}

export async function upsertBillingEntitlement(db: PlatformDB, record: NewBillingEntitlement): Promise<void> {
  await db.ready;
  const row = toBillingEntitlementRow(record);
  await db.executor
    .insertInto('billing_entitlements')
    .values(row)
    .onConflict((oc) => oc.column('clerk_user_id').doUpdateSet({
      source: row.source,
      plan_slug: row.plan_slug,
      status: row.status,
      max_runtime_slots: row.max_runtime_slots,
      included_runtime_slots: row.included_runtime_slots,
      addon_runtime_slots: row.addon_runtime_slots,
      default_server_type: row.default_server_type,
      allowed_server_types: row.allowed_server_types,
      stripe_subscription_id: row.stripe_subscription_id,
      stripe_price_id: row.stripe_price_id,
      billing_interval: row.billing_interval,
      grace_period_ends_at: row.grace_period_ends_at,
      trial_started_at: row.trial_started_at,
      trial_ends_at: row.trial_ends_at,
      trial_converted_at: row.trial_converted_at,
      first_trial_payment_failed_at: row.first_trial_payment_failed_at,
      effective_from: row.effective_from,
      effective_until: row.effective_until,
      updated_at: row.updated_at,
    }).where('billing_entitlements.updated_at', '<=', row.updated_at))
    .execute();
}

export async function getBillingEntitlement(
  db: PlatformDB,
  clerkUserId: string,
): Promise<BillingEntitlementRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('billing_entitlements')
    .selectAll()
    .where('clerk_user_id', '=', clerkUserId)
    .executeTakeFirst();
  return row ? mapBillingEntitlement(row) : undefined;
}

export async function upsertBillingOverride(db: PlatformDB, record: NewBillingEntitlementOverride): Promise<void> {
  await db.ready;
  const row = toBillingOverrideRow(record);
  await db.executor
    .insertInto('billing_entitlement_overrides')
    .values(row)
    .onConflict((oc) => oc.column('id').doUpdateSet({
      plan_slug: row.plan_slug,
      status: row.status,
      max_runtime_slots: row.max_runtime_slots,
      included_runtime_slots: row.included_runtime_slots,
      addon_runtime_slots: row.addon_runtime_slots,
      default_server_type: row.default_server_type,
      allowed_server_types: row.allowed_server_types,
      reason: row.reason,
      created_by: row.created_by,
      expires_at: row.expires_at,
    }))
    .execute();
}

export async function getBillingOverride(
  db: PlatformDB,
  clerkUserId: string,
  nowIso = new Date().toISOString(),
): Promise<BillingEntitlementOverrideRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('billing_entitlement_overrides')
    .selectAll()
    .where('clerk_user_id', '=', clerkUserId)
    .where('revoked_at', 'is', null)
    .where((eb) => eb.or([
      eb('expires_at', 'is', null),
      eb('expires_at', '>', nowIso),
    ]))
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  return row ? mapBillingOverride(row) : undefined;
}

export async function getBillingEntitlementState(
  db: PlatformDB,
  clerkUserId: string,
  nowIso = new Date().toISOString(),
): Promise<BillingEntitlementStateRecord> {
  await db.ready;
  const result = await sql<{
    entitlement: BillingEntitlementsTable | null;
    override: BillingEntitlementOverridesTable | null;
  }>`
    SELECT
      (
        SELECT row_to_json(e)
        FROM billing_entitlements e
        WHERE e.clerk_user_id = ${clerkUserId}
      ) AS entitlement,
      (
        SELECT row_to_json(o)
        FROM billing_entitlement_overrides o
        WHERE o.clerk_user_id = ${clerkUserId}
          AND o.revoked_at IS NULL
          AND (o.expires_at IS NULL OR o.expires_at > ${nowIso})
        ORDER BY o.created_at DESC
        LIMIT 1
      ) AS override
  `.execute(db.executor);
  const row = result.rows[0];
  return {
    entitlement: row?.entitlement ? mapBillingEntitlement(row.entitlement) : undefined,
    override: row?.override ? mapBillingOverride(row.override) : undefined,
  };
}

export async function revokeBillingOverride(db: PlatformDB, id: string, revokedAt: string): Promise<boolean> {
  await db.ready;
  const row = await db.executor
    .updateTable('billing_entitlement_overrides')
    .set({ revoked_at: revokedAt })
    .where('id', '=', id)
    .where('revoked_at', 'is', null)
    .returning('id')
    .executeTakeFirst();
  return Boolean(row);
}

export async function insertBillingWebhookEvent(
  db: PlatformDB,
  record: NewBillingWebhookEvent,
): Promise<{ inserted: boolean }> {
  await db.ready;
  const result = await db.executor
    .insertInto('billing_webhook_events')
    .values(toBillingWebhookEventRow(record))
    .onConflict((oc) => oc.column('stripe_event_id').doNothing())
    .returning('stripe_event_id')
    .executeTakeFirst();
  return { inserted: Boolean(result?.stripe_event_id) };
}

export async function getBillingWebhookEvent(
  db: PlatformDB,
  stripeEventId: string,
): Promise<BillingWebhookEventRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('billing_webhook_events')
    .selectAll()
    .where('stripe_event_id', '=', stripeEventId)
    .executeTakeFirst();
  return row ? mapBillingWebhookEvent(row) : undefined;
}

export async function insertUserMachine(db: PlatformDB, record: NewUserMachine): Promise<void> {
  await db.ready;
  await db.executor.insertInto('user_machines').values(toUserMachineRow(record)).execute();
}

export async function getUserMachine(db: PlatformDB, machineId: string): Promise<UserMachineRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('user_machines')
    .selectAll()
    .where('machine_id', '=', machineId)
    .executeTakeFirst();
  return row ? mapUserMachine(row) : undefined;
}

export async function getActiveUserMachineByClerkId(
  db: PlatformDB,
  clerkUserId: string,
  runtimeSlot?: string,
): Promise<UserMachineRecord | undefined> {
  await db.ready;
  let query = db.executor
    .selectFrom('user_machines')
    .selectAll()
    .where('clerk_user_id', '=', clerkUserId)
    .where('deleted_at', 'is', null);
  if (runtimeSlot) {
    query = query.where('runtime_slot', '=', runtimeSlot);
  } else {
    query = query
      .orderBy(sql`CASE WHEN runtime_slot = 'primary' THEN 0 ELSE 1 END`)
      .orderBy('provisioned_at', 'desc');
  }
  const row = await query.executeTakeFirst();
  return row ? mapUserMachine(row) : undefined;
}

export function accessibleUserMachinePredicate(clerkUserId: string) {
  return sql<boolean>`(
    clerk_user_id = ${clerkUserId}
    OR (
      provisioning_class = 'preview'
      AND handle ~ '^pr-[1-9][0-9]{0,9}$'
      AND (runtime_slot = handle OR runtime_slot = 'preview')
      AND access_clerk_user_ids @> ARRAY[${clerkUserId}]::TEXT[]
    )
  )`;
}

export async function getAccessibleActiveUserMachineByClerkId(
  db: PlatformDB,
  clerkUserId: string,
  runtimeSlot?: string,
): Promise<UserMachineRecord | undefined> {
  await db.ready;
  let query = db.executor
    .selectFrom('user_machines')
    .selectAll()
    .where(accessibleUserMachinePredicate(clerkUserId))
    .where('activation_state', '=', 'authorized')
    .where('deleted_at', 'is', null);
  if (runtimeSlot) {
    query = query.where('runtime_slot', '=', runtimeSlot);
  } else {
    query = query
      .orderBy(sql`CASE WHEN clerk_user_id = ${clerkUserId} AND runtime_slot = 'primary' THEN 0 ELSE 1 END`)
      .orderBy('provisioned_at', 'desc');
  }
  const row = await query.executeTakeFirst();
  return row ? mapUserMachine(row) : undefined;
}

export async function getActiveUserMachineByHandle(
  db: PlatformDB,
  handle: string,
  runtimeSlot?: string,
): Promise<UserMachineRecord | undefined> {
  await db.ready;
  let query = db.executor
    .selectFrom('user_machines')
    .selectAll()
    .where('handle', '=', handle)
    .where('deleted_at', 'is', null);
  if (runtimeSlot) {
    query = query.where('runtime_slot', '=', runtimeSlot);
  } else {
    query = query
      .orderBy(sql`CASE WHEN runtime_slot = 'primary' THEN 0 ELSE 1 END`)
      .orderBy('provisioned_at', 'desc');
  }
  const row = await query.executeTakeFirst();
  return row ? mapUserMachine(row) : undefined;
}

export async function getRunningUserMachineByHandle(
  db: PlatformDB,
  handle: string,
  runtimeSlot?: string,
): Promise<UserMachineRecord | undefined> {
  await db.ready;
  let query = db.executor
    .selectFrom('user_machines')
    .selectAll()
    .where('handle', '=', handle)
    .where('status', '=', 'running')
    .where('activation_state', '=', 'authorized')
    .where('deleted_at', 'is', null);
  if (runtimeSlot) {
    query = query.where('runtime_slot', '=', runtimeSlot);
  } else {
    query = query
      .orderBy(sql`CASE WHEN runtime_slot = 'primary' THEN 0 ELSE 1 END`)
      .orderBy('provisioned_at', 'desc');
  }
  const row = await query.executeTakeFirst();
  return row ? mapUserMachine(row) : undefined;
}

export async function getRunningUserMachineByClerkId(
  db: PlatformDB,
  clerkUserId: string,
  runtimeSlot = 'primary',
): Promise<UserMachineRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('user_machines')
    .selectAll()
    .where('clerk_user_id', '=', clerkUserId)
    .where('runtime_slot', '=', runtimeSlot)
    .where('status', '=', 'running')
    .where('activation_state', '=', 'authorized')
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  return row ? mapUserMachine(row) : undefined;
}

export async function getAccessibleRunningUserMachineByClerkId(
  db: PlatformDB,
  clerkUserId: string,
  runtimeSlot: string,
): Promise<UserMachineRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('user_machines')
    .selectAll()
    .where(accessibleUserMachinePredicate(clerkUserId))
    .where('runtime_slot', '=', runtimeSlot)
    .where('status', '=', 'running')
    .where('activation_state', '=', 'authorized')
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  return row ? mapUserMachine(row) : undefined;
}

export async function getRunningUserMachineByClerkIdForUpdate(
  db: PlatformDB,
  clerkUserId: string,
  runtimeSlot: string,
): Promise<UserMachineRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('user_machines')
    .selectAll()
    .where('clerk_user_id', '=', clerkUserId)
    .where('runtime_slot', '=', runtimeSlot)
    .where('status', '=', 'running')
    .where('activation_state', '=', 'authorized')
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  return row ? mapUserMachine(row) : undefined;
}

export async function listUserMachines(
  db: PlatformDB,
  options: { includeDeleted?: boolean } = {},
): Promise<UserMachineRecord[]> {
  await db.ready;
  let query = db.executor
    .selectFrom('user_machines')
    .selectAll()
    .orderBy('provisioned_at', 'desc');
  if (!options.includeDeleted) {
    query = query.where('deleted_at', 'is', null);
  }
  const rows = await query.execute();
  return rows.map(mapUserMachine);
}

export async function listActiveUserMachinesByClerkId(
  db: PlatformDB,
  clerkUserId: string,
): Promise<UserMachineRecord[]> {
  await db.ready;
  const rows = await db.executor
    .selectFrom('user_machines')
    .selectAll()
    .where('clerk_user_id', '=', clerkUserId)
    .where('deleted_at', 'is', null)
    .where('status', 'in', [
      'running',
      'provisioning',
      'recovering',
      'resizing',
      'suspending',
      'suspended',
      'resuming',
    ])
    .orderBy(sql`CASE WHEN runtime_slot = 'primary' THEN 0 ELSE 1 END`)
    .orderBy('provisioned_at', 'desc')
    .execute();
  return rows.map(mapUserMachine);
}

export async function listAccessibleActiveUserMachinesByClerkId(
  db: PlatformDB,
  clerkUserId: string,
): Promise<UserMachineRecord[]> {
  await db.ready;
  const rows = await db.executor
    .selectFrom('user_machines')
    .selectAll()
    .where(accessibleUserMachinePredicate(clerkUserId))
    .where('deleted_at', 'is', null)
    .where('status', 'in', ['running', 'provisioning', 'recovering', 'resizing'])
    .orderBy(sql`CASE WHEN clerk_user_id = ${clerkUserId} AND runtime_slot = 'primary' THEN 0 ELSE 1 END`)
    .orderBy('provisioned_at', 'desc')
    .execute();
  return rows.map(mapUserMachine);
}

export async function listNonDeletedUserMachinesByClerkId(
  db: PlatformDB,
  clerkUserId: string,
): Promise<UserMachineRecord[]> {
  await db.ready;
  const rows = await db.executor
    .selectFrom('user_machines')
    .selectAll()
    .where('clerk_user_id', '=', clerkUserId)
    .where('deleted_at', 'is', null)
    .orderBy(sql`CASE WHEN runtime_slot = 'primary' THEN 0 ELSE 1 END`)
    .orderBy('provisioned_at', 'desc')
    .execute();
  return rows.map(mapUserMachine);
}

export async function updateUserMachine(
  db: PlatformDB,
  machineId: string,
  values: Partial<NewUserMachine>,
): Promise<void> {
  await db.ready;
  await db.executor
    .updateTable('user_machines')
    .set(toUserMachineUpdate(values))
    .where('machine_id', '=', machineId)
    .execute();
}

export async function claimRunningUserMachineResize(
  db: PlatformDB,
  machineId: string,
  hetznerServerId: number,
  resizeStartedAt: string,
  resizeTargetServerType: string,
): Promise<UserMachineRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .updateTable('user_machines')
    .set({
      status: 'resizing',
      failure_code: null,
      failure_at: null,
      resize_started_at: resizeStartedAt,
      resize_target_server_type: resizeTargetServerType,
    })
    .where('machine_id', '=', machineId)
    .where('hetzner_server_id', '=', hetznerServerId)
    .where('status', '=', 'running')
    .where('deleted_at', 'is', null)
    .returningAll()
    .executeTakeFirst();
  return row ? mapUserMachine(row) : undefined;
}

export async function completeUserMachineResize(
  db: PlatformDB,
  machineId: string,
  hetznerServerId: number,
  values: Partial<NewUserMachine>,
): Promise<UserMachineRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .updateTable('user_machines')
    .set(toUserMachineUpdate(values))
    .where('machine_id', '=', machineId)
    .where('hetzner_server_id', '=', hetznerServerId)
    .where('status', '=', 'resizing')
    .where('deleted_at', 'is', null)
    .returningAll()
    .executeTakeFirst();
  return row ? mapUserMachine(row) : undefined;
}

export async function claimRunningUserMachineBillingSuspend(
  db: PlatformDB,
  machineId: string,
  hetznerServerId: number,
): Promise<UserMachineRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .updateTable('user_machines')
    .set({ status: 'suspending', failure_code: null, failure_at: null })
    .where('machine_id', '=', machineId)
    .where('hetzner_server_id', '=', hetznerServerId)
    .where('status', 'in', ['running', 'resuming'])
    .where('deleted_at', 'is', null)
    .returningAll()
    .executeTakeFirst();
  return row ? mapUserMachine(row) : undefined;
}

export async function completeUserMachineBillingSuspend(
  db: PlatformDB,
  machineId: string,
  hetznerServerId: number,
): Promise<UserMachineRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .updateTable('user_machines')
    .set({ status: 'suspended', failure_code: null, failure_at: null })
    .where('machine_id', '=', machineId)
    .where('hetzner_server_id', '=', hetznerServerId)
    .where('status', '=', 'suspending')
    .where('deleted_at', 'is', null)
    .returningAll()
    .executeTakeFirst();
  return row ? mapUserMachine(row) : undefined;
}

export async function claimSuspendedUserMachineBillingResume(
  db: PlatformDB,
  machineId: string,
  hetznerServerId: number,
): Promise<UserMachineRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .updateTable('user_machines')
    .set({ status: 'resuming', failure_code: null, failure_at: null })
    .where('machine_id', '=', machineId)
    .where('hetzner_server_id', '=', hetznerServerId)
    .where('status', 'in', ['suspended', 'suspending'])
    .where('deleted_at', 'is', null)
    .returningAll()
    .executeTakeFirst();
  return row ? mapUserMachine(row) : undefined;
}

export async function completeUserMachineBillingResume(
  db: PlatformDB,
  machineId: string,
  hetznerServerId: number,
): Promise<UserMachineRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .updateTable('user_machines')
    .set({ status: 'running', failure_code: null, failure_at: null })
    .where('machine_id', '=', machineId)
    .where('hetzner_server_id', '=', hetznerServerId)
    .where('status', '=', 'resuming')
    .where('deleted_at', 'is', null)
    .returningAll()
    .executeTakeFirst();
  return row ? mapUserMachine(row) : undefined;
}

export async function listStaleResizingUserMachines(
  db: PlatformDB,
  olderThanIso: string,
  limit: number,
): Promise<UserMachineRecord[]> {
  await db.ready;
  const rows = await db.executor
    .selectFrom('user_machines')
    .selectAll()
    .where('status', '=', 'resizing')
    .where('resize_started_at', 'is not', null)
    .where('resize_started_at', '<', olderThanIso)
    .where('deleted_at', 'is', null)
    .orderBy('resize_started_at')
    .limit(limit)
    .execute();
  return rows.map(mapUserMachine);
}

export async function completeUserMachineRegistration(
  db: PlatformDB,
  machineId: string,
  hetznerServerId: number,
  expectedRegistrationTokenHash: string,
  expiresAfterIso: string,
  values: Partial<NewUserMachine>,
): Promise<UserMachineRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .updateTable('user_machines')
    .set(toUserMachineUpdate(values))
    .where('machine_id', '=', machineId)
    .where('hetzner_server_id', '=', hetznerServerId)
    .where('registration_token_hash', '=', expectedRegistrationTokenHash)
    .where('registration_token_expires_at', '>=', expiresAfterIso)
    .where('status', 'in', ['provisioning', 'recovering'])
    .where('deleted_at', 'is', null)
    .returningAll()
    .executeTakeFirst();
  return row ? mapUserMachine(row) : undefined;
}

export async function claimUserMachineRecovery(
  db: PlatformDB,
  clerkUserId: string,
  runtimeSlot = 'primary',
  intent?: {
    machineId: string;
    encryptedPayload: string;
    serverType: string;
    registrationTokenHash: string;
    registrationTokenExpiresAt: string;
  },
): Promise<UserMachineRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .updateTable('user_machines')
    .set(intent ? {
      machine_id: intent.machineId,
      recovery_encrypted_payload: intent.encryptedPayload,
      recovery_old_server_id: sql<number | null>`hetzner_server_id`,
      recovery_old_public_ipv4: sql<string | null>`public_ipv4`,
      server_type: intent.serverType,
      registration_token_hash: intent.registrationTokenHash,
      registration_token_expires_at: intent.registrationTokenExpiresAt,
      status: 'recovering',
      hetzner_server_id: null,
      recovery_create_action_id: null,
      failure_code: null,
      failure_at: null,
    } : {
      status: 'recovering',
      hetzner_server_id: null,
      public_ipv4: null,
      public_ipv6: null,
      recovery_old_public_ipv4: null,
      failure_code: null,
      failure_at: null,
    })
    .where('clerk_user_id', '=', clerkUserId)
    .where('runtime_slot', '=', runtimeSlot)
    .where('deleted_at', 'is', null)
    .where('status', '!=', 'recovering')
    .where('status', '!=', 'resizing')
    .returningAll()
    .executeTakeFirst();
  return row ? mapUserMachine(row) : undefined;
}

/**
 * Soft-deletes a failed machine row so it stops occupying the active
 * (clerk_user_id, runtime_slot) unique slot, letting a retry provision a fresh
 * machine. The failure status is preserved for audit; only `deleted_at` is set.
 * The `status = 'failed'` guard encodes the invariant at the DB layer: this
 * helper must never silently retire a live (provisioning/recovering/running)
 * machine, even if a future caller forgets the status check.
 */
export async function retireUserMachine(
  db: PlatformDB,
  machineId: string,
  retiredAt: string,
): Promise<void> {
  await db.ready;
  await db.executor
    .updateTable('user_machines')
    .set({ deleted_at: retiredAt })
    .where('machine_id', '=', machineId)
    .where('deleted_at', 'is', null)
    .where('status', '=', 'failed')
    .execute();
}

export async function claimUserMachineDelete(
  db: PlatformDB,
  machineId: string,
  deletedAt: string,
): Promise<UserMachineRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .updateTable('user_machines')
    .set({ status: 'deleted', deleted_at: deletedAt })
    .where('machine_id', '=', machineId)
    .where('deleted_at', 'is', null)
    .where('status', 'not in', ['resizing', 'suspending', 'resuming'])
    .returningAll()
    .executeTakeFirst();
  return row ? mapUserMachine(row) : undefined;
}

export async function softDeleteUserMachine(db: PlatformDB, machineId: string, deletedAt: string): Promise<void> {
  await claimUserMachineDelete(db, machineId, deletedAt);
}

export async function insertProviderDeletion(
  db: PlatformDB,
  record: NewProviderDeletionQueueRecord,
): Promise<void> {
  await db.ready;
  await db.executor
    .insertInto('provider_deletion_queue')
    .values(toProviderDeletionRow(record))
    .onConflict((oc) => oc.column('provider_server_id')
      .where('completed_at', 'is', null).doNothing())
    .execute();
}

export async function listPendingProviderDeletions(
  db: PlatformDB,
  nowIso: string,
  limit: number,
): Promise<ProviderDeletionQueueRecord[]> {
  await db.ready;
  const rows = await db.executor
    .selectFrom('provider_deletion_queue')
    .selectAll()
    .where('completed_at', 'is', null)
    .where('next_attempt_at', '<=', nowIso)
    .orderBy('next_attempt_at')
    .limit(limit)
    .execute();
  return rows.map(mapProviderDeletion);
}

export async function listRunningUserMachines(
  db: PlatformDB,
  limit: number,
  filters: {
    handle?: string;
    provisioningClass?: UserMachineProvisioningClass;
  } = {},
): Promise<UserMachineRecord[]> {
  await db.ready;
  let query = db.executor
    .selectFrom('user_machines')
    .selectAll()
    .where('status', '=', 'running')
    .where('deleted_at', 'is', null);
  if (filters.handle !== undefined) {
    query = query.where('handle', '=', filters.handle);
  }
  if (filters.provisioningClass !== undefined) {
    query = query.where('provisioning_class', '=', filters.provisioningClass);
  }
  const rows = await query
    .orderBy('last_seen_at', 'desc')
    .limit(limit)
    .execute();
  return rows.map(mapUserMachine);
}

export async function listAllUserMachines(
  db: PlatformDB,
  limit: number,
): Promise<UserMachineRecord[]> {
  await db.ready;
  const rows = await db.executor
    .selectFrom('user_machines')
    .selectAll()
    .where('status', '!=', 'deleted')
    .where('deleted_at', 'is', null)
    .orderBy('last_seen_at', 'desc')
    .limit(limit)
    .execute();
  return rows.map(mapUserMachine);
}

export async function upsertHostBundleRelease(
  db: PlatformDB,
  record: NewHostBundleRelease,
): Promise<HostBundleReleaseRecord> {
  await db.ready;
  const row = toHostBundleReleaseRow(record);
  const saved = await db.executor
      .insertInto('host_bundle_releases')
      .values(row)
      .onConflict((oc) =>
        oc.column('version').doUpdateSet({
          severity: row.severity,
          update_type: row.update_type,
          changelog: row.changelog,
          incremental_manifest_key: row.incremental_manifest_key,
          incremental_manifest_sha256: row.incremental_manifest_sha256,
          snapshot_eligible: sql<boolean>`host_bundle_releases.snapshot_eligible OR ${row.snapshot_eligible}`,
          snapshot_eligibility_source: sql<string>`CASE
            WHEN ${row.snapshot_eligibility_source} = 'explicit' THEN 'explicit'
            ELSE host_bundle_releases.snapshot_eligibility_source
          END`,
        })
          .where(sql<boolean>`host_bundle_releases.bundle_key = ${row.bundle_key}`)
          .where(sql<boolean>`host_bundle_releases.git_commit = ${row.git_commit}`)
          .where(sql<boolean>`host_bundle_releases.git_ref IS NOT DISTINCT FROM ${row.git_ref}`)
          .where(sql<boolean>`host_bundle_releases.build_time::timestamptz = ${row.build_time}::timestamptz`)
          .where(sql<boolean>`host_bundle_releases.checksum_key IS NOT DISTINCT FROM ${row.checksum_key}`)
          .where(sql<boolean>`host_bundle_releases.incremental_manifest_key IS NOT DISTINCT FROM ${row.incremental_manifest_key}`)
          .where(sql<boolean>`host_bundle_releases.incremental_manifest_sha256 IS NOT DISTINCT FROM ${row.incremental_manifest_sha256}`)
          .where(sql<boolean>`host_bundle_releases.sha256 = ${row.sha256}`)
          .where(sql<boolean>`host_bundle_releases.size = ${row.size}`),
      )
      .returningAll()
      .executeTakeFirst();
  if (!saved) {
    throw new HostBundleReleaseConflictError(row.version);
  }
  return mapHostBundleRelease(saved);
}

export async function getHostBundleRelease(
  db: PlatformDB,
  version: string,
): Promise<HostBundleReleaseRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('host_bundle_releases')
    .selectAll()
    .where('version', '=', version)
    .executeTakeFirst();
  return row ? mapHostBundleRelease(row) : undefined;
}

export async function listHostBundleReleases(
  db: PlatformDB,
  limit = 50,
  channel?: string,
): Promise<HostBundleReleaseRecord[]> {
  await db.ready;
  if (channel) {
    const rows = await db.executor
      .selectFrom('host_bundle_release_channels')
      .innerJoin('host_bundle_releases', 'host_bundle_releases.version', 'host_bundle_release_channels.version')
      .selectAll('host_bundle_releases')
      .where('host_bundle_release_channels.channel', '=', channel)
      .orderBy('host_bundle_releases.created_at', 'desc')
      .limit(limit)
      .execute();
    return rows.map(mapHostBundleRelease);
  }
  const rows = await db.executor
    .selectFrom('host_bundle_releases')
    .selectAll()
    .orderBy('created_at', 'desc')
    .limit(limit)
    .execute();
  return rows.map(mapHostBundleRelease);
}

export async function promoteHostBundleChannel(
  db: PlatformDB,
  channel: string,
  version: string,
  updatedAt = new Date().toISOString(),
): Promise<HostBundleChannelRecord> {
  await db.ready;
  return db.transaction((trx) => promoteHostBundleChannelInTransaction(trx, channel, version, updatedAt));
}

export async function promoteHostBundleChannelInTransaction(
  db: PlatformDB,
  channel: string,
  version: string,
  updatedAt: string,
): Promise<HostBundleChannelRecord> {
    const release = await db.executor
      .selectFrom('host_bundle_releases')
      .selectAll()
      .where('version', '=', version)
      .forUpdate()
      .executeTakeFirst();
    if (!release) {
      throw new Error('Cannot promote unknown host bundle release');
    }
    const row = await db.executor
      .insertInto('host_bundle_channels')
      .values({ channel, version, updated_at: updatedAt })
      .onConflict((oc) =>
        oc.column('channel').doUpdateSet({
          version,
          updated_at: updatedAt,
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    await db.executor
      .insertInto('host_bundle_release_channels')
      .values({ channel, version, promoted_at: updatedAt })
      .onConflict((oc) => oc.columns(['channel', 'version']).doUpdateSet({
        promoted_at: updatedAt,
      }))
      .executeTakeFirst();
    return mapHostBundleChannel(row);
}

export async function registerHostBundleRelease(
  db: PlatformDB,
  record: NewHostBundleRelease,
  channel?: string,
): Promise<{ release: HostBundleReleaseRecord; channel?: HostBundleChannelRecord }> {
  await db.ready;
  return db.transaction(async (trx) => {
    const release = await upsertHostBundleRelease(trx, record);
    if (!channel) return { release };
    return {
      release,
      channel: await promoteHostBundleChannelInTransaction(
        trx, channel, release.version, new Date().toISOString(),
      ),
    };
  });
}

export async function getHostBundleChannel(
  db: PlatformDB,
  channel: string,
): Promise<HostBundleChannelRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('host_bundle_channels')
    .selectAll()
    .where('channel', '=', channel)
    .executeTakeFirst();
  return row ? mapHostBundleChannel(row) : undefined;
}

export async function getHostBundleReleaseByChannel(
  db: PlatformDB,
  channel: string,
): Promise<HostBundleReleaseRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('host_bundle_channels')
    .innerJoin('host_bundle_releases', 'host_bundle_releases.version', 'host_bundle_channels.version')
    .selectAll('host_bundle_releases')
    .where('host_bundle_channels.channel', '=', channel)
    .executeTakeFirst();
  return row ? mapHostBundleRelease(row) : undefined;
}

export async function markProviderDeletionCompleted(
  db: PlatformDB,
  id: string,
  completedAt: string,
): Promise<void> {
  await db.ready;
  await db.executor
    .updateTable('provider_deletion_queue')
    .set({ completed_at: completedAt, last_error: null })
    .where('id', '=', id)
    .execute();
}

export async function markProviderDeletionFailed(
  db: PlatformDB,
  id: string,
  attempts: number,
  nextAttemptAt: string,
  lastError: string,
): Promise<void> {
  await db.ready;
  await db.executor
    .updateTable('provider_deletion_queue')
    .set({
      attempts,
      next_attempt_at: nextAttemptAt,
      last_error: lastError,
    })
    .where('id', '=', id)
    .where('completed_at', 'is', null)
    .execute();
}

export async function listStaleUserMachines(
  db: PlatformDB,
  statuses: string[],
  olderThanIso: string,
  limit: number,
): Promise<UserMachineRecord[]> {
  await db.ready;
  if (statuses.length === 0) return [];
  const rows = await db.executor
    .selectFrom('user_machines')
    .selectAll()
    .where('status', 'in', statuses)
    .where('provisioned_at', '<', olderThanIso)
    .where('deleted_at', 'is', null)
    .orderBy('provisioned_at')
    .limit(limit)
    .execute();
  return rows.map(mapUserMachine);
}

// ---------------------------------------------------------------------------
// Onboarding journey (spec 092)
// ---------------------------------------------------------------------------

function isCheckoutAttemptStatus(value: string): value is BillingCheckoutAttemptStatus {
  return value === 'creating' || value === 'open' || value === 'paid' || value === 'expired' || value === 'abandoned';
}

function mapCheckoutAttempt(row: BillingCheckoutAttemptsTable): BillingCheckoutAttemptRecord {
  return {
    id: row.id,
    clerkUserId: row.clerk_user_id,
    stripeSessionId: row.stripe_session_id,
    checkoutUrl: row.checkout_url,
    runtimeSlot: row.runtime_slot,
    planSlug: row.plan_slug as MatrixBillingPlanSlug | null,
    billingInterval: row.billing_interval as MatrixBillingInterval | null,
    regionSlug: row.region_slug,
    serverType: row.server_type,
    trialPeriodDays: row.trial_period_days,
    status: isCheckoutAttemptStatus(row.status) ? row.status : 'open',
    developerTools: parseDeveloperToolsJson(row.developer_tools),
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

export async function insertCheckoutAttempt(
  db: PlatformDB,
  record: {
    id: string;
    clerkUserId: string;
    stripeSessionId: string;
    runtimeSlot?: string;
    planSlug?: MatrixBillingPlanSlug;
    billingInterval?: MatrixBillingInterval;
    regionSlug?: string;
    serverType?: string;
    trialPeriodDays?: number | null;
    createdAt: string;
    status?: BillingCheckoutAttemptStatus;
    resolvedAt?: string | null;
    developerTools?: DeveloperToolId[];
  },
): Promise<void> {
  await db.ready;
  await db.executor
    .insertInto('billing_checkout_attempts')
    .values({
      id: record.id,
      clerk_user_id: record.clerkUserId,
      stripe_session_id: record.stripeSessionId,
      checkout_url: null,
      runtime_slot: record.runtimeSlot ?? 'primary',
      plan_slug: record.planSlug ?? null,
      billing_interval: record.billingInterval ?? null,
      region_slug: record.regionSlug ?? null,
      server_type: record.serverType ?? null,
      trial_period_days: record.trialPeriodDays ?? null,
      developer_tools: serializeDeveloperTools(record.developerTools ?? DEFAULT_DEVELOPER_TOOLS),
      status: record.status ?? 'open',
      created_at: record.createdAt,
      resolved_at: record.resolvedAt ?? null,
    })
    .onConflict((oc) => oc.column('stripe_session_id').doNothing())
    .execute();
}

export interface BillingCheckoutClaimInput {
  id: string;
  clerkUserId: string;
  runtimeSlot: string;
  planSlug: MatrixBillingPlanSlug;
  billingInterval: MatrixBillingInterval;
  regionSlug: string;
  serverType?: string;
  trialPeriodDays?: number | null;
  developerTools?: DeveloperToolId[];
  createdAt: string;
}

export async function claimCheckoutAttempt(
  db: PlatformDB,
  record: BillingCheckoutClaimInput,
  transactionAlreadyOpen = false,
): Promise<{ attempt: BillingCheckoutAttemptRecord; claimed: boolean; selectionMatches: boolean }> {
  await db.ready;
  const row: BillingCheckoutAttemptsTable = {
    id: record.id,
    clerk_user_id: record.clerkUserId,
    stripe_session_id: null,
    checkout_url: null,
    runtime_slot: record.runtimeSlot,
    plan_slug: record.planSlug,
    billing_interval: record.billingInterval,
    region_slug: record.regionSlug,
    server_type: record.serverType ?? null,
    trial_period_days: record.trialPeriodDays ?? null,
    developer_tools: serializeDeveloperTools(record.developerTools ?? DEFAULT_DEVELOPER_TOOLS),
    status: 'creating',
    created_at: record.createdAt,
    resolved_at: null,
  };
  const tryInsert = async (): Promise<BillingCheckoutAttemptsTable | undefined> => db.executor
    .insertInto('billing_checkout_attempts')
    .values(row)
    .onConflict((oc) => oc.doNothing())
    .returningAll()
    .executeTakeFirst();
  const getActiveAttempt = async (): Promise<BillingCheckoutAttemptsTable | undefined> => db.executor
    .selectFrom('billing_checkout_attempts')
    .selectAll()
    .where('clerk_user_id', '=', record.clerkUserId)
    .where('runtime_slot', '=', record.runtimeSlot)
    .where('status', 'in', ['creating', 'open'])
    .orderBy('created_at', 'desc')
    .executeTakeFirst();

  const inserted = await tryInsert();
  if (inserted) return { attempt: mapCheckoutAttempt(inserted), claimed: true, selectionMatches: true };
  let activeRow = await getActiveAttempt();
  if (!activeRow) throw new Error('active checkout claim conflict could not be reconciled');
  const activeAgeMs = Date.parse(record.createdAt) - Date.parse(activeRow.created_at);
  const isExpiredLegacyAttempt = activeRow.status === 'open'
    && (
      activeRow.plan_slug === null
      || activeRow.billing_interval === null
      || activeRow.region_slug === null
    )
    && Number.isFinite(activeAgeMs)
    && activeAgeMs >= CHECKOUT_SESSION_MAX_LIFETIME_MS;
  if (isExpiredLegacyAttempt) {
    // Stripe Checkout Sessions cannot remain payable beyond 24 hours. Legacy
    // rows predate persisted selection fields, so retiring only after that
    // provider window avoids replacing a session that may still accept payment.
    const legacyAttemptId = activeRow.id;
    const legacyCutoff = new Date(
      Date.parse(record.createdAt) - CHECKOUT_SESSION_MAX_LIFETIME_MS,
    ).toISOString();
    const replaceLegacyAttempt = async (trx: PlatformDB) => {
      const retired = await trx.executor
        .updateTable('billing_checkout_attempts')
        .set({ status: 'abandoned', resolved_at: record.createdAt })
        .where('id', '=', legacyAttemptId)
        .where('status', '=', 'open')
        .where('created_at', '<=', legacyCutoff)
        .where((eb) => eb.or([
          eb('plan_slug', 'is', null),
          eb('billing_interval', 'is', null),
          eb('region_slug', 'is', null),
        ]))
        .returning('id')
        .executeTakeFirst();
      if (!retired) return undefined;
      return trx.executor
        .insertInto('billing_checkout_attempts')
        .values(row)
        .onConflict((oc) => oc.doNothing())
        .returningAll()
        .executeTakeFirst();
    };
    const replacement = transactionAlreadyOpen
      ? await replaceLegacyAttempt(db)
      : await db.transaction(replaceLegacyAttempt);
    if (replacement) {
      return { attempt: mapCheckoutAttempt(replacement), claimed: true, selectionMatches: true };
    }
    activeRow = await getActiveAttempt();
    if (!activeRow) throw new Error('legacy checkout replacement conflict could not be reconciled');
  }
  const sameSelection = activeRow.plan_slug === record.planSlug
    && activeRow.billing_interval === record.billingInterval
    && activeRow.region_slug === record.regionSlug
    && activeRow.server_type === (record.serverType ?? null)
    && activeRow.trial_period_days === (record.trialPeriodDays ?? null)
    && activeRow.developer_tools
      === serializeDeveloperTools(record.developerTools ?? DEFAULT_DEVELOPER_TOOLS);
  const retryAgeMs = Date.parse(record.createdAt) - Date.parse(activeRow.created_at);
  const withinIdempotencyWindow = Number.isFinite(retryAgeMs)
    && retryAgeMs >= 0
    && retryAgeMs <= CHECKOUT_IDEMPOTENCY_RETRY_WINDOW_MS;
  if (activeRow.status === 'creating' && sameSelection && withinIdempotencyWindow) {
    // A previous Stripe response may have timed out after creating the
    // provider session. Re-run with this persisted attempt id so Stripe's
    // idempotency key reconciles the ambiguous result instead of creating a
    // second Checkout Session.
    return { attempt: mapCheckoutAttempt(activeRow), claimed: true, selectionMatches: true };
  }
  // Never replace a provider session that may still be payable, and never
  // retry after Stripe may have pruned the idempotency key. Resolution then
  // requires the signed provider lifecycle or an operator reconciliation.
  return { attempt: mapCheckoutAttempt(activeRow), claimed: false, selectionMatches: sameSelection };
}

export async function claimCardTrialCheckoutAttempt(
  db: PlatformDB,
  record: Omit<BillingCheckoutClaimInput, 'trialPeriodDays'>,
  durationDays: number,
): Promise<{ attempt: BillingCheckoutAttemptRecord; claimed: boolean; selectionMatches: boolean }> {
  await db.ready;
  return db.transaction(async (trx) => {
    await trx.executor
      .insertInto('billing_trial_accounts')
      .values({
        clerk_user_id: record.clerkUserId,
        trial_checkout_attempt_id: null,
        consumed_at: null,
        updated_at: record.createdAt,
      })
      .onConflict((oc) => oc.column('clerk_user_id').doNothing())
      .execute();
    const account = await trx.executor
      .selectFrom('billing_trial_accounts')
      .selectAll()
      .where('clerk_user_id', '=', record.clerkUserId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    let reservedAttempt: BillingCheckoutAttemptsTable | undefined;
    if (account.trial_checkout_attempt_id) {
      reservedAttempt = await trx.executor
        .selectFrom('billing_checkout_attempts')
        .selectAll()
        .where('id', '=', account.trial_checkout_attempt_id)
        .executeTakeFirst();
      if (!reservedAttempt || !['creating', 'open'].includes(reservedAttempt.status)) {
        await trx.executor
          .updateTable('billing_trial_accounts')
          .set({ trial_checkout_attempt_id: null, updated_at: record.createdAt })
          .where('clerk_user_id', '=', record.clerkUserId)
          .where('trial_checkout_attempt_id', '=', account.trial_checkout_attempt_id)
          .execute();
        reservedAttempt = undefined;
      }
    }
    const historicalSubscription = await trx.executor
      .selectFrom('billing_subscriptions')
      .select('stripe_subscription_id')
      .where('clerk_user_id', '=', record.clerkUserId)
      .limit(1)
      .executeTakeFirst();
    const trialPeriodDays = reservedAttempt?.trial_period_days
      ?? (!account.consumed_at && !historicalSubscription ? durationDays : null);
    const result = await claimCheckoutAttempt(trx, { ...record, trialPeriodDays }, true);
    if (result.attempt.trialPeriodDays) {
      await trx.executor
        .updateTable('billing_trial_accounts')
        .set({
          trial_checkout_attempt_id: result.attempt.id,
          updated_at: record.createdAt,
        })
        .where('clerk_user_id', '=', record.clerkUserId)
        .where('consumed_at', 'is', null)
        .execute();
    }
    return result;
  });
}

export async function isCardTrialOfferEligible(
  db: PlatformDB,
  clerkUserId: string,
): Promise<boolean> {
  await db.ready;
  const [account, historicalSubscription] = await Promise.all([
    db.executor
      .selectFrom('billing_trial_accounts')
      .select(['consumed_at', 'trial_checkout_attempt_id'])
      .where('clerk_user_id', '=', clerkUserId)
      .executeTakeFirst(),
    db.executor
      .selectFrom('billing_subscriptions')
      .select('stripe_subscription_id')
      .where('clerk_user_id', '=', clerkUserId)
      .limit(1)
      .executeTakeFirst(),
  ]);
  return !account?.consumed_at && !historicalSubscription;
}

export async function consumeCardTrial(
  db: PlatformDB,
  clerkUserId: string,
  consumedAt: string,
): Promise<void> {
  await db.ready;
  await db.executor
    .insertInto('billing_trial_accounts')
    .values({
      clerk_user_id: clerkUserId,
      trial_checkout_attempt_id: null,
      consumed_at: consumedAt,
      updated_at: consumedAt,
    })
    .onConflict((oc) => oc.column('clerk_user_id').doUpdateSet({
      trial_checkout_attempt_id: null,
      consumed_at: sql<string>`COALESCE(billing_trial_accounts.consumed_at, ${consumedAt})`,
      updated_at: consumedAt,
    }))
    .execute();
}

export async function finalizeCheckoutAttempt(
  db: PlatformDB,
  id: string,
  stripeSessionId: string,
  checkoutUrl: string,
): Promise<boolean> {
  await db.ready;
  const updated = await db.executor
    .updateTable('billing_checkout_attempts')
    .set({ stripe_session_id: stripeSessionId, checkout_url: checkoutUrl, status: 'open' })
    .where('id', '=', id)
    .where('status', '=', 'creating')
    .returning('id')
    .executeTakeFirst();
  if (updated) return true;
  const existing = await db.executor
    .selectFrom('billing_checkout_attempts')
    .select(['stripe_session_id', 'checkout_url', 'status'])
    .where('id', '=', id)
    .executeTakeFirst();
  return existing?.status === 'open'
    && existing.stripe_session_id === stripeSessionId
    && existing.checkout_url === checkoutUrl;
}

export async function abandonCreatingCheckoutAttempt(
  db: PlatformDB,
  id: string,
  resolvedAt: string,
): Promise<boolean> {
  await db.ready;
  return db.transaction(async (trx) => {
    const abandoned = await trx.executor
      .updateTable('billing_checkout_attempts')
      .set({ status: 'abandoned', resolved_at: resolvedAt })
      .where('id', '=', id)
      .where('status', '=', 'creating')
      .where('stripe_session_id', 'is', null)
      .returning('id')
      .executeTakeFirst();
    if (!abandoned) return false;
    await trx.executor
      .updateTable('billing_trial_accounts')
      .set({ trial_checkout_attempt_id: null, updated_at: resolvedAt })
      .where('trial_checkout_attempt_id', '=', id)
      .execute();
    return true;
  });
}

export async function getLatestCheckoutAttempt(
  db: PlatformDB,
  clerkUserId: string,
): Promise<BillingCheckoutAttemptRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('billing_checkout_attempts')
    .selectAll()
    .where('clerk_user_id', '=', clerkUserId)
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  return row ? mapCheckoutAttempt(row) : undefined;
}

export async function getActiveCheckoutAttempt(
  db: PlatformDB,
  clerkUserId: string,
  runtimeSlot: string,
): Promise<BillingCheckoutAttemptRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('billing_checkout_attempts')
    .selectAll()
    .where('clerk_user_id', '=', clerkUserId)
    .where('runtime_slot', '=', runtimeSlot)
    .where('status', 'in', ['creating', 'open'])
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  return row ? mapCheckoutAttempt(row) : undefined;
}

/**
 * The attempt that governs payment settling: a confirmed `paid` attempt always
 * wins over a newer still-`open` one, so a paying user who opens a second
 * checkout before activation is never bounced back to plan selection. Terminal
 * (`expired`/`abandoned`) attempts never sustain settling and are excluded.
 */
export async function getSettlingCheckoutAttempt(
  db: PlatformDB,
  clerkUserId: string,
  runtimeSlot?: string,
): Promise<BillingCheckoutAttemptRecord | undefined> {
  await db.ready;
  let query = db.executor
    .selectFrom('billing_checkout_attempts')
    .selectAll()
    .where('clerk_user_id', '=', clerkUserId)
    .where('status', 'in', ['paid', 'open']);
  if (runtimeSlot) query = query.where('runtime_slot', '=', runtimeSlot);
  const row = await query
    .orderBy(sql`CASE status WHEN 'paid' THEN 0 ELSE 1 END`)
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  return row ? mapCheckoutAttempt(row) : undefined;
}

/** Resolves an open checkout attempt by Stripe session id. Only transitions
 * `open` rows so a later/duplicate webhook cannot rewrite a terminal state. */
export async function resolveCheckoutAttempt(
  db: PlatformDB,
  stripeSessionId: string,
  status: 'paid' | 'expired',
  resolvedAt: string,
  transactionAlreadyOpen = false,
): Promise<void> {
  await db.ready;
  const resolve = async (trx: PlatformDB) => {
    const updated = await trx.executor
      .updateTable('billing_checkout_attempts')
      .set({ status, resolved_at: resolvedAt })
      .where('stripe_session_id', '=', stripeSessionId)
      .where('status', '=', 'open')
      .returning('id')
      .executeTakeFirst();
    if (status === 'expired' && updated) {
      await trx.executor
        .updateTable('billing_trial_accounts')
        .set({ trial_checkout_attempt_id: null, updated_at: resolvedAt })
        .where('trial_checkout_attempt_id', '=', updated.id)
        .execute();
    } else if (status === 'paid' && updated) {
      await trx.executor
        .updateTable('billing_trial_accounts')
        .set({
          trial_checkout_attempt_id: null,
          consumed_at: sql<string>`COALESCE(billing_trial_accounts.consumed_at, ${resolvedAt})`,
          updated_at: resolvedAt,
        })
        .where('trial_checkout_attempt_id', '=', updated.id)
        .execute();
    }
  };
  if (transactionAlreadyOpen) await resolve(db);
  else await db.transaction(resolve);
}

/** Sweeps stale open provider sessions after their payment window has elapsed.
 * `creating` claims are deliberately retained: an ambiguous Stripe response
 * must be retried with the same persisted idempotency key. */
export async function sweepStaleCheckoutAttempts(
  db: PlatformDB,
  openOlderThanIso: string,
  resolvedAt: string,
  limit: number,
): Promise<number> {
  await db.ready;
  return db.transaction(async (trx) => {
    const stale = await trx.executor
      .selectFrom('billing_checkout_attempts')
      .select('id')
      .where('status', '=', 'open')
      .where('created_at', '<', openOlderThanIso)
      .limit(limit)
      .execute();
    if (stale.length === 0) return 0;
    const updated = await trx.executor
      .updateTable('billing_checkout_attempts')
      .set({ status: 'abandoned', resolved_at: resolvedAt })
      .where('id', 'in', stale.map((r) => r.id))
      // Re-check status in the UPDATE: a concurrent webhook may have resolved the
      // row to paid/expired between the SELECT and here; never overwrite it.
      .where('status', '=', 'open')
      .returning('id')
      .execute();
    if (updated.length > 0) {
      await trx.executor
        .updateTable('billing_trial_accounts')
        .set({ trial_checkout_attempt_id: null, updated_at: resolvedAt })
        .where('trial_checkout_attempt_id', 'in', updated.map((row) => row.id))
        .execute();
    }
    return updated.length;
  });
}

function parseFirstRunSteps(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch (err: unknown) {
    // Corrupt persisted JSON → treat as no steps rather than failing the read.
    void err;
    return {};
  }
}

function mapFirstRun(row: OnboardingFirstRunTable): OnboardingFirstRunRecord {
  return {
    clerkUserId: row.clerk_user_id,
    completedAt: row.completed_at,
    goal: row.goal,
    steps: parseFirstRunSteps(row.steps),
    source: row.source,
  };
}

export async function getOnboardingFirstRun(
  db: PlatformDB,
  clerkUserId: string,
): Promise<OnboardingFirstRunRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('onboarding_first_run')
    .selectAll()
    .where('clerk_user_id', '=', clerkUserId)
    .executeTakeFirst();
  return row ? mapFirstRun(row) : undefined;
}

/** Authoritative write-behind from the gateway: latest completion wins. */
export async function upsertOnboardingFirstRun(
  db: PlatformDB,
  record: NewOnboardingFirstRun,
): Promise<void> {
  await db.ready;
  const values = {
    clerk_user_id: record.clerkUserId,
    completed_at: record.completedAt,
    goal: record.goal ?? null,
    steps: JSON.stringify(record.steps ?? {}),
    source: record.source,
  };
  await db.executor
    .insertInto('onboarding_first_run')
    .values(values)
    .onConflict((oc) =>
      oc.column('clerk_user_id').doUpdateSet({
        completed_at: values.completed_at,
        goal: values.goal,
        steps: values.steps,
        source: values.source,
      }),
    )
    .execute();
}

/** Best-effort legacy backfill: only fills a missing record, never overwrites
 * an authoritative gateway write-behind (spec 092 R4). */
export async function insertOnboardingFirstRunIfAbsent(
  db: PlatformDB,
  record: NewOnboardingFirstRun,
): Promise<void> {
  await db.ready;
  await db.executor
    .insertInto('onboarding_first_run')
    .values({
      clerk_user_id: record.clerkUserId,
      completed_at: record.completedAt,
      goal: record.goal ?? null,
      steps: JSON.stringify(record.steps ?? {}),
      source: record.source,
    })
    .onConflict((oc) => oc.column('clerk_user_id').doNothing())
    .execute();
}

/** Running machines whose owner has no first-run record yet (backfill candidates). */
export async function listRunningMachinesMissingFirstRun(
  db: PlatformDB,
  limit: number,
): Promise<UserMachineRecord[]> {
  await db.ready;
  const rows = await db.executor
    .selectFrom('user_machines')
    .selectAll('user_machines')
    .leftJoin('onboarding_first_run', 'onboarding_first_run.clerk_user_id', 'user_machines.clerk_user_id')
    .where('user_machines.status', '=', 'running')
    .where('user_machines.deleted_at', 'is', null)
    .where('onboarding_first_run.clerk_user_id', 'is', null)
    .orderBy('user_machines.provisioned_at')
    .limit(limit)
    .execute();
  return rows.map(mapUserMachine);
}

export async function getLatestJourneyEvent(
  db: PlatformDB,
  clerkUserId: string,
): Promise<OnboardingJourneyEventRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('onboarding_journey_events')
    .selectAll()
    .where('clerk_user_id', '=', clerkUserId)
    .orderBy('at', 'desc')
    .executeTakeFirst();
  return row
    ? {
        id: row.id,
        clerkUserId: row.clerk_user_id,
        fromPhase: row.from_phase,
        toPhase: row.to_phase,
        detail: row.detail,
        at: row.at,
      }
    : undefined;
}

export async function appendJourneyEvent(
  db: PlatformDB,
  record: { id: string; clerkUserId: string; fromPhase: string | null; toPhase: string; detail: string | null; at: string },
): Promise<void> {
  await db.ready;
  await db.executor
    .insertInto('onboarding_journey_events')
    .values({
      id: record.id,
      clerk_user_id: record.clerkUserId,
      from_phase: record.fromPhase,
      to_phase: record.toPhase,
      detail: record.detail,
      at: record.at,
    })
    .execute();
}

export async function allocatePort(db: PlatformDB, basePort: number, handle: string): Promise<number> {
  await db.ready;
  for (let attempt = 0; attempt < 32; attempt++) {
    const existing = await db.executor
      .selectFrom('port_assignments')
      .select('port')
      .where('handle', '=', handle)
      .executeTakeFirst();
    if (existing) return existing.port;

    const result = await db.executor
      .selectFrom('port_assignments')
      .select((eb) => eb.fn.max<number>('port').as('max_port'))
      .executeTakeFirst();
    const nextPort = result?.max_port ? Number(result.max_port) + 1 : basePort;
    const inserted = await db.executor
      .insertInto('port_assignments')
      .values({ port: nextPort, handle })
      .onConflict((oc) => oc.doNothing())
      .returning('port')
      .executeTakeFirst();
    if (inserted) return inserted.port;
  }
  throw new Error('Unable to allocate platform port after concurrent retries');
}

export async function releasePort(db: PlatformDB, handle: string): Promise<void> {
  await db.ready;
  await db.executor.deleteFrom('port_assignments').where('handle', '=', handle).execute();
}
