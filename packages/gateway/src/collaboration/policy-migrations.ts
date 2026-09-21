/**
 * S04 / T021, T024: capability grant schema (gateway migration 8) and the
 * explicit disposition of legacy role rows.
 *
 * `collaboration_grants` holds one whole-project preset per grant. An
 * organization-wide grant is one row with audience `organization`; it never
 * fans out. `collaboration_grant_activations` holds the per-member decision
 * for such grants: no row is pending, `active` is participation and
 * `declined` durably suppresses the item. Accept is one atomic upsert that
 * inserts or reactivates a declined row; GET reads never activate.
 *
 * Legacy `collaboration_members` rows (pre-organization editor/viewer roles)
 * are never auto-converted at bootstrap. `dispositionLegacyMembers` is the
 * explicit, owner-invoked (or S18 cutover) conversion that records the exact
 * old ceiling so a converted editor never gains actions the old role lacked,
 * and retires the legacy row (`status = 'revoked'`, `dispositioned_at`) in the
 * same transaction so the new grant is the only authority for that actor.
 */
import { sql, type Kysely, type Transaction } from "kysely";
import { MAX_GRANTS_PER_SCOPE } from "./capability-repository.js";
import type { OwnerCollaborationDatabase } from "./database.js";
import {
  appendMutationRecords,
  CollaborationRepositoryError,
  lockDirectScope,
  requireAcceptedOwner,
} from "./repository-shared.js";

export const COLLABORATION_GRANTS_MIGRATION_VERSION = 8;

export async function migrateCapabilityGrantsV8(trx: Transaction<OwnerCollaborationDatabase>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS collaboration_grants (
      id UUID PRIMARY KEY,
      scope_id UUID NOT NULL REFERENCES collaboration_scopes(id) ON DELETE CASCADE,
      organization_id TEXT NOT NULL CHECK (char_length(organization_id) BETWEEN 1 AND 128),
      audience_kind TEXT NOT NULL CHECK (audience_kind IN ('organization', 'member')),
      audience_actor_id TEXT CHECK (audience_actor_id IS NULL OR char_length(audience_actor_id) BETWEEN 1 AND 128),
      preset TEXT NOT NULL CHECK (preset IN ('viewer', 'contributor')),
      state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'revoked', 'expired')),
      policy_version TEXT NOT NULL CHECK (char_length(policy_version) BETWEEN 1 AND 160),
      source_id TEXT CHECK (source_id IS NULL OR char_length(source_id) BETWEEN 1 AND 256),
      legacy_ceiling TEXT CHECK (legacy_ceiling IS NULL OR legacy_ceiling IN ('editor', 'viewer')),
      expires_at TIMESTAMPTZ,
      revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
      created_by TEXT NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 128),
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      CONSTRAINT collaboration_grants_audience_check CHECK (
        (audience_kind = 'organization' AND audience_actor_id IS NULL)
        OR (audience_kind = 'member' AND audience_actor_id IS NOT NULL)
      )
    )
  `.execute(trx);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_collaboration_grants_one_organization
    ON collaboration_grants(scope_id)
    WHERE audience_kind = 'organization' AND state IN ('pending', 'active')
  `.execute(trx);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_collaboration_grants_one_member
    ON collaboration_grants(scope_id, audience_actor_id)
    WHERE audience_kind = 'member' AND state IN ('pending', 'active')
  `.execute(trx);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_collaboration_grants_scope_state
    ON collaboration_grants(scope_id, state)
  `.execute(trx);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_collaboration_grants_organization_state
    ON collaboration_grants(organization_id, state)
    WHERE audience_kind = 'organization'
  `.execute(trx);
  await sql`
    CREATE TABLE IF NOT EXISTS collaboration_grant_activations (
      grant_id UUID NOT NULL REFERENCES collaboration_grants(id) ON DELETE CASCADE,
      actor_id TEXT NOT NULL CHECK (char_length(actor_id) BETWEEN 1 AND 128),
      state TEXT NOT NULL CHECK (state IN ('active', 'declined')),
      decided_at TIMESTAMPTZ NOT NULL,
      membership_evidence_epoch BIGINT NOT NULL CHECK (membership_evidence_epoch >= 0),
      PRIMARY KEY (grant_id, actor_id)
    )
  `.execute(trx);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_collaboration_grant_activations_actor
    ON collaboration_grant_activations(actor_id, state)
  `.execute(trx);
  await sql`ALTER TABLE collaboration_members ADD COLUMN IF NOT EXISTS dispositioned_at TIMESTAMPTZ`.execute(trx);
  await sql`
    INSERT INTO collaboration_schema_migrations (version)
    VALUES (${COLLABORATION_GRANTS_MIGRATION_VERSION})
    ON CONFLICT (version) DO NOTHING
  `.execute(trx);
}

