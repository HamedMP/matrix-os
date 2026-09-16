/**
 * Platform schema migration (DDL).
 *
 * Extracted from ../db.ts (Phase 1-A2). Pure move: no logic changes.
 */
import { Kysely, sql } from 'kysely';
import { runPlatformMigration } from '../migration-runner.js';
import type { Executor, PlatformDatabase, PlatformDB } from './schema-tables.js';

export function wrapDb(
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

export async function migrate(db: Kysely<PlatformDatabase>): Promise<void> {
  await runPlatformMigration(db, migrateSchema);
}

async function migrateSchema(db: Executor): Promise<void> {
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
        CHECK (kind IN ('promotional_grant', 'addon_grant', 'promotional_debit', 'addon_debit', 'promotional_expiry', 'addon_reversal', 'usage_shortfall')),
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
        OR (kind IN ('promotional_expiry', 'addon_reversal') AND amount_microusd < 0 AND reservation_id IS NULL AND period_start IS NULL AND expires_at IS NULL)
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
          CHECK (kind IN ('promotional_grant', 'addon_grant', 'promotional_debit', 'addon_debit', 'promotional_expiry', 'addon_reversal', 'usage_shortfall'));
      EXCEPTION WHEN duplicate_object THEN NULL;
      END;
      BEGIN
        ALTER TABLE ai_funded_credit_ledger
          ADD CONSTRAINT ai_funded_credit_ledger_shape_v3_check CHECK (
            (kind IN ('promotional_grant', 'addon_grant') AND amount_microusd > 0 AND reservation_id IS NULL AND period_start IS NULL)
            OR (kind IN ('promotional_debit', 'addon_debit') AND amount_microusd < 0 AND reservation_id IS NOT NULL AND period_start IS NOT NULL)
            OR (kind = 'usage_shortfall' AND amount_microusd < 0 AND reservation_id IS NOT NULL AND period_start IS NOT NULL AND expires_at IS NULL)
            OR (kind IN ('promotional_expiry', 'addon_reversal') AND amount_microusd < 0 AND reservation_id IS NULL AND period_start IS NULL AND expires_at IS NULL)
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
    CREATE TABLE IF NOT EXISTS ai_credit_checkout_claims (
      request_id TEXT PRIMARY KEY CHECK (length(request_id) <= 64),
      owner_id TEXT NOT NULL CHECK (length(owner_id) <= 160),
      machine_id TEXT NOT NULL REFERENCES user_machines(machine_id) ON UPDATE CASCADE,
      runtime_slot TEXT NOT NULL CHECK (length(runtime_slot) <= 80),
      package_id TEXT NOT NULL CHECK (package_id IN ('usd_5', 'usd_10', 'usd_25')),
      stripe_price_id TEXT NOT NULL CHECK (length(stripe_price_id) <= 255),
      amount_microusd BIGINT NOT NULL CHECK (amount_microusd > 0),
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      currency TEXT NOT NULL CHECK (currency = 'usd'),
      automatic_tax BOOLEAN NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) <= 160),
      stripe_session_id TEXT UNIQUE,
      checkout_url TEXT CHECK (checkout_url IS NULL OR length(checkout_url) <= 2048),
      payment_intent_id TEXT UNIQUE,
      charge_id TEXT UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('creating', 'open', 'awaiting_payment', 'paid', 'payment_failed', 'expired')),
      granted_microusd BIGINT NOT NULL DEFAULT 0 CHECK (granted_microusd >= 0),
      reversed_microusd BIGINT NOT NULL DEFAULT 0 CHECK (reversed_microusd >= 0),
      reversal_debt_microusd BIGINT NOT NULL DEFAULT 0 CHECK (reversal_debt_microusd >= 0),
      refunded_at TEXT,
      dispute_status TEXT NOT NULL DEFAULT 'none' CHECK (dispute_status IN ('none', 'open', 'won', 'lost')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_ai_credit_checkout_claims_runtime_created
    ON ai_credit_checkout_claims(owner_id, runtime_slot, created_at DESC)
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_credit_checkout_claims_active_runtime
    ON ai_credit_checkout_claims(owner_id, runtime_slot)
    WHERE status IN ('creating', 'open', 'awaiting_payment')
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS ai_funded_credit_restrictions (
      machine_id TEXT PRIMARY KEY REFERENCES user_machines(machine_id) ON UPDATE CASCADE ON DELETE CASCADE,
      owner_id TEXT NOT NULL,
      runtime_slot TEXT NOT NULL,
      debt_microusd BIGINT NOT NULL DEFAULT 0 CHECK (debt_microusd >= 0),
      frozen BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TEXT NOT NULL
    )
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
      price_unit_amount_minor INTEGER,
      price_currency TEXT,
      price_interval_count INTEGER,
      price_quantity INTEGER,
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
  await sql`ALTER TABLE billing_subscriptions ADD COLUMN IF NOT EXISTS price_unit_amount_minor INTEGER`.execute(db);
  await sql`ALTER TABLE billing_subscriptions ADD COLUMN IF NOT EXISTS price_currency TEXT`.execute(db);
  await sql`ALTER TABLE billing_subscriptions ADD COLUMN IF NOT EXISTS price_interval_count INTEGER`.execute(db);
  await sql`ALTER TABLE billing_subscriptions ADD COLUMN IF NOT EXISTS price_quantity INTEGER`.execute(db);
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
