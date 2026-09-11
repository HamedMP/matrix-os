import { sql, type ColumnType, type Generated, type Kysely } from "kysely";
import type { ChatDatabase } from "../chat/database.js";

type Timestamp = ColumnType<Date | string, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<Date | string | null, Date | string | null | undefined, Date | string | null>;
type JsonValue = ColumnType<unknown, unknown, unknown>;

export interface CollaborationScopesTable {
  id: string;
  owner_type: "personal" | "organization";
  owner_id: string;
  kind: "chat" | "terminal" | "project";
  resource_id: string;
  parent_scope_id: string | null;
  membership_mode: "direct" | "inherited";
  lifecycle: "private" | "preparing" | "shared" | "archived" | "deleting" | "deleted" | "recovering";
  revision: ColumnType<number, number | undefined, number>;
  auth_epoch: ColumnType<number, number | undefined, number>;
  authority_runtime_id: string;
  authority_generation: ColumnType<number, number | undefined, number>;
  execution_generation: number | null;
  execution_eligibility: JsonValue | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  deleted_at: NullableTimestamp;
}

export interface CollaborationMembersTable {
  scope_id: string;
  actor_id: string;
  role: "owner" | "editor" | "viewer";
  status: "pending" | "accepted" | "revoked" | "expired";
  invitation_id: string | null;
  invited_by: string;
  accepted_at: NullableTimestamp;
  expires_at: NullableTimestamp;
  revision: ColumnType<number, number | undefined, number>;
  joined_at: NullableTimestamp;
  updated_at: Timestamp;
}

export interface CollaborationOperationsTable {
  scope_id: string;
  actor_id: string;
  client_request_id: string;
  operation_kind: string;
  payload_hash: string;
  status: "accepted" | "completed" | "failed";
  result_ref: JsonValue | null;
  expected_revision: number | null;
  accepted_auth_epoch: number;
  created_at: Timestamp;
  expires_at: Timestamp;
}

export interface CollaborationEventsTable {
  scope_id: string;
  scope_seq: number;
  event_id: string;
  resource_kind: "chat" | "terminal" | "project";
  resource_id: string;
  revision: number;
  authority_generation: number;
  event_type: string;
  payload: JsonValue;
  created_at: Timestamp;
}

export interface CollaborationAuditTable {
  id: Generated<number>;
  scope_id: string;
  actor_id: string;
  action: string;
  outcome: string;
  revision: number;
  reason_code: string | null;
  created_at: Timestamp;
}

export interface CollaborationExportsTable {
  id: string;
  scope_id: string;
  owner_id: string;
  payload: JsonValue;
  created_at: Timestamp;
  expires_at: Timestamp;
}

export interface CollaborationDirectoryOutboxTable {
  event_id: string;
  scope_id: string;
  recipient_actor_ids: JsonValue;
  authority_runtime_id: string;
  authority_generation: number;
  resource_kind: "chat" | "terminal" | "project";
  discovery_state: "invited" | "accepted" | "revoked" | "deleted";
  retry_after: Timestamp;
  attempts: ColumnType<number, number | undefined, number>;
  delivered_at: NullableTimestamp;
  created_at: Timestamp;
}

export interface CollaborationSchemaMigrationsTable {
  version: number;
  applied_at: Timestamp;
}