export interface LegacyDispositionInput {
  scopeId: string;
  /** The scope owner; only the owner may re-home their legacy members. */
  actorId: string;
  now: () => Date;
  createId: () => string;
}

export interface LegacyDispositionResult {
  converted: number;
  skipped: number;
  /** Legacy rows still awaiting disposition after this bounded batch; callers repeat until zero. */
  remaining: number;
}

/** Legacy rows processed per call; bounded so no unbounded in-memory collection is built. */
export const LEGACY_DISPOSITION_BATCH_SIZE = MAX_GRANTS_PER_SCOPE;

/**
 * Converts accepted, non-owner legacy member rows of one scope into member
 * grants that carry the exact old role as their ceiling. Idempotent: a row
 * that already has a pending or active grant is skipped. Processes at most
 * LEGACY_DISPOSITION_BATCH_SIZE rows per call and reports `remaining` so the
 * caller repeats until zero. Runs in one transaction with the scope row
 * locked and an audit record per conversion.
 * Never called automatically; S18 executes it as part of the recorded
 * disposition and the owner can invoke it explicitly.
 */
export async function dispositionLegacyMembers(
  db: Kysely<OwnerCollaborationDatabase>,
  input: LegacyDispositionInput,
): Promise<LegacyDispositionResult> {
  const nowDate = input.now();
  const now = nowDate.toISOString();
  return db.transaction().execute(async (trx) => {
    const scope = await lockDirectScope(trx, input.scopeId);
    await requireAcceptedOwner(trx, input.scopeId, input.actorId);
    if (!scope.organization_id) {
      throw new CollaborationRepositoryError("conflict", "Scope has no organization context");
    }
    const legacy = await trx.selectFrom("collaboration_members")
      .select(["actor_id", "role", "expires_at", "revision"])
      .where("scope_id", "=", input.scopeId)
      .where("status", "=", "accepted")
      .where("role", "in", ["editor", "viewer"])
      .where("dispositioned_at", "is", null)
      .orderBy("actor_id")
      .limit(LEGACY_DISPOSITION_BATCH_SIZE)
      .forUpdate()
      .execute();
    let converted = 0;
    let skipped = 0;
    for (const row of legacy) {
      // Database-side existence check per row: no in-memory set of the scope's grants is built.
      const covered = await trx.selectFrom("collaboration_grants")
        .select("id")
        .where("scope_id", "=", input.scopeId)
        .where("audience_kind", "=", "member")
        .where("audience_actor_id", "=", row.actor_id)
        .where("state", "in", ["pending", "active"])
        .executeTakeFirst();
      if (covered) {
        skipped += 1;
        continue;
      }
      const legacyRole = row.role as "editor" | "viewer";
      await trx.insertInto("collaboration_grants").values({
        id: input.createId(),
        scope_id: input.scopeId,
        organization_id: scope.organization_id,
        audience_kind: "member",
        audience_actor_id: row.actor_id,
        preset: legacyRole === "editor" ? "contributor" : "viewer",
        state: "active",
        policy_version: "legacy-disposition",
        source_id: `collaboration_members:${row.actor_id}`,
        legacy_ceiling: legacyRole,
        expires_at: row.expires_at,
        revision: 1,
        created_by: input.actorId,
        created_at: now,
        updated_at: now,
        revoked_at: null,
      }).execute();
      // Retire the legacy row in the same transaction so the grant is the only authority for this actor:
      // revoking the grant later must end access, and the authority evaluator never reads a retired row.
      const retired = await trx.updateTable("collaboration_members").set({
        status: "revoked",
        dispositioned_at: now,
        revision: Number(row.revision) + 1,
        updated_at: now,
      }).where("scope_id", "=", input.scopeId)
        .where("actor_id", "=", row.actor_id)
        .where("revision", "=", Number(row.revision))
        .returning("actor_id")
        .executeTakeFirst();
      if (!retired) throw new CollaborationRepositoryError("conflict", "Membership revision changed");
      await appendMutationRecords(trx, {
        scope,
        actorId: input.actorId,
        action: "grant.legacy_dispositioned",
        recipients: [{ actorId: row.actor_id }],
        discoveryState: "accepted",
        publishDirectory: false,
        now,
        reasonCode: `legacy_${legacyRole}`,
      });
      converted += 1;
    }
    const pending = await trx.selectFrom("collaboration_members")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("scope_id", "=", input.scopeId)
      .where("status", "=", "accepted")
      .where("role", "in", ["editor", "viewer"])
      .where("dispositioned_at", "is", null)
      .executeTakeFirstOrThrow();
    return { converted, skipped, remaining: Number(pending.count) };
  });
}
