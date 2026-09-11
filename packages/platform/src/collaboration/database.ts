import { sql, type ColumnType, type Kysely } from "kysely";

type Timestamp = ColumnType<Date | string, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<Date | string | null, Date | string | null | undefined, Date | string | null>;
type JsonValue = ColumnType<unknown, unknown, unknown>;

export interface CollaborationDirectoryTable {
  scope_id: string;
  runtime_id: string;
  owner_id: string;
  kind: "chat" | "terminal" | "project";
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

export interface CollaborationRolloutPolicyTable {
  milestone: "m1" | "m2" | "m3" | "m4";
  revision: number;
  mode: "off" | "internal" | "enabled" | "read_only";
  cohort: JsonValue;
  changed_by: string;
  changed_at: Timestamp;
}

export interface CollaborationConnectionTicketsTable {
  token_hash: string;
  ticket_id: string;
  actor_id: string;
  scope_id: string;
  purpose: "events" | "terminal";
  policy_revision: number;
  expires_at: Timestamp;
  consumed_at: NullableTimestamp;
  created_at: Timestamp;
}

export interface CollaborationPlatformDatabase {
  collaboration_directory: CollaborationDirectoryTable;
  collaboration_user_index: CollaborationUserIndexTable;
  collaboration_rollout_policy: CollaborationRolloutPolicyTable;
  collaboration_connection_tickets: CollaborationConnectionTicketsTable;
}

export async function bootstrapPlatformCollaborationDatabase(
  db: Kysely<CollaborationPlatformDatabase>,
): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS collaboration_directory (
      scope_id UUID PRIMARY KEY,
      runtime_id TEXT NOT NULL CHECK (char_length(runtime_id) BETWEEN 1 AND 128),
      owner_id TEXT NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 128),
      kind TEXT NOT NULL CHECK (kind IN ('chat', 'terminal', 'project')),
      authority_generation BIGINT NOT NULL CHECK (authority_generation > 0),
      metadata_revision BIGINT NOT NULL CHECK (metadata_revision >= 0),
      last_event_id UUID NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);
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
  `.execute(db);
  await sql`ALTER TABLE collaboration_user_index ADD COLUMN IF NOT EXISTS invitation_id UUID`.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_collaboration_user_invitation
    ON collaboration_user_index(invitation_id)
    WHERE invitation_id IS NOT NULL
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS collaboration_rollout_policy (
      milestone TEXT PRIMARY KEY CHECK (milestone IN ('m1', 'm2', 'm3', 'm4')),
      revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
      mode TEXT NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'internal', 'enabled', 'read_only')),
      cohort JSONB NOT NULL DEFAULT '[]',
      changed_by TEXT NOT NULL CHECK (char_length(changed_by) BETWEEN 1 AND 128),
      changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (jsonb_typeof(cohort) = 'array' AND jsonb_array_length(cohort) <= 1000)
    )
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS collaboration_connection_tickets (
      token_hash TEXT PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
      ticket_id UUID NOT NULL UNIQUE,
      actor_id TEXT NOT NULL CHECK (char_length(actor_id) BETWEEN 1 AND 128),
      scope_id UUID NOT NULL,
      purpose TEXT NOT NULL CHECK (purpose IN ('events', 'terminal')),
      policy_revision BIGINT NOT NULL CHECK (policy_revision >= 0),
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_collaboration_user_index_actor
    ON collaboration_user_index(actor_id, status, updated_at DESC)
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_collaboration_tickets_outstanding
    ON collaboration_connection_tickets(actor_id, expires_at)
    WHERE consumed_at IS NULL
  `.execute(db);
  await sql`
    INSERT INTO collaboration_rollout_policy (milestone, changed_by)
    VALUES ('m1', 'system'), ('m2', 'system'), ('m3', 'system'), ('m4', 'system')
    ON CONFLICT (milestone) DO NOTHING
  `.execute(db);
}
