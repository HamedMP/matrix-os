/**
 * Versioned owner Postgres schema for notifications (spec 652). Each release
 * adds the tables it first needs as a new version: A2 adds push tokens.
 */
import { sql, type ColumnType, type Kysely, type Transaction } from "kysely";
import { createPushConsentSchema, reconcileLegacyPushTokens } from "./push-consent-schema.js";

export interface NotificationPushTokensTable {
  token: string;
  owner_id: string;
  identity: ColumnType<string | null, string | null | undefined, string | null>;
  platform: string;
  created_at: ColumnType<Date, Date, never>;
  last_seen_at: ColumnType<Date, Date, Date>;
}

interface NotificationPushConsentsTable {
  identity: string;
  owner_id: string;
  delivery_token: string;
  enabled: boolean;
  updated_at: ColumnType<Date, Date, Date>;
}

interface NotificationPushConsentOwnersTable {
  owner_id: string;
  legacy_import_blocked: boolean;
  updated_at: ColumnType<Date, Date, Date>;
}

interface NotificationSchemaMigrationsTable {
  version: number;
  name: string;
  applied_at: ColumnType<Date, never, never>;
}

export interface NotificationDatabase {
  notification_push_tokens: NotificationPushTokensTable;
  notification_push_consents: NotificationPushConsentsTable;
  notification_push_consent_owners: NotificationPushConsentOwnersTable;
  notification_schema_migrations: NotificationSchemaMigrationsTable;
}

interface NotificationMigration {
  version: number;
  name: string;
  up(trx: Transaction<NotificationDatabase>): Promise<void>;
}

const NOTIFICATION_MIGRATIONS: readonly NotificationMigration[] = [
  {
    version: 1,
    name: "push_tokens",
    async up(trx) {
      await sql`
        CREATE TABLE IF NOT EXISTS notification_push_tokens (
          token TEXT PRIMARY KEY CHECK (char_length(token) BETWEEN 1 AND 512),
          owner_id TEXT NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 128),
          platform TEXT NOT NULL CHECK (char_length(platform) BETWEEN 1 AND 32),
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `.execute(trx);
      await sql`
        CREATE INDEX IF NOT EXISTS idx_notification_push_tokens_owner_seen
        ON notification_push_tokens(owner_id, last_seen_at DESC)
      `.execute(trx);
      await sql`
        CREATE INDEX IF NOT EXISTS idx_notification_push_tokens_seen
        ON notification_push_tokens(last_seen_at)
      `.execute(trx);
    },
  },
  // A6 owns versions 2/3 (attention/outbox receipts); this additive migration
  // depends only on v1 and is safe before or after those independent tables.
  {
    version: 4,
    name: "push_consent",
    async up(trx) {
      await createPushConsentSchema(trx);
    },
  },
];

/**
 * Applies pending versions in order in one transaction that first takes a
 * schema advisory lock, before any DDL (the version table included), so
 * gateways that start together never race on `CREATE TABLE` and apply each
 * version once. Versions are additive only: after a host-bundle rollback, an
 * older build ignores newer versions and keeps using the tables it knows.
 */
export async function bootstrapNotificationDatabase(db: Kysely<NotificationDatabase>): Promise<{ applied: number[] }> {
  return db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended('matrix-notification-schema', 0))`.execute(trx);
    await sql`
      CREATE TABLE IF NOT EXISTS notification_schema_migrations (
        version INTEGER PRIMARY KEY CHECK (version > 0),
        name TEXT NOT NULL CHECK (name ~ '^[a-z][a-z0-9_]{0,63}$'),
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `.execute(trx);
    const done = new Set(
      (await trx.selectFrom("notification_schema_migrations").select("version").execute()).map((row) => row.version),
    );
    const applied: number[] = [];
    for (const migration of NOTIFICATION_MIGRATIONS) {
      if (done.has(migration.version)) continue;
      await migration.up(trx);
      await trx.insertInto("notification_schema_migrations")
        .values({ version: migration.version, name: migration.name }).execute();
      applied.push(migration.version);
    }
    // An older gateway may have written legacy rows after version 4. The
    // ledger guards DDL, not reconciliation of those later delivery writes.
    await reconcileLegacyPushTokens(trx);
    return { applied };
  });
}
