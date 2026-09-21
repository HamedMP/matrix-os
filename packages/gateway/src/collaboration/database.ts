import type { ColumnType, Generated, Kysely } from "kysely";
import type { CollaborationRuntimeIdentityTable } from "./runtime-identity.js";
import { applyCollaborationBaseSchema, COLLABORATION_VERSIONED_MIGRATIONS } from "./database-migrations.js";
import type { ChatDatabase } from "../chat/database.js";

type Timestamp = ColumnType<Date | string, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<Date | string | null, Date | string | null | undefined, Date | string | null>;
type JsonValue = ColumnType<unknown, unknown, unknown>;

export interface CollaborationScopesTable {
  id: string;
  owner_type: "personal" | "organization";
  owner_id: string;
  /** Owning organization (Clerk org ID). Null only on pre-S20 rows, which the precondition denies. */
  organization_id: string | null;
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
  /** Organization the grant derives from; always the scope's organization. */
  organization_id: string | null;
  invitation_id: string | null;
  invited_by: string;
  accepted_at: NullableTimestamp;
  expires_at: NullableTimestamp;
  revision: ColumnType<number, number | undefined, number>;
  joined_at: NullableTimestamp;
  updated_at: Timestamp;
  /** S04: set when a legacy role row was retired in favour of a preset grant; such rows never authorize. */
  dispositioned_at: ColumnType<Date | string | null, Date | string | null | undefined, Date | string | null>;
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

export interface CollaborationDiscussionMessagesTable {
  scope_id: string;
  sequence: number;
  id: string;
  actor_id: string;
  text: string;
  scope_revision: number;
  created_at: Timestamp;
}

export interface CollaborationDiscussionUserStateTable {
  scope_id: string;
  actor_id: string;
  read_through_seq: number;
  last_opened_at: NullableTimestamp;
  updated_at: Timestamp;
}

export interface CollaborationGrantsTable {
  id: string;
  scope_id: string;
  organization_id: string;
  audience_kind: "organization" | "member";
  audience_actor_id: string | null;
  preset: "viewer" | "contributor";
  state: "pending" | "active" | "revoked" | "expired";
  policy_version: string;
  source_id: string | null;
  legacy_ceiling: "editor" | "viewer" | null;
  expires_at: NullableTimestamp;
  revision: ColumnType<number, number | undefined, number>;
  created_by: string;
  created_at: Timestamp;
  updated_at: Timestamp;
  revoked_at: NullableTimestamp;
}

export interface CollaborationGrantActivationsTable {
  grant_id: string;
  actor_id: string;
  state: "active" | "declined";
  decided_at: Timestamp;
  /** BIGINT epoch, handled as a decimal string end to end and compared with BigInt. */
  membership_evidence_epoch: ColumnType<string, string, string>;
}

export interface CollaborationDatabase {
  collaboration_grants: CollaborationGrantsTable;
  collaboration_grant_activations: CollaborationGrantActivationsTable;
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
  collaboration_discussion_messages: CollaborationDiscussionMessagesTable;
  collaboration_discussion_user_state: CollaborationDiscussionUserStateTable;
  chat_collaboration_commands: ChatCollaborationCommandsTable;
  /** S05: the home's Ed25519 runtime identity (migration 9). */
  collaboration_runtime_identity: CollaborationRuntimeIdentityTable;
}

export type OwnerCollaborationDatabase = ChatDatabase & CollaborationDatabase;

export async function bootstrapCollaborationDatabase(
  db: Kysely<OwnerCollaborationDatabase>,
): Promise<void> {
  await applyCollaborationBaseSchema(db);
  for (const step of COLLABORATION_VERSIONED_MIGRATIONS) {
    await db.transaction().execute((trx) => step.run(trx));
  }
}
