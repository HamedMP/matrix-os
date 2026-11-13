import { sql, type ColumnType, type Kysely, type Transaction } from "kysely";
import { runPlatformMigration } from "../migration-runner.js";
import type { CutoverCounts, CutoverPhase } from "./cutover.js";
import type { CollaborativeAppLaunchIdentity } from "./app-launch-sessions.js";

type Timestamp = ColumnType<Date | string, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<Date | string | null, Date | string | null | undefined, Date | string | null>;

export type CollaborationDirectoryKind = "chat" | "terminal" | "project" | "file" | "folder" | "app";

export interface CollaborationDirectoryTable {
  scope_id: string;
  runtime_id: string;
  owner_id: string;
  kind: CollaborationDirectoryKind;
  /** S05: owning organization from the directory event; null only for pre-organization rows. */
  organization_id: string | null;
  /** Explicit grants use `organization`; live app sharing uses fresh current membership directly. */
  audience: "members" | "organization" | "current_membership" | null;
  /** Opaque owner-home grant pointer used only for an explicit accept request. */
  organization_grant_id: string | null;
  app_id: string | null;
  app_catalog_id: string | null;
  app_readiness_id: string | null;
  app_registration_incarnation: string | null;
  app_build_id: string | null;
  app_share_revision: number | null;
  app_state: "active" | "needs_recheck" | "stopped" | null;
  /** A shared project's Chat: routed to the same home, admitted from the parent project's membership. */
  parent_scope_id: ColumnType<string | null, string | null | undefined, string | null>;
  /**
   * S18: false for every row that predates the cutover migration. Those rows
   * are legacy and only their own activated journal admits them; rows created
   * afterwards are direct from birth and default to true.
   */
  direct_native: ColumnType<boolean, boolean | undefined, boolean>;
  authority_generation: number;
  metadata_revision: number;
  last_event_id: string;
  updated_at: Timestamp;
}

export interface CollaborationUserIndexTable {
  actor_id: string;
  scope_id: string;
  status: "invited" | "accepted" | "revoked";
  invitation_id: string | null;
  /** Opaque owner-home pointer to a pending grant addressed to this actor alone; null otherwise. */
  grant_id: string | null;
  locator_generation: number;
  last_event_id: string;
  updated_at: Timestamp;
}

export interface CollaborationConnectionTicketsTable {
  token_hash: string;
  ticket_id: string;
  actor_id: string;
  scope_id: string;
  purpose: "events" | "terminal";
  /**
   * Unused since S20: the rollout policy is gone. Kept nullable so a rollback
   * to a pre-S20 build (which inserts it NOT NULL) still works; S18 drops it
   * once pre-S20 builds are no longer rollback targets.
   */
  policy_revision: ColumnType<number | null, number | null | undefined, number | null>;
  expires_at: Timestamp;
  consumed_at: NullableTimestamp;
  created_at: Timestamp;
}

export interface CollaborationCutoverJournalTable {
  scope_id: string;
  cutover_id: string;
  owner_id: string;
  runtime_id: string;
  organization_id: string;
  source_generation: number;
  target_generation: number;
  source_metadata_revision: number;
  phase: CutoverPhase;
  resume_phase: CutoverPhase | null;
  block_reason: string | null;
  backup_ref: string;
  backup_inventory_ref: string | null;
  counts: CutoverCounts | null;
  ids_digest: string | null;
  ceiling_digest: string | null;
  fence_epoch: number | null;
  fence_digest: string | null;
  interrupted_runs: number | null;
  rollback_mode: "compatible_direct" | null;
  updated_at: Timestamp;
}

export interface CollaborationCutoverDispositionTable {
  scope_id: string;
  action: "terminated";
  owner_id: string;
  runtime_id: string;
  notice_ref: string;
  backup_ref: string;
  home_receipt: string;
  index_rows: number;
  decided_at: Timestamp;
}

/** Owner-published launcher presentation for one shared app; removed when the share stops. */
export interface CollaborationAppPresentationsTable {
  scope_id: string;
  app_id: string;
  name: string;
  artwork_sha256: string | null;
  artwork_content_type: "image/png" | "image/webp" | "image/jpeg" | null;
  artwork_byte_length: number | null;
  /** Null until the owner uploads bytes matching the declared digest, type, and length. */
  artwork_bytes: Uint8Array | null;
  updated_at: Timestamp;
}

