import { sql, type ColumnType, type Kysely, type Transaction } from "kysely";
import { runPlatformMigration } from "../migration-runner.js";
import type { CutoverCounts, CutoverPhase } from "./cutover.js";

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
  /** S06: `organization` when the home reports an active organization-wide grant. */
  audience: "members" | "organization" | null;
  /** Opaque owner-home grant pointer used only for an explicit accept request. */
  organization_grant_id: string | null;
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

export interface CollaborationPlatformDatabase {
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
  await sql`ALTER TABLE collaboration_directory ADD COLUMN IF NOT EXISTS audience TEXT
    CHECK (audience IS NULL OR audience IN ('members', 'organization'))`.execute(trx);
  await sql`ALTER TABLE collaboration_directory ADD COLUMN IF NOT EXISTS organization_grant_id UUID`.execute(trx);
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
