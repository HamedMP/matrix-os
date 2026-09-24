import { sql } from 'kysely';
import { ensureFundedReservationIndexes } from '../../ai-funded-reservation-indexes.js';
import type { PlatformMigrationExecutor } from '../migration-types.js';

/** Extracted verbatim from packages/platform/src/db.ts migrateSchema (S01 / T007). Order is preserved by migrate.ts. */
export async function migrateAiFunded(db: PlatformMigrationExecutor): Promise<void> {
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
      manual_review_evidence_ref TEXT,
      manual_review_actor TEXT,
      manual_reviewed_at TEXT,
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
  await sql`ALTER TABLE ai_funded_usage_reservations ADD COLUMN IF NOT EXISTS manual_review_evidence_ref TEXT`.execute(db);
  await sql`ALTER TABLE ai_funded_usage_reservations ADD COLUMN IF NOT EXISTS manual_review_actor TEXT`.execute(db);
  await sql`ALTER TABLE ai_funded_usage_reservations ADD COLUMN IF NOT EXISTS manual_reviewed_at TEXT`.execute(db);
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
  await ensureFundedReservationIndexes(db);
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
}