export interface CollaborationPlatformDatabase {
  collaboration_app_presentations: CollaborationAppPresentationsTable;
  collaboration_app_launches: {
    launch_id: string; client_request_id: string; actor_id: string; scope_id: string;
    identity: CollaborativeAppLaunchIdentity; created_at: Timestamp; expires_at: Timestamp;
  };
  collaboration_directory: CollaborationDirectoryTable;
  collaboration_user_index: CollaborationUserIndexTable;
  collaboration_connection_tickets: CollaborationConnectionTicketsTable;
  collaboration_cutover_journal: CollaborationCutoverJournalTable;
  collaboration_cutover_dispositions: CollaborationCutoverDispositionTable;
}

export async function bootstrapPlatformCollaborationDatabase(
  db: Kysely<CollaborationPlatformDatabase>,
): Promise<void> {
  // One locked transaction through the platform migration path: the rollout-table drop, the
  // ticket-table setup, the index and the column relaxation apply atomically or not at all.
  await runPlatformMigration(db, (trx) => applyCollaborationSchema(trx));
}

async function applyCollaborationSchema(trx: Transaction<CollaborationPlatformDatabase>): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS collaboration_app_launches (
    launch_id UUID PRIMARY KEY, client_request_id UUID NOT NULL,
    actor_id TEXT NOT NULL CHECK (char_length(actor_id) BETWEEN 1 AND 128), scope_id UUID NOT NULL,
    identity JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
    UNIQUE(actor_id, client_request_id), CHECK (expires_at > created_at)
  )`.execute(trx);
  await sql`CREATE INDEX IF NOT EXISTS idx_collaboration_app_launches_expiry
    ON collaboration_app_launches(expires_at)`.execute(trx);
  await sql`
    CREATE TABLE IF NOT EXISTS collaboration_directory (
      scope_id UUID PRIMARY KEY,
      runtime_id TEXT NOT NULL CHECK (char_length(runtime_id) BETWEEN 1 AND 128),
      owner_id TEXT NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 128),
      kind TEXT NOT NULL CHECK (kind IN ('chat', 'terminal', 'project', 'file', 'folder', 'app')),
      authority_generation BIGINT NOT NULL CHECK (authority_generation > 0),
      metadata_revision BIGINT NOT NULL CHECK (metadata_revision >= 0),
      last_event_id UUID NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(trx);
  // Existing homes may have created the original three-kind directory table. Upgrade its
  // constraint under the platform migration lock; leave an already widened table untouched.
  await sql`DO $migration$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'collaboration_directory'::regclass
          AND conname = 'collaboration_directory_kind_check'
          AND pg_get_constraintdef(oid) NOT LIKE '%file%'
      ) THEN
        ALTER TABLE collaboration_directory DROP CONSTRAINT collaboration_directory_kind_check;
        ALTER TABLE collaboration_directory ADD CONSTRAINT collaboration_directory_kind_check
          CHECK (kind IN ('chat', 'terminal', 'project', 'file', 'folder', 'app'));
      END IF;
    END
  $migration$`.execute(trx);
  // S05: the directory records each scope's organization so tickets bind to it.
  await sql`ALTER TABLE collaboration_directory ADD COLUMN IF NOT EXISTS organization_id TEXT
    CHECK (organization_id IS NULL OR char_length(organization_id) BETWEEN 1 AND 128)`.execute(trx);
  // S06: organization-wide shares are listed as pending for members from this flag alone.
  await sql`ALTER TABLE collaboration_directory ADD COLUMN IF NOT EXISTS audience TEXT`.execute(trx);
  await sql`DO $migration$
    DECLARE constraint_name TEXT;
    BEGIN
      SELECT conname INTO constraint_name FROM pg_constraint
      WHERE conrelid = 'collaboration_directory'::regclass
        AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%audience%';
      IF constraint_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE collaboration_directory DROP CONSTRAINT %I', constraint_name);
      END IF;
      ALTER TABLE collaboration_directory ADD CONSTRAINT collaboration_directory_audience_check
        CHECK (audience IS NULL OR audience IN ('members', 'organization', 'current_membership'));
    END
  $migration$`.execute(trx);
  await sql`ALTER TABLE collaboration_directory ADD COLUMN IF NOT EXISTS organization_grant_id UUID`.execute(trx);
  await sql`ALTER TABLE collaboration_directory ADD COLUMN IF NOT EXISTS app_id TEXT
    CHECK (app_id IS NULL OR (char_length(app_id) BETWEEN 1 AND 256 AND app_id ~ '^[A-Za-z0-9_-]+$'))`.execute(trx);
  await sql`ALTER TABLE collaboration_directory ADD COLUMN IF NOT EXISTS app_catalog_id UUID`.execute(trx);
  await sql`ALTER TABLE collaboration_directory ADD COLUMN IF NOT EXISTS app_readiness_id UUID`.execute(trx);
  await sql`ALTER TABLE collaboration_directory ADD COLUMN IF NOT EXISTS app_registration_incarnation TEXT
    CHECK (app_registration_incarnation IS NULL OR app_registration_incarnation ~ '^[a-f0-9]{64}$')`.execute(trx);
  await sql`ALTER TABLE collaboration_directory ADD COLUMN IF NOT EXISTS app_build_id TEXT
    CHECK (app_build_id IS NULL OR app_build_id ~ '^[a-f0-9]{64}$')`.execute(trx);
  await sql`ALTER TABLE collaboration_directory ADD COLUMN IF NOT EXISTS app_share_revision BIGINT
    CHECK (app_share_revision IS NULL OR app_share_revision > 0)`.execute(trx);
  await sql`ALTER TABLE collaboration_directory ADD COLUMN IF NOT EXISTS app_state TEXT
    CHECK (app_state IS NULL OR app_state IN ('active', 'needs_recheck', 'stopped'))`.execute(trx);
  // A project's Chats are routed beside their project and removed with it.
  await sql`ALTER TABLE collaboration_directory ADD COLUMN IF NOT EXISTS parent_scope_id UUID
    REFERENCES collaboration_directory(scope_id) ON DELETE CASCADE`.execute(trx);
  await sql`CREATE INDEX IF NOT EXISTS idx_collaboration_directory_parent
    ON collaboration_directory (parent_scope_id) WHERE parent_scope_id IS NOT NULL`.execute(trx);
  // S18: the cutover migration is the boundary between legacy and direct scopes.
  // The column is added without a default so every row that already exists
  // backfills to false, then defaults to true so rows created after the
  // migration are direct from birth. Ticket admission denies a legacy row until
  // its own cutover journal activates, so journal absence can never admit one.
  await sql`ALTER TABLE collaboration_directory ADD COLUMN IF NOT EXISTS direct_native BOOLEAN`.execute(trx);
  await sql`UPDATE collaboration_directory SET direct_native = false WHERE direct_native IS NULL`.execute(trx);
  await sql`ALTER TABLE collaboration_directory ALTER COLUMN direct_native SET DEFAULT true`.execute(trx);
  await sql`ALTER TABLE collaboration_directory ALTER COLUMN direct_native SET NOT NULL`.execute(trx);
  await sql`
    CREATE TABLE IF NOT EXISTS collaboration_user_index (
      actor_id TEXT NOT NULL CHECK (char_length(actor_id) BETWEEN 1 AND 128),
      scope_id UUID NOT NULL REFERENCES collaboration_directory(scope_id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('invited', 'accepted', 'revoked')),
      invitation_id UUID,
      locator_generation BIGINT NOT NULL CHECK (locator_generation > 0),
      last_event_id UUID NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (actor_id, scope_id)
    )
  `.execute(trx);
  await sql`ALTER TABLE collaboration_user_index ADD COLUMN IF NOT EXISTS invitation_id UUID`.execute(trx);
  // A pending grant addressed to one member is listed and ticketed from this pointer alone.
  await sql`ALTER TABLE collaboration_user_index ADD COLUMN IF NOT EXISTS grant_id UUID`.execute(trx);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_collaboration_user_invitation
    ON collaboration_user_index(invitation_id)
    WHERE invitation_id IS NOT NULL
  `.execute(trx);
  // S20 / T100: the rollout cohort table is dropped without replacement. The
  // organization precondition on the home is the only gate.
  await sql`DROP TABLE IF EXISTS collaboration_rollout_policy`.execute(trx);
  await sql`
    CREATE TABLE IF NOT EXISTS collaboration_connection_tickets (
      token_hash TEXT PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
      ticket_id UUID NOT NULL UNIQUE,
      actor_id TEXT NOT NULL CHECK (char_length(actor_id) BETWEEN 1 AND 128),
      scope_id UUID NOT NULL,
      purpose TEXT NOT NULL CHECK (purpose IN ('events', 'terminal')),
      policy_revision BIGINT CHECK (policy_revision IS NULL OR policy_revision >= 0),
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(trx);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_collaboration_user_index_actor
    ON collaboration_user_index(actor_id, status, updated_at DESC)
  `.execute(trx);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_collaboration_tickets_outstanding
    ON collaboration_connection_tickets(actor_id, expires_at)
    WHERE consumed_at IS NULL
  `.execute(trx);
  // Pre-S20 tables declared policy_revision NOT NULL; relax it so tickets issued without a
  // policy revision can be stored while pre-S20 builds remain rollback targets (S18 drops it).
  await sql`ALTER TABLE collaboration_connection_tickets ALTER COLUMN policy_revision DROP NOT NULL`.execute(trx);
  await sql`
    CREATE TABLE IF NOT EXISTS collaboration_cutover_journal (
      scope_id UUID PRIMARY KEY REFERENCES collaboration_directory(scope_id),
      cutover_id UUID NOT NULL UNIQUE,
      owner_id TEXT NOT NULL,
      runtime_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      source_generation BIGINT NOT NULL CHECK (source_generation > 0),
      target_generation BIGINT NOT NULL CHECK (target_generation = source_generation + 1),
      source_metadata_revision BIGINT NOT NULL CHECK (source_metadata_revision >= 0),
      phase TEXT NOT NULL CHECK (phase IN ('pending', 'inventoried', 'fenced', 'drained', 'staged', 'verified', 'active', 'blocked')),
      resume_phase TEXT CHECK (resume_phase IS NULL OR resume_phase IN ('pending', 'inventoried', 'fenced', 'drained', 'staged', 'verified')),
      block_reason TEXT,
      backup_ref TEXT NOT NULL,
      backup_inventory_ref TEXT,
      counts JSONB,
      ids_digest TEXT CHECK (ids_digest IS NULL OR ids_digest ~ '^[a-f0-9]{64}$'),
      ceiling_digest TEXT CHECK (ceiling_digest IS NULL OR ceiling_digest ~ '^[a-f0-9]{64}$'),
      fence_epoch BIGINT CHECK (fence_epoch IS NULL OR fence_epoch > 0),
      fence_digest TEXT CHECK (fence_digest IS NULL OR fence_digest ~ '^[a-f0-9]{64}$'),
      interrupted_runs BIGINT CHECK (interrupted_runs IS NULL OR interrupted_runs >= 0),
      rollback_mode TEXT CHECK (rollback_mode IS NULL OR rollback_mode = 'compatible_direct'),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(trx);
  await sql`
    CREATE TABLE IF NOT EXISTS collaboration_app_presentations (
      scope_id UUID PRIMARY KEY REFERENCES collaboration_directory(scope_id) ON DELETE CASCADE,
      app_id TEXT NOT NULL CHECK (char_length(app_id) BETWEEN 1 AND 256 AND app_id ~ '^[A-Za-z0-9_-]+$'),
      name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120 AND octet_length(name) <= 512),
      artwork_sha256 TEXT CHECK (artwork_sha256 IS NULL OR artwork_sha256 ~ '^[a-f0-9]{64}$'),
      artwork_content_type TEXT CHECK (artwork_content_type IS NULL
        OR artwork_content_type IN ('image/png', 'image/webp', 'image/jpeg')),
      artwork_byte_length INTEGER CHECK (artwork_byte_length IS NULL OR artwork_byte_length BETWEEN 1 AND 4194304),
      artwork_bytes BYTEA,
      updated_at TIMESTAMPTZ NOT NULL,
      CHECK ((artwork_sha256 IS NULL) = (artwork_content_type IS NULL)
        AND (artwork_sha256 IS NULL) = (artwork_byte_length IS NULL)),
      CHECK (artwork_bytes IS NULL OR octet_length(artwork_bytes) = artwork_byte_length)
    )
  `.execute(trx);
  await sql`
    CREATE TABLE IF NOT EXISTS collaboration_cutover_dispositions (
      scope_id UUID PRIMARY KEY,
      action TEXT NOT NULL CHECK (action = 'terminated'),
      owner_id TEXT NOT NULL,
      runtime_id TEXT NOT NULL,
      notice_ref TEXT NOT NULL,
      backup_ref TEXT NOT NULL,
      home_receipt TEXT NOT NULL,
      index_rows INTEGER NOT NULL CHECK (index_rows >= 0),
      decided_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(trx);
}