export interface CollaborationTransitionsTable {
  id: string;
  scope_id: string;
  source_authority_runtime_id: string;
  source_authority_generation: number;
  destination_authority_runtime_id: string;
  destination_authority_generation: number;
  requested_by: string;
  inventory_revision: number;
  inventory_hash: string;
  intended_membership_hash: string;
  status: "prepared" | "staging" | "fenced" | "committing" | "active" | "failed" | "recovering";
  source_fence_epoch: number | null;
  staged_manifest_ref: string | null;
  publication_marker: string | null;
  retry_count: ColumnType<number, number | undefined, number>;
  error_code: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface CollaborationResourceBindingsTable {
  id: string;
  project_scope_id: string;
  resource_scope_id: string | null;
  resource_kind: "file" | "chat" | "app" | "layout" | "terminal";
  resource_id: string;
  authority_runtime_id: string;
  authority_generation: number;
  revision: ColumnType<number, number | undefined, number>;
  readiness: "ready" | "blocked";
  blocker: string | null;
  incarnation: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface CollaborationLayoutNodeRevisionsTable {
  scope_id: string;
  canvas_id: string;
  node_id: string;
  revision: ColumnType<number, number | undefined, number>;
  updated_at: Timestamp;
}

export interface CollaborationProjectViewStatesTable {
  scope_id: string;
  canvas_id: string;
  actor_id: string;
  state: JsonValue;
  revision: ColumnType<number, number | undefined, number>;
  updated_at: Timestamp;
}

export interface ChatCollaborationCommandsTable {
  id: string;
  scope_id: string;
  chat_id: string;
  target_request_id: string | null;
  run_id: string | null;
  approval_id: string | null;
  actor_id: string;
  client_request_id: string;
  kind: "approval" | "cancel" | "retry";
  payload_hash: string;
  expected_state_revision: number;
  decision: string | null;
  authorized_epoch: number;
  state: "accepted" | "completed" | "failed" | "reconciling";
  result_ref: JsonValue | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface CollaborationDatabase {
  collaboration_scopes: CollaborationScopesTable;
  collaboration_members: CollaborationMembersTable;
  collaboration_operations: CollaborationOperationsTable;
  collaboration_events: CollaborationEventsTable;
  collaboration_exports: CollaborationExportsTable;
  collaboration_audit: CollaborationAuditTable;
  collaboration_directory_outbox: CollaborationDirectoryOutboxTable;
  collaboration_schema_migrations: CollaborationSchemaMigrationsTable;
  collaboration_transitions: CollaborationTransitionsTable;
  collaboration_resource_bindings: CollaborationResourceBindingsTable;
  collaboration_layout_node_revisions: CollaborationLayoutNodeRevisionsTable;
  collaboration_project_view_states: CollaborationProjectViewStatesTable;
  chat_collaboration_commands: ChatCollaborationCommandsTable;
}

export type OwnerCollaborationDatabase = ChatDatabase & CollaborationDatabase;

export async function bootstrapCollaborationDatabase(
  db: Kysely<OwnerCollaborationDatabase>,
): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS collaboration_schema_migrations (
      version INTEGER PRIMARY KEY CHECK (version > 0),
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS chat_collaboration_commands (
      id UUID PRIMARY KEY,
      scope_id UUID NOT NULL,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      target_request_id TEXT,
      run_id TEXT REFERENCES chat_runs(id) ON DELETE SET NULL,
      approval_id TEXT,
      actor_id TEXT NOT NULL CHECK (char_length(actor_id) BETWEEN 1 AND 128),
      client_request_id UUID NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('approval', 'cancel', 'retry')),
      payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
      expected_state_revision BIGINT NOT NULL CHECK (expected_state_revision >= 0),
      decision TEXT,
      authorized_epoch BIGINT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('accepted', 'completed', 'failed', 'reconciling')),
      result_ref JSONB,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      UNIQUE (scope_id, actor_id, client_request_id, kind)
    )
  `.execute(db);
  await sql`
    ALTER TABLE chat_collaboration_commands
    ADD COLUMN IF NOT EXISTS expected_state_revision BIGINT
  `.execute(db);
  await sql`
    UPDATE chat_collaboration_commands
    SET expected_state_revision = 0
    WHERE expected_state_revision IS NULL
  `.execute(db);
  await sql`
    ALTER TABLE chat_collaboration_commands
    ALTER COLUMN expected_state_revision SET NOT NULL
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_collaboration_one_approval_decision
    ON chat_collaboration_commands(scope_id, approval_id)
    WHERE kind = 'approval'
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS collaboration_scopes (
      id UUID PRIMARY KEY,
      owner_type TEXT NOT NULL CHECK (owner_type IN ('personal', 'organization')),
      owner_id TEXT NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 128),
      kind TEXT NOT NULL CHECK (kind IN ('chat', 'terminal', 'project')),
      resource_id TEXT NOT NULL CHECK (char_length(resource_id) BETWEEN 1 AND 256),
      parent_scope_id UUID REFERENCES collaboration_scopes(id),
      membership_mode TEXT NOT NULL CHECK (membership_mode IN ('direct', 'inherited')),
      lifecycle TEXT NOT NULL CHECK (lifecycle IN ('private', 'preparing', 'shared', 'archived', 'deleting', 'deleted', 'recovering')),
      revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
      auth_epoch BIGINT NOT NULL DEFAULT 0 CHECK (auth_epoch >= 0),
      authority_runtime_id TEXT NOT NULL CHECK (char_length(authority_runtime_id) BETWEEN 1 AND 128),
      authority_generation BIGINT NOT NULL DEFAULT 1 CHECK (authority_generation > 0),
      execution_generation BIGINT CHECK (execution_generation > 0),
      execution_eligibility JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      deleted_at TIMESTAMPTZ,
      CHECK (
        (membership_mode = 'direct' AND parent_scope_id IS NULL)
        OR (membership_mode = 'inherited' AND parent_scope_id IS NOT NULL)
      )
    )
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS collaboration_members (
      scope_id UUID NOT NULL REFERENCES collaboration_scopes(id) ON DELETE CASCADE,
      actor_id TEXT NOT NULL CHECK (char_length(actor_id) BETWEEN 1 AND 128),
      role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
      status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
      invitation_id UUID,
      invited_by TEXT NOT NULL CHECK (char_length(invited_by) BETWEEN 1 AND 128),
      accepted_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
      joined_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (scope_id, actor_id),
      UNIQUE (invitation_id),
      CHECK (role <> 'owner' OR (status = 'accepted' AND invitation_id IS NULL)),
      CHECK (
        (status = 'pending' AND invitation_id IS NOT NULL AND accepted_at IS NULL AND expires_at IS NOT NULL)
        OR (status = 'accepted' AND accepted_at IS NOT NULL AND joined_at IS NOT NULL)
        OR status IN ('revoked', 'expired')
      )
    )
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS collaboration_operations (
      scope_id UUID NOT NULL REFERENCES collaboration_scopes(id) ON DELETE CASCADE,
      actor_id TEXT NOT NULL CHECK (char_length(actor_id) BETWEEN 1 AND 128),
      client_request_id UUID NOT NULL,
      operation_kind TEXT NOT NULL CHECK (char_length(operation_kind) BETWEEN 1 AND 80),
      payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
      status TEXT NOT NULL CHECK (status IN ('accepted', 'completed', 'failed')),
      result_ref JSONB,
      expected_revision BIGINT,
      accepted_auth_epoch BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (scope_id, actor_id, client_request_id, operation_kind)
    )
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS collaboration_events (
      scope_id UUID NOT NULL REFERENCES collaboration_scopes(id) ON DELETE CASCADE,
      scope_seq BIGINT NOT NULL CHECK (scope_seq > 0),
      event_id UUID NOT NULL UNIQUE,
      resource_kind TEXT NOT NULL CHECK (resource_kind IN ('chat', 'terminal', 'project')),
      resource_id TEXT NOT NULL CHECK (char_length(resource_id) BETWEEN 1 AND 256),
      revision BIGINT NOT NULL CHECK (revision >= 0),
      authority_generation BIGINT NOT NULL CHECK (authority_generation > 0),
      event_type TEXT NOT NULL CHECK (char_length(event_type) BETWEEN 1 AND 80),
      payload JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (scope_id, scope_seq)
    )
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS collaboration_audit (
      id BIGSERIAL PRIMARY KEY,
      scope_id UUID NOT NULL REFERENCES collaboration_scopes(id) ON DELETE CASCADE,
      actor_id TEXT NOT NULL CHECK (char_length(actor_id) BETWEEN 1 AND 128),
      action TEXT NOT NULL CHECK (char_length(action) BETWEEN 1 AND 80),
      outcome TEXT NOT NULL CHECK (char_length(outcome) BETWEEN 1 AND 40),
      revision BIGINT NOT NULL CHECK (revision >= 0),
      reason_code TEXT CHECK (reason_code IS NULL OR char_length(reason_code) <= 80),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS collaboration_exports (
      id UUID PRIMARY KEY,
      scope_id UUID NOT NULL REFERENCES collaboration_scopes(id),
      owner_id TEXT NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 128),
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      CHECK (jsonb_typeof(payload) = 'object')
    )
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS collaboration_directory_outbox (
      event_id UUID PRIMARY KEY,
      scope_id UUID NOT NULL REFERENCES collaboration_scopes(id) ON DELETE CASCADE,
      recipient_actor_ids JSONB NOT NULL,
      authority_runtime_id TEXT NOT NULL CHECK (char_length(authority_runtime_id) BETWEEN 1 AND 128),
      authority_generation BIGINT NOT NULL CHECK (authority_generation > 0),
      resource_kind TEXT NOT NULL CHECK (resource_kind IN ('chat', 'terminal', 'project')),
      discovery_state TEXT NOT NULL CHECK (discovery_state IN ('invited', 'accepted', 'revoked', 'deleted')),
      retry_after TIMESTAMPTZ NOT NULL DEFAULT now(),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
      delivered_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (jsonb_typeof(recipient_actor_ids) = 'array')
    )
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS collaboration_transitions (
      id UUID PRIMARY KEY,
      scope_id UUID NOT NULL REFERENCES collaboration_scopes(id) ON DELETE CASCADE,
      source_authority_runtime_id TEXT NOT NULL CHECK (char_length(source_authority_runtime_id) BETWEEN 1 AND 128),
      source_authority_generation BIGINT NOT NULL CHECK (source_authority_generation > 0),
      destination_authority_runtime_id TEXT NOT NULL CHECK (char_length(destination_authority_runtime_id) BETWEEN 1 AND 128),
      destination_authority_generation BIGINT NOT NULL CHECK (destination_authority_generation > 0),
      requested_by TEXT NOT NULL CHECK (char_length(requested_by) BETWEEN 1 AND 128),
      inventory_revision BIGINT NOT NULL CHECK (inventory_revision >= 0),
      inventory_hash TEXT NOT NULL CHECK (inventory_hash ~ '^[a-f0-9]{64}$'),
      intended_membership_hash TEXT NOT NULL CHECK (intended_membership_hash ~ '^[a-f0-9]{64}$'),
      status TEXT NOT NULL CHECK (status IN (
        'prepared', 'staging', 'fenced', 'committing', 'active', 'failed', 'recovering'
      )),
      source_fence_epoch BIGINT CHECK (source_fence_epoch > 0),
      staged_manifest_ref TEXT CHECK (
        staged_manifest_ref IS NULL OR staged_manifest_ref ~ '^manifest_[A-Za-z0-9_-]{1,128}$'
      ),
      publication_marker TEXT CHECK (
        publication_marker IS NULL OR publication_marker ~ '^publication_[A-Za-z0-9_-]{1,128}$'
      ),
      retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count BETWEEN 0 AND 20),
      error_code TEXT CHECK (error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_]{0,79}$'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (source_authority_runtime_id <> destination_authority_runtime_id),
      CHECK (status NOT IN ('fenced', 'committing', 'active') OR source_fence_epoch IS NOT NULL),
      CHECK (status <> 'active' OR publication_marker IS NOT NULL)
    )
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS collaboration_resource_bindings (
      id UUID PRIMARY KEY,
      project_scope_id UUID NOT NULL REFERENCES collaboration_scopes(id) ON DELETE CASCADE,
      resource_scope_id UUID UNIQUE REFERENCES collaboration_scopes(id) ON DELETE CASCADE,
      resource_kind TEXT NOT NULL CHECK (resource_kind IN ('file', 'chat', 'app', 'layout', 'terminal')),
      resource_id TEXT NOT NULL CHECK (char_length(resource_id) BETWEEN 1 AND 4096),
      authority_runtime_id TEXT NOT NULL CHECK (char_length(authority_runtime_id) BETWEEN 1 AND 128),
      authority_generation BIGINT NOT NULL CHECK (authority_generation > 0),
      revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
      readiness TEXT NOT NULL CHECK (readiness IN ('ready', 'blocked')),
      blocker TEXT CHECK (blocker IS NULL OR blocker ~ '^[a-z][a-z0-9_]{0,79}$'),
      incarnation TEXT CHECK (
        incarnation IS NULL OR (incarnation ~ '^[A-Za-z0-9_-]+$' AND char_length(incarnation) <= 256)
      ),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (project_scope_id, resource_kind, resource_id),
      CHECK ((readiness = 'ready' AND blocker IS NULL) OR (readiness = 'blocked' AND blocker IS NOT NULL)),
      CHECK ((resource_kind IN ('chat', 'terminal')) = (resource_scope_id IS NOT NULL)),
      CHECK (resource_kind <> 'terminal' OR incarnation IS NOT NULL)
    )
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS collaboration_layout_node_revisions (
      scope_id UUID NOT NULL REFERENCES collaboration_scopes(id) ON DELETE CASCADE,
      canvas_id TEXT NOT NULL CHECK (char_length(canvas_id) BETWEEN 1 AND 256),
      node_id TEXT NOT NULL CHECK (char_length(node_id) BETWEEN 1 AND 128),
      revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (scope_id, canvas_id, node_id)
    )
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS collaboration_project_view_states (
      scope_id UUID NOT NULL REFERENCES collaboration_scopes(id) ON DELETE CASCADE,
      canvas_id TEXT NOT NULL CHECK (char_length(canvas_id) BETWEEN 1 AND 256),
      actor_id TEXT NOT NULL CHECK (char_length(actor_id) BETWEEN 1 AND 128),
      state JSONB NOT NULL CHECK (jsonb_typeof(state) = 'object'),
      revision BIGINT NOT NULL CHECK (revision > 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (scope_id, canvas_id, actor_id)
    )
  `.execute(db);

  await sql`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS actor_id TEXT`.execute(db);
  await sql`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS purpose TEXT`.execute(db);
  await sql`
    UPDATE chat_messages
    SET purpose = CASE role
      WHEN 'user' THEN 'ai_request'
      WHEN 'assistant' THEN 'assistant'
      ELSE 'system'
    END
    WHERE purpose IS NULL
  `.execute(db);
  await sql`ALTER TABLE chat_messages ALTER COLUMN purpose SET NOT NULL`.execute(db);
  await sql`
    ALTER TABLE chat_messages DROP CONSTRAINT IF EXISTS chat_messages_purpose_check
  `.execute(db);
  await sql`
    ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_purpose_check
    CHECK (purpose IN ('discussion', 'ai_request', 'assistant', 'system'))
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_collaboration_scope_binding
    ON collaboration_scopes(owner_type, owner_id, kind, resource_id)
    WHERE deleted_at IS NULL AND lifecycle <> 'deleted'
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_collaboration_invitation_identity
    ON collaboration_members(invitation_id)
    WHERE invitation_id IS NOT NULL
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_collaboration_events_replay
    ON collaboration_events(scope_id, scope_seq)
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_collaboration_outbox_delivery
    ON collaboration_directory_outbox(delivered_at, retry_after, created_at)
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_collaboration_operations_expiry
    ON collaboration_operations(expires_at)
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_collaboration_exports_expiry
    ON collaboration_exports(expires_at)
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_collaboration_transition_in_progress
    ON collaboration_transitions(scope_id)
    WHERE status IN ('prepared', 'staging', 'fenced', 'committing', 'recovering')
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_collaboration_transition_recovery
    ON collaboration_transitions(status, updated_at)
    WHERE status IN ('prepared', 'staging', 'fenced', 'committing', 'recovering')
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_collaboration_resource_lookup
    ON collaboration_resource_bindings(project_scope_id, resource_kind, resource_id)
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_collaboration_resource_readiness
    ON collaboration_resource_bindings(project_scope_id, readiness)
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_collaboration_layout_nodes
    ON collaboration_layout_node_revisions(scope_id, canvas_id)
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_collaboration_project_view_actor
    ON collaboration_project_view_states(actor_id, updated_at DESC)
  `.execute(db);
  await sql`
    INSERT INTO collaboration_schema_migrations (version)
    VALUES (1)
    ON CONFLICT (version) DO NOTHING
  `.execute(db);
  await sql`
    INSERT INTO collaboration_schema_migrations (version)
    VALUES (2)
    ON CONFLICT (version) DO NOTHING
  `.execute(db);
  await sql`
    INSERT INTO collaboration_schema_migrations (version)
    VALUES (3)
    ON CONFLICT (version) DO NOTHING
  `.execute(db);
  await sql`
    INSERT INTO collaboration_schema_migrations (version)
    VALUES (4)
    ON CONFLICT (version) DO NOTHING
  `.execute(db);
}
