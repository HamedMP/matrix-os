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
import { runPlatformMigration } from './migration-runner.js';
import { migratePlatformSchema } from './database/migrate.js';
import { parseStringArray } from './database/json.js';
import { mapUserMachine, type UserMachineProvisioningClass } from './database/user-machine-records.js';
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

export interface UserMachinesTable {
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

export interface SpeechOperationsTable {
  owner_id: string;
  machine_id: string;
  runtime_slot: string;
  operation_id: string;
  source_kind: string | null;
  content_fingerprint: string | null;
  policy_revision: string | null;
  adapter_id: string | null;
  model_id: string | null;
  funding_reservation_id: string | null;
  execution_state: string;
  cancellation_requested: boolean;
  tombstone: boolean;
  dispatch_claimed_at: string | null;
  safe_outcome_code: string | null;
  audio_duration_ms: number | null;
  reserved_microusd: number | null;
  actual_microusd: number | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

export interface AiCreditCheckoutClaimsTable {
  request_id: string;
  owner_id: string;
  machine_id: string;
  runtime_slot: string;
  package_id: string;
  stripe_price_id: string;
  amount_microusd: number;
  amount_cents: number;
  currency: string;
  automatic_tax: boolean;
  idempotency_key: string;
  stripe_session_id: string | null;
  checkout_url: string | null;
  payment_intent_id: string | null;
  charge_id: string | null;
  status: string;
  granted_microusd: number;
  reversed_microusd: number;
  reversal_debt_microusd: number;
  refunded_at: string | null;
  dispute_status: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

export interface AiFundedCreditRestrictionsTable {
  machine_id: string;
  owner_id: string;
  runtime_slot: string;
  debt_microusd: number;
  frozen: boolean;
  updated_at: string;
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

export interface HostBundleReleasesTable {
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

export interface HostBundleChannelsTable {
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

export interface ProviderDeletionQueueTable {
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

export interface BillingCustomersTable {
  clerk_user_id: string;
  stripe_customer_id: string;
  created_at: string;
  updated_at: string;
}

export interface BillingEntitlementsTable {
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

export interface BillingSubscriptionsTable {
  stripe_subscription_id: string;
  stripe_customer_id: string;
  clerk_user_id: string;
  runtime_slot: string;
  plan_slug: string;
  stripe_price_id: string;
  billing_interval: string | null;
  price_unit_amount_minor: number | null;
  price_currency: string | null;
  price_interval_count: number | null;
  price_quantity: number | null;
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

export interface BillingEntitlementOverridesTable {
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

export interface BillingWebhookEventsTable {
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

export interface BillingCheckoutAttemptsTable {
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
  speech_operations: SpeechOperationsTable;
  ai_credit_checkout_claims: AiCreditCheckoutClaimsTable;
  ai_funded_credit_restrictions: AiFundedCreditRestrictionsTable;
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
  transactionScoped = false,
): PlatformDB {
  const wrapped: PlatformDB = {
    kysely,
    executor,
    ready,
    async transaction(fn) {
      await ready;
      if (transactionScoped) return fn(wrapped);
      return kysely.transaction().execute((trx) =>
        fn(wrapDb(kysely, trx, Promise.resolve(), destroyFn, true)),
      );
    },
    // The root PlatformDB owns Kysely/the pool. A transaction-scoped wrapper
    // may be passed through several repository layers, but must never close
    // that shared resource.
    destroy: transactionScoped ? async () => undefined : destroyFn,
  };
  return wrapped;
}

async function migrate(db: Kysely<PlatformDatabase>): Promise<void> {
  await runPlatformMigration(db, migrateSchema);
}

async function migrateSchema(db: Executor): Promise<void> {
  await migratePlatformSchema(db);
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

export async function listActivePlatformUsersByNormalizedHandle(
  db: PlatformDB,
  normalizedHandle: string,
): Promise<PlatformUserRecord[]> {
  await db.ready;
  const rows = await db.executor
    .selectFrom('users')
    .selectAll()
    .where('handle', '=', normalizedHandle)
    .where('status', '=', 'active')
    .limit(2)
    .execute();
  return rows.map(mapPlatformUser);
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

// S01 / T007: focused database modules; db.ts remains the composition and export entrypoint.
export {
  UserMachineProvisioningClassSchema,
  parseNullableProviderActionId,
} from './database/user-machine-records.js';
export type { UserMachineProvisioningClass } from './database/user-machine-records.js';
export {
  lockUserMachineProvisioning,
  insertUserMachine,
  getUserMachine,
  getActiveUserMachineByClerkId,
  accessibleUserMachinePredicate,
  getAccessibleActiveUserMachineByClerkId,
  getActiveUserMachineByHandle,
  getRunningUserMachineByHandle,
  getRunningUserMachineByClerkId,
  getAccessibleRunningUserMachineByClerkId,
  getAccessibleRunningUserMachineByClerkIdForUpdate,
  getRunningUserMachineByClerkIdForUpdate,
  listUserMachines,
  listActiveUserMachinesByClerkId,
  listAccessibleActiveUserMachinesByClerkId,
  listNonDeletedUserMachinesByClerkId,
  updateUserMachine,
  listRunningUserMachines,
  listAllUserMachines,
  listStaleUserMachines,
} from './database/user-machines.js';
export {
  claimRunningUserMachineResize,
  completeUserMachineResize,
  claimRunningUserMachineBillingSuspend,
  completeUserMachineBillingSuspend,
  claimSuspendedUserMachineBillingResume,
  completeUserMachineBillingResume,
  listStaleResizingUserMachines,
  completeUserMachineRegistration,
  claimUserMachineRecovery,
  retireUserMachine,
  claimUserMachineDelete,
  softDeleteUserMachine,
  insertProviderDeletion,
  listPendingProviderDeletions,
  markProviderDeletionCompleted,
  markProviderDeletionFailed,
} from './database/user-machine-lifecycle.js';
export {
  HostBundleReleaseConflictError,
  upsertHostBundleRelease,
  getHostBundleRelease,
  listHostBundleReleases,
  promoteHostBundleChannel,
  promoteHostBundleChannelInTransaction,
  registerHostBundleRelease,
  getHostBundleChannel,
  getHostBundleReleaseByChannel,
} from './database/host-bundles.js';
export {
  upsertBillingCustomer,
  insertBillingCustomerIfAbsent,
  getBillingCustomerByClerkUserId,
  getBillingCustomerByStripeCustomerId,
  hasBillingSubscriptionHistory,
  upsertBillingSubscription,
  persistBillingSubscriptionPriceSnapshot,
  getBillingSubscription,
  getBillingSubscriptionByStripeId,
  projectTrialInvoiceEvent,
  listCurrentBillingSubscriptions,
} from './database/billing.js';
export type { TrialInvoiceEventProjectionResult } from './database/billing.js';
export {
  upsertBillingEntitlement,
  getBillingEntitlement,
  upsertBillingOverride,
  getBillingOverride,
  getBillingEntitlementState,
  revokeBillingOverride,
  insertBillingWebhookEvent,
  getBillingWebhookEvent,
} from './database/billing-entitlements.js';
export {
  insertCheckoutAttempt,
  claimCheckoutAttempt,
  claimCardTrialCheckoutAttempt,
  isCardTrialOfferEligible,
  consumeCardTrial,
  finalizeCheckoutAttempt,
  abandonCreatingCheckoutAttempt,
  getLatestCheckoutAttempt,
  getActiveCheckoutAttempt,
  getSettlingCheckoutAttempt,
  resolveCheckoutAttempt,
  sweepStaleCheckoutAttempts,
} from './database/checkout-attempts.js';
export type { BillingCheckoutClaimInput } from './database/checkout-attempts.js';
