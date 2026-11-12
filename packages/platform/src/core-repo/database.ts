/**
 * Matrix Core repo pins and webhook delivery dedupe (spec 2691, layer 6),
 * bootstrapped under their own migration scope. A pin moves only to a commit
 * whose tarball was validated and stored; a failed sync records a coarse
 * reason and leaves the last good pin untouched.
 */
import { sql, type ColumnType, type Kysely, type Transaction } from "kysely";
import { runPlatformMigration } from "../migration-runner.js";

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface CoreRepoPinsTable {
  organization_id: string;
  commit_sha: string | null;
  sha256: string | null;
  bytes: number | null;
  pinned_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  last_attempt_at: Timestamp;
  last_failure: string | null;
}

export interface CoreRepoWebhookDeliveriesTable {
  delivery_id: string;
  received_at: Timestamp;
}

export interface CoreRepoDatabase {
  core_repo_pins: CoreRepoPinsTable;
  core_repo_webhook_deliveries: CoreRepoWebhookDeliveriesTable;
}

export const CORE_REPO_SCHEMA_REVISION = { generation: 1, fingerprint: "core-repo-pins-deliveries-v1" } as const;
export const CORE_REPO_FAILURES = ["token", "ref", "download", "too_large", "archive", "storage"] as const;
export type CoreRepoFailure = typeof CORE_REPO_FAILURES[number];
const DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60_000;

async function createCoreRepoTables(db: Transaction<CoreRepoDatabase>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS core_repo_pins (
      organization_id TEXT PRIMARY KEY CHECK (char_length(organization_id) BETWEEN 5 AND 128),
      commit_sha TEXT CHECK (commit_sha IS NULL OR commit_sha ~ '^[0-9a-f]{40}$'),
      sha256 TEXT CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
      bytes INTEGER CHECK (bytes IS NULL OR bytes > 0),
      pinned_at TIMESTAMPTZ,
      last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_failure TEXT CHECK (last_failure IS NULL OR last_failure IN (${sql.raw(CORE_REPO_FAILURES.map(value => `'${value}'`).join(","))})),
      CHECK ((commit_sha IS NULL) = (sha256 IS NULL) AND (commit_sha IS NULL) = (bytes IS NULL))
    )
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS core_repo_webhook_deliveries (
      delivery_id TEXT PRIMARY KEY CHECK (char_length(delivery_id) BETWEEN 1 AND 128),
      received_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS core_repo_webhook_deliveries_received ON core_repo_webhook_deliveries(received_at)`.execute(db);
}

export async function bootstrapCoreRepoDatabase(db: Kysely<CoreRepoDatabase>): Promise<void> {
  await runPlatformMigration(db, createCoreRepoTables, { scope: "core-repo", revision: CORE_REPO_SCHEMA_REVISION });
}

export interface CoreRepoPinRecord { organizationId: string; commit: string; sha256: string; bytes: number }

export function createCoreRepoRepository(db: Kysely<CoreRepoDatabase>, now: () => Date = () => new Date()) {
  return {
    async getPin(organizationId: string): Promise<CoreRepoPinRecord | null> {
      const row = await db.selectFrom("core_repo_pins").selectAll().where("organization_id", "=", organizationId).executeTakeFirst();
      return row?.commit_sha && row.sha256 && row.bytes ? { organizationId, commit: row.commit_sha, sha256: row.sha256, bytes: row.bytes } : null;
    },

    async listPins(organizationIds: readonly string[]): Promise<CoreRepoPinRecord[]> {
      if (organizationIds.length === 0) return [];
      const rows = await db.selectFrom("core_repo_pins").selectAll()
        .where("organization_id", "in", [...organizationIds]).where("commit_sha", "is not", null).orderBy("organization_id").execute();
      return rows.map(row => ({ organizationId: row.organization_id, commit: row.commit_sha!, sha256: row.sha256!, bytes: row.bytes! }));
    },

    /** Moves the pin in one statement and clears the failure. */
    async pin(record: CoreRepoPinRecord): Promise<void> {
      const at = now();
      await db.insertInto("core_repo_pins").values({ organization_id: record.organizationId, commit_sha: record.commit,
        sha256: record.sha256, bytes: record.bytes, pinned_at: at, last_attempt_at: at, last_failure: null })
        .onConflict(conflict => conflict.column("organization_id").doUpdateSet({ commit_sha: record.commit, sha256: record.sha256,
          bytes: record.bytes, pinned_at: at, last_attempt_at: at, last_failure: null })).execute();
    },

    /** Records why a sync failed without touching the last good pin. */
    async recordFailure(organizationId: string, failure: CoreRepoFailure): Promise<void> {
      const at = now();
      await db.insertInto("core_repo_pins").values({ organization_id: organizationId, commit_sha: null, sha256: null, bytes: null,
        last_attempt_at: at, last_failure: failure })
        .onConflict(conflict => conflict.column("organization_id").doUpdateSet({ last_attempt_at: at, last_failure: failure })).execute();
    },

    /** True only for the first time a delivery id is seen. */
    async claimDelivery(deliveryId: string): Promise<boolean> {
      const inserted = await db.insertInto("core_repo_webhook_deliveries").values({ delivery_id: deliveryId })
        .onConflict(conflict => conflict.column("delivery_id").doNothing()).returning("delivery_id").execute();
      return inserted.length === 1;
    },

    async pruneDeliveries(): Promise<void> {
      await db.deleteFrom("core_repo_webhook_deliveries").where("received_at", "<", new Date(now().getTime() - DELIVERY_RETENTION_MS)).execute();
    },
  };
}

export type CoreRepoRepository = ReturnType<typeof createCoreRepoRepository>;
