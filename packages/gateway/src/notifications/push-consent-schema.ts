import { sql, type Transaction } from "kysely";
import type { NotificationDatabase } from "./schema.js";

export const MAX_PUSH_CONSENTS_PER_OWNER = 64;

export async function createPushConsentSchema(trx: Transaction<NotificationDatabase>): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS notification_push_consents (
    identity TEXT NOT NULL CHECK (char_length(identity) BETWEEN 1 AND 512),
    owner_id TEXT NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 128),
    delivery_token TEXT NOT NULL CHECK (char_length(delivery_token) BETWEEN 1 AND 512),
    enabled BOOLEAN NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, identity)
  )`.execute(trx);
  await sql`CREATE INDEX IF NOT EXISTS idx_notification_push_consents_owner_updated
    ON notification_push_consents(owner_id, updated_at DESC)`.execute(trx);
  await sql`CREATE INDEX IF NOT EXISTS idx_notification_push_consents_owner_delivery
    ON notification_push_consents(owner_id, delivery_token)`.execute(trx);
  // One durable guard per owner survives phone-cap eviction. Old writers send
  // only a delivery token, so an unknown rotation cannot disprove an opt-out.
  await sql`CREATE TABLE IF NOT EXISTS notification_push_consent_owners (
    owner_id TEXT PRIMARY KEY CHECK (char_length(owner_id) BETWEEN 1 AND 128),
    legacy_import_blocked BOOLEAN NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`.execute(trx);
  await sql`ALTER TABLE notification_push_tokens ADD COLUMN IF NOT EXISTS identity TEXT
    CHECK (identity IS NULL OR char_length(identity) BETWEEN 1 AND 512)`.execute(trx);
}

export async function trimPushConsents(trx: Transaction<NotificationDatabase>, ownerId?: string): Promise<void> {
  // Bootstrap and runtime share the same cap. Partitioning also bounds legacy
  // imports from an older build that did not know about durable consent.
  await sql`WITH ranked AS (
    SELECT owner_id, identity, row_number() OVER (
      PARTITION BY owner_id ORDER BY updated_at DESC, identity DESC
    ) AS position FROM notification_push_consents
    ${ownerId === undefined ? sql`` : sql`WHERE owner_id = ${ownerId}`}
  ), removed_delivery AS (
    DELETE FROM notification_push_tokens AS delivery USING ranked
    WHERE ranked.position > ${MAX_PUSH_CONSENTS_PER_OWNER}
      AND delivery.owner_id = ranked.owner_id AND delivery.identity = ranked.identity
  ) DELETE FROM notification_push_consents AS consent USING ranked
    WHERE ranked.position > ${MAX_PUSH_CONSENTS_PER_OWNER}
      AND consent.owner_id = ranked.owner_id AND consent.identity = ranked.identity`.execute(trx);
}

/** Called at every bootstrap, under the exclusive schema advisory lock. */
export async function reconcileLegacyPushTokens(trx: Transaction<NotificationDatabase>): Promise<void> {
  const legacy = await trx.selectFrom("notification_push_tokens").select("token")
    .where("identity", "is", null).limit(1).executeTakeFirst();
  if (!legacy) return;
  // Current consent writes take the shared schema lock before their owner
  // lock. This table lock also serializes older writers, which know neither.
  await sql`LOCK TABLE notification_push_tokens IN SHARE ROW EXCLUSIVE MODE`.execute(trx);
  await sql`DELETE FROM notification_push_tokens AS delivery
    WHERE delivery.identity IS NULL
      AND EXISTS (SELECT 1 FROM notification_push_consent_owners AS owner_guard
        WHERE owner_guard.owner_id = delivery.owner_id AND owner_guard.legacy_import_blocked)
      AND NOT EXISTS (SELECT 1 FROM notification_push_consents AS consent
        WHERE consent.owner_id = delivery.owner_id
          AND (consent.identity = delivery.token OR consent.delivery_token = delivery.token))`.execute(trx);
  // Prefer an existing off alias. Only an actual legacy row for an owner with
  // no opt-out history can establish previously unknown positive consent.
  await sql`WITH legacy AS (
    UPDATE notification_push_tokens AS delivery SET identity = COALESCE((
      SELECT consent.identity FROM notification_push_consents AS consent
      WHERE consent.owner_id = delivery.owner_id
        AND (consent.identity = delivery.token OR consent.delivery_token = delivery.token)
      ORDER BY consent.enabled ASC, consent.updated_at DESC, consent.identity DESC LIMIT 1
    ), delivery.token) WHERE delivery.identity IS NULL
    RETURNING delivery.identity, delivery.owner_id, delivery.token, delivery.last_seen_at
  ) INSERT INTO notification_push_consents (identity, owner_id, delivery_token, enabled, updated_at)
    SELECT DISTINCT ON (owner_id, identity) identity, owner_id, token, true, last_seen_at
    FROM legacy ORDER BY owner_id, identity, last_seen_at DESC, token DESC
    ON CONFLICT (owner_id, identity) DO NOTHING`.execute(trx);
  await trimPushConsents(trx);
}
