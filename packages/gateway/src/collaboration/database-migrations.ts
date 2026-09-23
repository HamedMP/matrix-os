import { migrateExecutionPoliciesV10 } from "./execution-policy.js";
import { migrateSharedRunLossV11 } from "./shared-run-loss.js";
import { migrateResourceCatalogV12 } from "./resource-catalog.js";
import { migrateProjectGitOperationsV13 } from "./project-git-operations.js";
import { migrateCapabilityGrantsV8 } from "./policy-migrations.js";
import { migrateRuntimeIdentityV9 } from "./runtime-identity.js";
import { sql, type Kysely, type Transaction } from "kysely";
import type { OwnerCollaborationDatabase } from "./database.js";

/**
 * Extracted verbatim from packages/gateway/src/collaboration/database.ts
 * bootstrapCollaborationDatabase (S01 / T008). The base schema (versions 1 and
 * 2) runs statement by statement without an enclosing transaction, exactly as
 * before; each versioned migration below runs inside its own transaction that
 * database.ts opens, preserving the original transaction scopes.
 */
export async function applyCollaborationBaseSchema(db: Kysely<OwnerCollaborationDatabase>): Promise<void> {
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
      CONSTRAINT collaboration_transitions_distinct_authority_check CHECK (
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
      CHECK (
        source_authority_runtime_id <> destination_authority_runtime_id
        OR source_authority_generation <> destination_authority_generation
      ),
      CHECK (status NOT IN ('fenced', 'committing', 'active') OR source_fence_epoch IS NOT NULL),
      CHECK (status <> 'active' OR publication_marker IS NOT NULL)
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
    INSERT INTO collaboration_schema_migrations (version)
    VALUES (1)
    ON CONFLICT (version) DO NOTHING
  `.execute(db);
  await sql`
    INSERT INTO collaboration_schema_migrations (version)
    VALUES (2)
    ON CONFLICT (version) DO NOTHING
  `.execute(db);
}

export async function migrateResourceBindingsV3(trx: Transaction<OwnerCollaborationDatabase>): Promise<void> {
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
  `.execute(trx);
  await sql`DROP INDEX IF EXISTS idx_collaboration_resource_lookup`.execute(trx);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_collaboration_resource_readiness
    ON collaboration_resource_bindings(project_scope_id, readiness)
  `.execute(trx);
  await sql`
    INSERT INTO collaboration_schema_migrations (version)
    VALUES (3)
    ON CONFLICT (version) DO NOTHING
  `.execute(trx);
}

export async function migrateLayoutAndViewStatesV4(trx: Transaction<OwnerCollaborationDatabase>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS collaboration_layout_node_revisions (
      scope_id UUID NOT NULL REFERENCES collaboration_scopes(id) ON DELETE CASCADE,
      canvas_id TEXT NOT NULL CHECK (char_length(canvas_id) BETWEEN 1 AND 256),
      node_id TEXT NOT NULL CHECK (char_length(node_id) BETWEEN 1 AND 128),
      revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (scope_id, canvas_id, node_id)
    )
  `.execute(trx);
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
  `.execute(trx);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_collaboration_layout_nodes
    ON collaboration_layout_node_revisions(scope_id, canvas_id)
  `.execute(trx);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_collaboration_project_view_actor
    ON collaboration_project_view_states(actor_id, updated_at DESC)
  `.execute(trx);
  await sql`
    INSERT INTO collaboration_schema_migrations (version)
    VALUES (4)
    ON CONFLICT (version) DO NOTHING
  `.execute(trx);
}

export async function migrateTransitionAuthorityCheckV5(trx: Transaction<OwnerCollaborationDatabase>): Promise<void> {
  await sql`
    DO $$
    DECLARE old_constraint TEXT;
    BEGIN
      SELECT conname INTO old_constraint
      FROM pg_constraint
      WHERE conrelid = 'collaboration_transitions'::regclass
        AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%source_authority_runtime_id <> destination_authority_runtime_id%'
        AND pg_get_constraintdef(oid) NOT LIKE '%source_authority_generation <> destination_authority_generation%'
      LIMIT 1;
      IF old_constraint IS NOT NULL THEN
        EXECUTE format('ALTER TABLE collaboration_transitions DROP CONSTRAINT %I', old_constraint);
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'collaboration_transitions'::regclass
          AND conname = 'collaboration_transitions_distinct_authority_check'
      ) THEN
        ALTER TABLE collaboration_transitions
        ADD CONSTRAINT collaboration_transitions_distinct_authority_check
        CHECK (
          source_authority_runtime_id <> destination_authority_runtime_id
          OR source_authority_generation <> destination_authority_generation
        );
      END IF;
    END $$
  `.execute(trx);
  await sql`
    INSERT INTO collaboration_schema_migrations (version)
    VALUES (5)
    ON CONFLICT (version) DO NOTHING
  `.execute(trx);
}

export async function migrateDiscussionV6(trx: Transaction<OwnerCollaborationDatabase>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS collaboration_discussion_messages (
      scope_id UUID NOT NULL REFERENCES collaboration_scopes(id) ON DELETE CASCADE,
      sequence BIGINT NOT NULL CHECK (sequence > 0),
      id TEXT NOT NULL CHECK (char_length(id) BETWEEN 1 AND 160),
      actor_id TEXT NOT NULL CHECK (char_length(actor_id) BETWEEN 1 AND 128),
      text TEXT NOT NULL CHECK (octet_length(text) BETWEEN 1 AND 65536),
      scope_revision BIGINT NOT NULL CHECK (scope_revision >= 0),
      created_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (scope_id, sequence),
      UNIQUE (scope_id, id)
    )
  `.execute(trx);
  await sql`
    CREATE TABLE IF NOT EXISTS collaboration_discussion_user_state (
      scope_id UUID NOT NULL REFERENCES collaboration_scopes(id) ON DELETE CASCADE,
      actor_id TEXT NOT NULL CHECK (char_length(actor_id) BETWEEN 1 AND 128),
      read_through_seq BIGINT NOT NULL DEFAULT 0 CHECK (read_through_seq >= 0),
      last_opened_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (scope_id, actor_id)
    )
  `.execute(trx);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_collaboration_discussion_messages
    ON collaboration_discussion_messages(scope_id, sequence)
  `.execute(trx);
  await sql`
    INSERT INTO collaboration_schema_migrations (version)
    VALUES (6)
    ON CONFLICT (version) DO NOTHING
  `.execute(trx);
}

/**
 * S20 / T101: every scope records its owning organization and every grant the
 * organization it derives from. The columns are nullable so the migration
 * never fails on a home that still holds pre-organization rows; those rows
 * are denied by the organization precondition, inventoried by T102 and
 * dispositioned at the S18 cutover, after which S18 tightens them to NOT
 * NULL. Write paths always populate them.
 */
async function migrateOrganizationContextV7(trx: Transaction<OwnerCollaborationDatabase>): Promise<void> {
  await sql`ALTER TABLE collaboration_scopes ADD COLUMN IF NOT EXISTS organization_id TEXT
    CHECK (organization_id IS NULL OR char_length(organization_id) BETWEEN 1 AND 128)`.execute(trx);
  await sql`ALTER TABLE collaboration_members ADD COLUMN IF NOT EXISTS organization_id TEXT
    CHECK (organization_id IS NULL OR char_length(organization_id) BETWEEN 1 AND 128)`.execute(trx);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_collaboration_scopes_organization
    ON collaboration_scopes(organization_id)
    WHERE organization_id IS NOT NULL AND deleted_at IS NULL
  `.execute(trx);
  await sql`
    INSERT INTO collaboration_schema_migrations (version)
    VALUES (7)
    ON CONFLICT (version) DO NOTHING
  `.execute(trx);
}

export interface CollaborationVersionedMigration {
  readonly version: number;
  readonly run: (trx: Transaction<OwnerCollaborationDatabase>) => Promise<void>;
}

/** Versioned migrations applied after the base schema, each in its own transaction, in this order. */
export const COLLABORATION_VERSIONED_MIGRATIONS: readonly CollaborationVersionedMigration[] = [
  { version: 3, run: migrateResourceBindingsV3 },
  { version: 4, run: migrateLayoutAndViewStatesV4 },
  { version: 5, run: migrateTransitionAuthorityCheckV5 },
  { version: 6, run: migrateDiscussionV6 },
  { version: 7, run: migrateOrganizationContextV7 },
  { version: 8, run: migrateCapabilityGrantsV8 },
  { version: 9, run: migrateRuntimeIdentityV9 },
  { version: 10, run: migrateExecutionPoliciesV10 },
  { version: 11, run: migrateSharedRunLossV11 },
  { version: 12, run: migrateResourceCatalogV12 },
  { version: 13, run: migrateProjectGitOperationsV13 },
];
