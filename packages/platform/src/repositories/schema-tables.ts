/**
 * Platform Postgres table + database types.
 *
 * Extracted from ../db.ts (Phase 1-A2). Pure move: no logic changes.
 */
import { type Generated, type Kysely, type Transaction } from 'kysely';

export type Executor = Kysely<PlatformDatabase> | Transaction<PlatformDatabase>;


export interface ContainersTable {
  handle: string;
  clerk_user_id: string;
  container_id: string | null;
  port: number;
  shell_port: number;
  status: string;
  created_at: string;
  last_active: string;
}

export interface UsersTable {
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

export interface HostBundleReleaseChannelsTable {
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

export interface BillingRuntimeActionsTable {
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

export interface PortAssignmentsTable {
  port: number;
  handle: string | null;
}

export interface DeviceCodesTable {
  device_code: string;
  user_code: string;
  clerk_user_id: string | null;
  runtime_slot: string | null;
  runtime_handle: string | null;
  expires_at: number;
  last_polled_at: number | null;
  created_at: number;
}

export interface MatrixUsersTable {
  handle: string;
  human_matrix_id: string;
  ai_matrix_id: string;
  human_access_token: string;
  ai_access_token: string;
  created_at: string;
}

export interface AppsRegistryTable {
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

export interface AppRatingsTable {
  app_id: string;
  user_id: string;
  rating: number;
  review: string | null;
  created_at: string;
}

export interface AppInstallsTable {
  app_id: string;
  user_id: string;
  installed_at: string;
}

export interface SocialPostsTable {
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

export interface SocialCommentsTable {
  id: string;
  post_id: string;
  author_id: string;
  content: string;
  created_at: string;
}

export interface SocialLikesTable {
  post_id: string;
  user_id: string;
  created_at: string;
}

export interface SocialFollowsTable {
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

export interface BillingTrialAccountsTable {
  clerk_user_id: string;
  trial_checkout_attempt_id: string | null;
  consumed_at: string | null;
  updated_at: string;
}

export interface OnboardingFirstRunTable {
  clerk_user_id: string;
  completed_at: string;
  goal: string | null;
  steps: string;
  source: string;
}

export interface OnboardingJourneyEventsTable {
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
