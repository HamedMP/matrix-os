/**
 * Platform organization projection tables (S03 / T016, T017).
 *
 * Clerk stays the membership source of truth; these tables are a projection
 * with fixed-deadline upstream evidence. They bootstrap alongside the
 * collaboration platform tables (`collaboration/database.ts`) at composition
 * time instead of joining `PLATFORM_MIGRATION_STEPS`, whose exact table set
 * the S01 characterization fixture pins.
 */
import { sql, type ColumnType, type Kysely } from "kysely";

type Timestamp = ColumnType<Date | string, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<Date | string | null, Date | string | null | undefined, Date | string | null>;
type Generated<T> = ColumnType<T, T | undefined, T>;

export type OrganizationAiSubmission = "members" | "owner_only";
export type OrganizationLifecycle = "active" | "deleted";
export type OrganizationMembershipState = "active" | "removed";
export type OrganizationInboxOutcome = "applied" | "duplicate" | "stale" | "ignored" | "unchanged" | "failed";
export type CollaborationDenialState = "pending" | "completed";

export interface OrganizationsTable {
  organization_id: string;
  name: string;
  slug: string;
  ai_submission: OrganizationAiSubmission;
  lifecycle: OrganizationLifecycle;
  membership_epoch: Generated<number | string>;
  source_updated_at: Timestamp;
  verified_at: NullableTimestamp;
  updated_at: Timestamp;
}

export interface OrganizationMembershipsTable {
  organization_id: string;
  actor_id: string;
  membership_id: string;
  role: string;
  state: OrganizationMembershipState;
  membership_epoch: number | string;
  source_updated_at: Timestamp;
  updated_at: Timestamp;
}

export interface OrganizationWebhookInboxTable {
  event_id: string;
  event_type: string;
  payload_hash: string;
  received_at: Timestamp;
  processed_at: NullableTimestamp;
  outcome: OrganizationInboxOutcome | null;
}

export interface CollaborationDenialsTable {
  denial_id: string;
  organization_id: string | null;
  actor_id: string | null;
  scope_id: string | null;
  generation: number | string;
  fenced_at: Timestamp;
  ack_deadline: Timestamp;
  state: CollaborationDenialState;
  acknowledged_at: NullableTimestamp;
  created_at: Timestamp;
}

export interface CollaborationDenialRuntimesTable {
  denial_id: string;
  runtime_id: string;
  acknowledged_at: NullableTimestamp;
  attempts: Generated<number>;
  next_attempt_at: Timestamp;
  dead_letter: Generated<boolean>;
}

export interface OrganizationPlatformDatabase {
  organizations: OrganizationsTable;
  organization_memberships: OrganizationMembershipsTable;
  organization_webhook_inbox: OrganizationWebhookInboxTable;
  collaboration_denials: CollaborationDenialsTable;
  collaboration_denial_runtimes: CollaborationDenialRuntimesTable;
}

export async function bootstrapPlatformOrganizationDatabase(
  db: Kysely<OrganizationPlatformDatabase>,
): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS organizations (
      organization_id TEXT PRIMARY KEY CHECK (char_length(organization_id) BETWEEN 1 AND 128),
      name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
      slug TEXT NOT NULL CHECK (char_length(slug) BETWEEN 1 AND 200),
      ai_submission TEXT NOT NULL CHECK (ai_submission IN ('members', 'owner_only')),
      lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'deleted')),
      membership_epoch BIGINT NOT NULL DEFAULT 0 CHECK (membership_epoch >= 0),
      source_updated_at TIMESTAMPTZ NOT NULL,
      verified_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS organization_memberships (
      organization_id TEXT NOT NULL REFERENCES organizations(organization_id) ON DELETE CASCADE,
      actor_id TEXT NOT NULL CHECK (char_length(actor_id) BETWEEN 1 AND 128),
      membership_id TEXT NOT NULL CHECK (char_length(membership_id) BETWEEN 1 AND 128),
      role TEXT NOT NULL CHECK (char_length(role) BETWEEN 1 AND 64),
      state TEXT NOT NULL CHECK (state IN ('active', 'removed')),
      membership_epoch BIGINT NOT NULL CHECK (membership_epoch >= 0),
      source_updated_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (organization_id, actor_id)
    )
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_organization_memberships_actor_active
      ON organization_memberships(actor_id, organization_id) WHERE state = 'active'
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS organization_webhook_inbox (
      event_id TEXT PRIMARY KEY CHECK (char_length(event_id) BETWEEN 1 AND 128),
      event_type TEXT NOT NULL CHECK (char_length(event_type) BETWEEN 1 AND 80),
      payload_hash TEXT NOT NULL CHECK (char_length(payload_hash) = 64),
      received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      processed_at TIMESTAMPTZ,
      outcome TEXT CHECK (outcome IN ('applied', 'duplicate', 'stale', 'ignored', 'unchanged', 'failed'))
    )
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_organization_webhook_inbox_received_at ON organization_webhook_inbox(received_at)
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS collaboration_denials (
      denial_id UUID PRIMARY KEY,
      organization_id TEXT CHECK (organization_id IS NULL OR char_length(organization_id) BETWEEN 1 AND 128),
      actor_id TEXT CHECK (actor_id IS NULL OR char_length(actor_id) BETWEEN 1 AND 128),
      scope_id UUID,
      generation BIGINT NOT NULL CHECK (generation > 0),
      fenced_at TIMESTAMPTZ NOT NULL,
      ack_deadline TIMESTAMPTZ NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'completed')),
      acknowledged_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (organization_id IS NOT NULL OR actor_id IS NOT NULL OR scope_id IS NOT NULL),
      CHECK ((state = 'completed') = (acknowledged_at IS NOT NULL))
    )
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_collaboration_denials_pending
      ON collaboration_denials(ack_deadline) WHERE state = 'pending'
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS collaboration_denial_runtimes (
      denial_id UUID NOT NULL REFERENCES collaboration_denials(denial_id) ON DELETE CASCADE,
      runtime_id TEXT NOT NULL CHECK (char_length(runtime_id) BETWEEN 1 AND 128),
      acknowledged_at TIMESTAMPTZ,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      next_attempt_at TIMESTAMPTZ NOT NULL,
      dead_letter BOOLEAN NOT NULL DEFAULT false,
      PRIMARY KEY (denial_id, runtime_id)
    )
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_collaboration_denial_runtimes_due
      ON collaboration_denial_runtimes(next_attempt_at) WHERE acknowledged_at IS NULL AND dead_letter = false
  `.execute(db);
}
