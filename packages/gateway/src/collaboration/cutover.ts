/** S18: owner-home cutover ledger. The platform coordinates homes and directory CAS. */
import { createHash } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import type { OwnerCollaborationDatabase } from "./database.js";
import type { ChatOwner } from "../chat/records.js";

export const COLLABORATION_CUTOVER_MIGRATION_VERSION = 14;
const MAX_INVENTORY_ROWS = 1024;
const MAX_DRAIN_RUNS = 64;

export async function migrateCollaborationCutoverV14(trx: Transaction<OwnerCollaborationDatabase>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS collaboration_cutover_journal (
      scope_id UUID PRIMARY KEY REFERENCES collaboration_scopes(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      runtime_id TEXT NOT NULL,
      source_generation BIGINT NOT NULL CHECK (source_generation > 0),
      target_generation BIGINT NOT NULL CHECK (target_generation > source_generation),
      idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
      phase TEXT NOT NULL CHECK (phase IN ('inventoried','fenced','drained','staged','verified','active','blocked','rolled_back')),
      inventory JSONB NOT NULL CHECK (jsonb_typeof(inventory) = 'object'),
      ceiling_digest TEXT NOT NULL CHECK (ceiling_digest ~ '^[a-f0-9]{64}$'),
      backup_ref TEXT NOT NULL,
      fence_epoch BIGINT CHECK (fence_epoch > 0),
      activated_at TIMESTAMPTZ,
      interrupted_count INTEGER NOT NULL DEFAULT 0 CHECK (interrupted_count >= 0),
      error_code TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      CHECK (phase NOT IN ('fenced','drained','staged','verified','active','rolled_back') OR fence_epoch IS NOT NULL)
    )
  `.execute(trx);
  await sql`
    CREATE TABLE IF NOT EXISTS collaboration_cutover_shadow_grants (
      scope_id UUID NOT NULL REFERENCES collaboration_cutover_journal(scope_id) ON DELETE CASCADE,
      actor_id TEXT NOT NULL,
      grant_id UUID NOT NULL UNIQUE,
      legacy_ceiling TEXT NOT NULL CHECK (legacy_ceiling IN ('editor','viewer')),
      expires_at TIMESTAMPTZ,
      PRIMARY KEY (scope_id, actor_id)
    )
  `.execute(trx);
  await sql`INSERT INTO collaboration_schema_migrations(version) VALUES (14) ON CONFLICT (version) DO NOTHING`.execute(trx);
}

export interface GatewayCutoverKey {
  scopeId: string;
  ownerId: string;
  organizationId: string;
  runtimeId: string;
  expectedSourceGeneration: number;
  targetGeneration: number;
  idempotencyKey: string;
}

export type GatewayCutoverPhase = "inventoried" | "fenced" | "drained" | "staged" | "verified" | "active" | "blocked" | "rolled_back";
export interface GatewayCutoverResult {
  scopeId: string;
  organizationId: string;
  phase: GatewayCutoverPhase;
  authorityGeneration: number;
  legacyCount: number;
  grantCount: number;
  invitationCount: number;
  nonOrganizationCount: number;
  ceilingDigest: string;
  idsDigest: string;
  backupRef: string;
  backupInventoryRef: string;
  fenceEpoch: number | null;
  fenceDigest: string | null;
  interrupted?: number;
  shadowCount?: number;
}

type Legacy = { actorId: string; role: "editor" | "viewer"; expiresAt: string | null };
type ExistingGrant = {
  id: string; actorId: string | null; audience: string; preset: string; ceiling: string | null; state: string;
  policyVersion: string; sourceId: string | null; expiresAt: string | null; revision: number;
};
type Invitation = { id: string; actorId: string; role: "editor" | "viewer"; expiresAt: string | null };
type MemberSnapshot = {
  actorId: string; role: string; status: string; organizationId: string | null;
  invitationId: string | null; expiresAt: string | null; dispositionedAt: string | null;
};
type Inventory = { lifecycle: string; members: MemberSnapshot[]; legacy: Legacy[]; grants: ExistingGrant[]; invitations: Invitation[] };
type Journal = {
  scope_id: string; owner_id: string; organization_id: string; runtime_id: string;
  source_generation: string | number; target_generation: string | number; idempotency_key: string;
  phase: GatewayCutoverPhase; inventory: Inventory; ceiling_digest: string; backup_ref: string;
  fence_epoch: string | number | null; interrupted_count: number; activated_at: Date | string | null;
};

export class GatewayCutoverError extends Error {
  constructor(readonly code: "not_found" | "conflict" | "non_organization" | "unavailable", message: string) {
    super(message);
    this.name = "GatewayCutoverError";
  }
}

function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function iso(value: Date | string | null): string | null { return value === null ? null : new Date(value).toISOString(); }
function stableGrantId(scopeId: string, actorId: string): string {
  const hash = createHash("sha256").update(`s18-legacy:${scopeId}:${actorId}`).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function checkKey(row: Journal, key: GatewayCutoverKey): void {
  if (row.owner_id !== key.ownerId || row.organization_id !== key.organizationId
    || row.runtime_id !== key.runtimeId || Number(row.source_generation) !== key.expectedSourceGeneration
    || Number(row.target_generation) !== key.targetGeneration || row.idempotency_key !== key.idempotencyKey) {
    throw new GatewayCutoverError("conflict", "Cutover binding or idempotency key changed");
  }
}

function inventoryIdsDigest(scopeId: string, inventory: Inventory): string {
  return digest({ scopeId, grantIds: inventory.grants.map((grant) => grant.id).sort(),
    invitationIds: inventory.invitations.map((invitation) => invitation.id).sort() });
}

function durableFenceDigest(scopeId: string, ceilingDigest: string, fenceEpoch: number): string {
  return digest({ scopeId, ceilingDigest, fenceEpoch });
}

type ActiveRun = { run_id: string; chat_id: string };
async function activeSharedRuns(db: Kysely<OwnerCollaborationDatabase>, scopeId: string, ownerId: string): Promise<ActiveRun[]> {
  const rows = await sql<ActiveRun>`SELECT run.id AS run_id, queued.chat_id AS chat_id
    FROM chat_queued_turns AS queued
    JOIN chat_runs AS run ON run.id = queued.claimed_run_id
    JOIN collaboration_scopes AS scope ON scope.id = queued.collaboration_scope_id
    WHERE queued.collaboration_scope_id = ${scopeId} AND scope.owner_id = ${ownerId}
      AND queued.status = 'claimed'
      AND run.status IN ('accepted', 'running', 'waiting_for_approval', 'waiting_for_input')
    ORDER BY queued.created_at, run.id LIMIT ${MAX_DRAIN_RUNS + 1}`.execute(db);
  if (rows.rows.length > MAX_DRAIN_RUNS) throw new GatewayCutoverError("unavailable", "Too many active shared runs to drain");
  return rows.rows;
}

/** Planned maintenance cancellation uses the canonical shared run orchestrator, not a loss reason. */
export async function drainActiveSharedRunsForCutover(options: {
  db: Kysely<OwnerCollaborationDatabase>;
  scopeId: string;
  ownerId: string;
  orchestrator: { cancelSharedRun(owner: ChatOwner, scopeId: string, chatId: string, runId: string): Promise<void> };
}): Promise<{ interrupted: number; remaining: number }> {
  const active = await activeSharedRuns(options.db, options.scopeId, options.ownerId);
  let interrupted = 0;
  for (const run of active) {
    try {
      await options.orchestrator.cancelSharedRun({ type: "personal", ownerId: options.ownerId },
        options.scopeId, run.chat_id, run.run_id);
      interrupted += 1;
    } catch (error: unknown) {
      // A run may complete during the drain or be orphaned on a restarted host.
      // The fresh database count below decides whether the fence may advance.
      console.warn("[collaboration] cutover run cancellation deferred", error instanceof Error ? error.name : "UnknownError");
    }
  }
  return { interrupted, remaining: (await activeSharedRuns(options.db, options.scopeId, options.ownerId)).length };
}

function result(row: Journal): GatewayCutoverResult {
  return {
    scopeId: row.scope_id, organizationId: row.organization_id,
    phase: row.phase, authorityGeneration: row.activated_at ? Number(row.target_generation) : Number(row.source_generation),
    legacyCount: row.inventory.legacy.length, grantCount: row.inventory.grants.length,
    invitationCount: row.inventory.invitations.length, nonOrganizationCount: 0,
    ceilingDigest: row.ceiling_digest, idsDigest: inventoryIdsDigest(row.scope_id, row.inventory),
    backupRef: row.backup_ref, backupInventoryRef: row.backup_ref,
    fenceEpoch: row.fence_epoch === null ? null : Number(row.fence_epoch),
    fenceDigest: row.fence_epoch === null ? null : durableFenceDigest(row.scope_id, row.ceiling_digest, Number(row.fence_epoch)),
    ...(row.phase === "drained" ? { interrupted: row.interrupted_count } : {}),
  };
}

export class GatewayCollaborationCutover {
  private readonly now: () => Date;
  constructor(private readonly db: Kysely<OwnerCollaborationDatabase>, options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  private async journal(db: Kysely<OwnerCollaborationDatabase> | Transaction<OwnerCollaborationDatabase>, key: GatewayCutoverKey, lock = false): Promise<Journal> {
    const row = await (lock
      ? sql<Journal>`SELECT * FROM collaboration_cutover_journal WHERE scope_id = ${key.scopeId} FOR UPDATE`.execute(db)
      : sql<Journal>`SELECT * FROM collaboration_cutover_journal WHERE scope_id = ${key.scopeId}`.execute(db));
    if (!row.rows[0]) throw new GatewayCutoverError("not_found", "Cutover inventory is missing");
    checkKey(row.rows[0], key);
    return row.rows[0];
  }

  /** Persist a bounded, immutable authorization inventory before freezing the scope. */
  async inventory(key: GatewayCutoverKey): Promise<GatewayCutoverResult> {
    return this.db.transaction().execute(async (trx) => {
      const scope = await trx.selectFrom("collaboration_scopes").selectAll().where("id", "=", key.scopeId).forUpdate().executeTakeFirst();
      if (!scope) throw new GatewayCutoverError("not_found", "Scope is missing");
      if (!scope.organization_id || scope.organization_id !== key.organizationId) {
        throw new GatewayCutoverError("non_organization", "Non-organization scope requires explicit disposition");
      }
      if (scope.owner_id !== key.ownerId || scope.authority_runtime_id !== key.runtimeId) {
        throw new GatewayCutoverError("conflict", "Scope authority binding changed");
      }
      const prior = await sql<Journal>`SELECT * FROM collaboration_cutover_journal WHERE scope_id = ${key.scopeId}`.execute(trx);
      if (prior.rows[0]) { checkKey(prior.rows[0], key); return result(prior.rows[0]); }
      if (Number(scope.authority_generation) !== key.expectedSourceGeneration || key.targetGeneration <= key.expectedSourceGeneration) {
        throw new GatewayCutoverError("conflict", "Source generation changed");
      }
      if (scope.lifecycle !== "shared" && scope.lifecycle !== "archived") {
        throw new GatewayCutoverError("unavailable", "Scope is not ready for cutover");
      }
      const memberRows = await trx.selectFrom("collaboration_members").select(["actor_id", "role", "status", "organization_id", "invitation_id", "expires_at", "dispositioned_at"])
        .where("scope_id", "=", key.scopeId).orderBy("actor_id").limit(MAX_INVENTORY_ROWS + 1).execute();
      const grantRows = await trx.selectFrom("collaboration_grants")
        .select(["id", "organization_id", "audience_kind", "audience_actor_id", "preset", "legacy_ceiling", "state",
          "policy_version", "source_id", "expires_at", "revision"])
        .where("scope_id", "=", key.scopeId).orderBy("id").limit(MAX_INVENTORY_ROWS + 1).execute();
      if (memberRows.length > MAX_INVENTORY_ROWS || grantRows.length > MAX_INVENTORY_ROWS) {
        throw new GatewayCutoverError("unavailable", "Cutover inventory exceeds bound");
      }
      if (memberRows.some((member) => member.organization_id !== key.organizationId)
        || grantRows.some((grant) => grant.organization_id !== key.organizationId)) {
        throw new GatewayCutoverError("non_organization", "Non-organization membership requires explicit disposition");
      }
      const inventory: Inventory = {
        lifecycle: scope.lifecycle,
        members: memberRows.map((member) => ({ actorId: member.actor_id, role: member.role, status: member.status,
          organizationId: member.organization_id, invitationId: member.invitation_id,
          expiresAt: iso(member.expires_at), dispositionedAt: iso(member.dispositioned_at) })),
        legacy: memberRows.filter((member) => member.status === "accepted" && (member.role === "editor" || member.role === "viewer"))
          .map((member) => ({ actorId: member.actor_id, role: member.role as "editor" | "viewer", expiresAt: iso(member.expires_at) })),
        invitations: memberRows.filter((member) => member.status === "pending" && member.invitation_id !== null)
          .map((member) => ({ id: member.invitation_id!, actorId: member.actor_id,
            role: member.role as "editor" | "viewer", expiresAt: iso(member.expires_at) })),
        grants: grantRows.map((grant) => ({ id: grant.id, actorId: grant.audience_actor_id, audience: grant.audience_kind,
          preset: grant.preset, ceiling: grant.legacy_ceiling, state: grant.state,
          policyVersion: grant.policy_version, sourceId: grant.source_id,
          expiresAt: iso(grant.expires_at), revision: Number(grant.revision) })),
      };
      const liveGrantActors = new Set(inventory.grants.filter((grant) => grant.audience === "member"
        && (grant.state === "active" || grant.state === "pending")).map((grant) => grant.actorId));
      if (inventory.legacy.some((member) => liveGrantActors.has(member.actorId))) {
        throw new GatewayCutoverError("conflict", "Legacy actor is already covered by a live grant; resolve ceiling first");
      }
      const ceilingDigest = digest({ members: inventory.members, legacy: inventory.legacy,
        grants: inventory.grants, invitations: inventory.invitations });
      const backupRef = `cutover:${key.scopeId}:${ceilingDigest}`;
      const now = this.now().toISOString();
      await sql`INSERT INTO collaboration_cutover_journal
        (scope_id, owner_id, organization_id, runtime_id, source_generation, target_generation,
         idempotency_key, phase, inventory, ceiling_digest, backup_ref, created_at, updated_at)
        VALUES (${key.scopeId}, ${key.ownerId}, ${key.organizationId}, ${key.runtimeId},
          ${key.expectedSourceGeneration}, ${key.targetGeneration}, ${key.idempotencyKey},
          'inventoried', ${JSON.stringify(inventory)}::jsonb, ${ceilingDigest}, ${backupRef}, ${now}, ${now})`.execute(trx);
      return { scopeId: key.scopeId, organizationId: key.organizationId,
        phase: "inventoried", authorityGeneration: key.expectedSourceGeneration, legacyCount: inventory.legacy.length,
        grantCount: inventory.grants.length, invitationCount: inventory.invitations.length,
        nonOrganizationCount: 0, ceilingDigest, idsDigest: inventoryIdsDigest(key.scopeId, inventory),
        backupRef, backupInventoryRef: backupRef, fenceEpoch: null, fenceDigest: null };
    });
  }

  /** Recovering lifecycle denies ordinary authorization; epoch invalidates prior tickets. */
  async freeze(key: GatewayCutoverKey): Promise<GatewayCutoverResult> {
    return this.db.transaction().execute(async (trx) => {
      const row = await this.journal(trx, key, true);
      if (row.phase !== "inventoried") return result(row);
      const updated = await trx.updateTable("collaboration_scopes").set((eb) => ({ lifecycle: "recovering", auth_epoch: eb("auth_epoch", "+", 1), updated_at: this.now().toISOString() }))
        .where("id", "=", key.scopeId).where("authority_generation", "=", key.expectedSourceGeneration)
        .where("lifecycle", "=", row.inventory.lifecycle as "shared" | "archived")
        .returning("auth_epoch").executeTakeFirst();
      if (!updated) throw new GatewayCutoverError("conflict", "Source scope changed before fence");
      const fenceEpoch = Number(updated.auth_epoch);
      await sql`UPDATE collaboration_cutover_journal SET phase = 'fenced', fence_epoch = ${fenceEpoch}, updated_at = ${this.now().toISOString()}
        WHERE scope_id = ${key.scopeId} AND phase = 'inventoried'`.execute(trx);
      return { ...result(row), phase: "fenced", fenceEpoch,
        fenceDigest: durableFenceDigest(key.scopeId, row.ceiling_digest, fenceEpoch) };
    });
  }

  /** The caller uses canonical run-loss interruption and returns a fresh active-run count. */
  async drain(key: GatewayCutoverKey, interrupt: () => Promise<{ interrupted: number; remaining: number }>): Promise<GatewayCutoverResult> {
    const current = await this.journal(this.db, key);
    if (current.phase !== "fenced") {
      if (["drained", "staged", "verified", "active"].includes(current.phase)) return result(current);
      throw new GatewayCutoverError("conflict", "Cutover is not fenced");
    }
    const drained = await interrupt();
    const active = await activeSharedRuns(this.db, key.scopeId, key.ownerId);
    if (drained.remaining !== 0 || active.length !== 0 || drained.interrupted < 0) {
      throw new GatewayCutoverError("unavailable", "Shared runs remain active");
    }
    return this.db.transaction().execute(async (trx) => {
      const row = await this.journal(trx, key, true);
      if (row.phase !== "fenced") return result(row);
      await sql`UPDATE collaboration_cutover_journal SET phase = 'drained', interrupted_count = ${drained.interrupted},
        updated_at = ${this.now().toISOString()} WHERE scope_id = ${key.scopeId}`.execute(trx);
      return { ...result(row), phase: "drained", interrupted: drained.interrupted };
    });
  }

  /** Shadow rows preserve exact legacy ceilings; no live grant changes occur until activation. */
  async stage(key: GatewayCutoverKey): Promise<GatewayCutoverResult> {
    return this.db.transaction().execute(async (trx) => {
      const row = await this.journal(trx, key, true);
      if (["staged", "verified", "active"].includes(row.phase)) return { ...result(row), shadowCount: row.inventory.legacy.length };
      if (row.phase !== "drained") throw new GatewayCutoverError("conflict", "Cutover is not drained");
      if (row.inventory.invitations.length) {
        throw new GatewayCutoverError("conflict", "Pending legacy invitations require explicit disposition");
      }
      for (const legacy of row.inventory.legacy) {
        await sql`INSERT INTO collaboration_cutover_shadow_grants(scope_id, actor_id, grant_id, legacy_ceiling, expires_at)
          VALUES (${key.scopeId}, ${legacy.actorId}, ${stableGrantId(key.scopeId, legacy.actorId)}, ${legacy.role}, ${legacy.expiresAt})
          ON CONFLICT (scope_id, actor_id) DO NOTHING`.execute(trx);
      }
      await sql`UPDATE collaboration_cutover_journal SET phase = 'staged', updated_at = ${this.now().toISOString()}
        WHERE scope_id = ${key.scopeId}`.execute(trx);
      return { ...result(row), phase: "staged", shadowCount: row.inventory.legacy.length };
    });
  }

  async verify(key: GatewayCutoverKey): Promise<GatewayCutoverResult> {
    return this.db.transaction().execute(async (trx) => {
      const row = await this.journal(trx, key, true);
      if (row.phase === "verified" || row.phase === "active") return result(row);
      if (row.phase !== "staged") throw new GatewayCutoverError("conflict", "Cutover is not staged");
      const shadows = await sql<{ actor_id: string; grant_id: string; legacy_ceiling: string }>`
        SELECT actor_id, grant_id, legacy_ceiling FROM collaboration_cutover_shadow_grants
        WHERE scope_id = ${key.scopeId} ORDER BY actor_id`.execute(trx);
      if (shadows.rows.length !== row.inventory.legacy.length || shadows.rows.some((shadow, index) =>
        shadow.actor_id !== row.inventory.legacy[index]?.actorId || shadow.legacy_ceiling !== row.inventory.legacy[index]?.role
        || shadow.grant_id !== stableGrantId(key.scopeId, shadow.actor_id))) {
        throw new GatewayCutoverError("conflict", "Shadow grant count or ceiling changed");
      }
      const members = await trx.selectFrom("collaboration_members").select(["actor_id", "role", "status", "invitation_id", "expires_at", "organization_id", "dispositioned_at"])
        .where("scope_id", "=", key.scopeId).orderBy("actor_id").execute();
      const grants = await trx.selectFrom("collaboration_grants")
        .select(["id", "audience_actor_id", "audience_kind", "preset", "legacy_ceiling", "state", "organization_id",
          "policy_version", "source_id", "expires_at", "revision"])
        .where("scope_id", "=", key.scopeId).orderBy("id").execute();
      const actual = { members: members.map((member) => ({ actorId: member.actor_id, role: member.role, status: member.status,
        organizationId: member.organization_id, invitationId: member.invitation_id,
        expiresAt: iso(member.expires_at), dispositionedAt: iso(member.dispositioned_at) })),
      legacy: members.filter((member) => member.status === "accepted" && (member.role === "editor" || member.role === "viewer"))
        .map((member) => ({ actorId: member.actor_id, role: member.role, expiresAt: iso(member.expires_at) })),
      grants: grants.map((grant) => ({ id: grant.id, actorId: grant.audience_actor_id, audience: grant.audience_kind,
        preset: grant.preset, ceiling: grant.legacy_ceiling, state: grant.state,
        policyVersion: grant.policy_version, sourceId: grant.source_id,
        expiresAt: iso(grant.expires_at), revision: Number(grant.revision) })),
      invitations: members.filter((member) => member.status === "pending" && member.invitation_id !== null)
        .map((member) => ({ id: member.invitation_id!, actorId: member.actor_id, role: member.role,
          expiresAt: iso(member.expires_at) })) };
      if (members.some((member) => member.organization_id !== key.organizationId)
        || grants.some((grant) => grant.organization_id !== key.organizationId)
        || digest(actual) !== row.ceiling_digest) {
        throw new GatewayCutoverError("conflict", "Source ceiling changed after inventory");
      }
      await sql`UPDATE collaboration_cutover_journal SET phase = 'verified', updated_at = ${this.now().toISOString()}
        WHERE scope_id = ${key.scopeId}`.execute(trx);
      return { ...result(row), phase: "verified" };
    });
  }

  /** One transaction imports the shadow, retires roles, CASes generation and reopens direct authority. */
  async activate(key: GatewayCutoverKey): Promise<GatewayCutoverResult> {
    return this.db.transaction().execute(async (trx) => {
      const row = await this.journal(trx, key, true);
      if (row.phase === "active") return result(row);
      if (row.phase !== "verified") throw new GatewayCutoverError("conflict", "Cutover is not verified");
      const scope = await trx.selectFrom("collaboration_scopes").select(["authority_generation", "auth_epoch", "lifecycle"])
        .where("id", "=", key.scopeId).forUpdate().executeTakeFirst();
      if (!scope || Number(scope.authority_generation) !== key.expectedSourceGeneration
        || Number(scope.auth_epoch) !== Number(row.fence_epoch) || scope.lifecycle !== "recovering") {
        throw new GatewayCutoverError("conflict", "Source generation or fence changed");
      }
      const now = this.now().toISOString();
      for (const legacy of row.inventory.legacy) {
        const grantId = stableGrantId(key.scopeId, legacy.actorId);
        await sql`INSERT INTO collaboration_grants
          (id, scope_id, organization_id, audience_kind, audience_actor_id, preset, state,
           policy_version, source_id, legacy_ceiling, expires_at, revision, created_by, created_at, updated_at)
          VALUES (${grantId}, ${key.scopeId}, ${key.organizationId}, 'member', ${legacy.actorId},
            ${legacy.role === "editor" ? "contributor" : "viewer"}, 'active', 'legacy-cutover',
            ${`collaboration_members:${legacy.actorId}`}, ${legacy.role}, ${legacy.expiresAt}, 1, ${key.ownerId}, ${now}, ${now})
          ON CONFLICT (id) DO NOTHING`.execute(trx);
        const installed = await trx.selectFrom("collaboration_grants")
          .select(["scope_id", "organization_id", "audience_kind", "audience_actor_id", "preset", "state", "legacy_ceiling"])
          .where("id", "=", grantId).executeTakeFirst();
        if (!installed || installed.scope_id !== key.scopeId || installed.organization_id !== key.organizationId
          || installed.audience_kind !== "member" || installed.audience_actor_id !== legacy.actorId
          || installed.preset !== (legacy.role === "editor" ? "contributor" : "viewer")
          || installed.state !== "active" || installed.legacy_ceiling !== legacy.role) {
          throw new GatewayCutoverError("conflict", "Shadow grant identity or ceiling changed");
        }
        const retired = await trx.updateTable("collaboration_members")
          .set((eb) => ({ status: "revoked", dispositioned_at: now, revision: eb("revision", "+", 1), updated_at: now }))
          .where("scope_id", "=", key.scopeId).where("actor_id", "=", legacy.actorId)
          .where("status", "=", "accepted").where("role", "=", legacy.role).where("organization_id", "=", key.organizationId)
          .returning("actor_id").executeTakeFirst();
        if (!retired) throw new GatewayCutoverError("conflict", "Legacy role changed during activation");
      }
      const changed = await trx.updateTable("collaboration_scopes").set((eb) => ({
        lifecycle: row.inventory.lifecycle as "shared" | "archived", authority_generation: key.targetGeneration,
        auth_epoch: eb("auth_epoch", "+", 1), updated_at: now,
      })).where("id", "=", key.scopeId).where("authority_generation", "=", key.expectedSourceGeneration)
        .where("auth_epoch", "=", Number(row.fence_epoch)).where("lifecycle", "=", "recovering")
        .returning("id").executeTakeFirst();
      if (!changed) throw new GatewayCutoverError("conflict", "Source generation changed during activation");
      await sql`UPDATE collaboration_cutover_journal SET phase = 'active', activated_at = ${now}, updated_at = ${now}
        WHERE scope_id = ${key.scopeId} AND phase = 'verified'`.execute(trx);
      return { ...result(row), phase: "active", authorityGeneration: key.targetGeneration };
    });
  }

  /** The platform proves the older bundle still speaks the direct protocol; no ACL restoration occurs. */
  async rollbackCompatible(key: GatewayCutoverKey, proof: { compatibleDirectBuild: boolean }): Promise<GatewayCutoverResult> {
    if (!proof.compatibleDirectBuild) throw new GatewayCutoverError("unavailable", "Compatible direct build is required");
    return this.db.transaction().execute(async (trx) => {
      const row = await this.journal(trx, key, true);
      if (row.phase === "rolled_back") return result(row);
      if (row.phase !== "active") throw new GatewayCutoverError("conflict", "Cutover is not active");
      const scope = await trx.selectFrom("collaboration_scopes").select("authority_generation")
        .where("id", "=", key.scopeId).forUpdate().executeTakeFirst();
      if (!scope || Number(scope.authority_generation) !== key.targetGeneration) {
        throw new GatewayCutoverError("conflict", "Direct generation changed");
      }
      await sql`UPDATE collaboration_cutover_journal SET phase = 'rolled_back', updated_at = ${this.now().toISOString()}
        WHERE scope_id = ${key.scopeId}`.execute(trx);
      return { ...result(row), phase: "rolled_back" };
    });
  }

  /** Fails closed for existing direct sessions if the platform cannot keep a compatible build serving. */
  async disable(key: GatewayCutoverKey): Promise<GatewayCutoverResult> {
    return this.db.transaction().execute(async (trx) => {
      const row = await this.journal(trx, key, true);
      if (row.phase === "blocked") return result(row);
      if (row.phase !== "active" && row.phase !== "rolled_back") {
        throw new GatewayCutoverError("conflict", "Cutover is not active");
      }
      const updated = await trx.updateTable("collaboration_scopes").set((eb) => ({
        lifecycle: "recovering", auth_epoch: eb("auth_epoch", "+", 1), updated_at: this.now().toISOString(),
      })).where("id", "=", key.scopeId).where("authority_generation", "=", key.targetGeneration)
        .where("lifecycle", "=", row.inventory.lifecycle as "shared" | "archived")
        .returning("auth_epoch").executeTakeFirst();
      if (!updated) throw new GatewayCutoverError("conflict", "Direct generation or lifecycle changed");
      await sql`UPDATE collaboration_cutover_journal SET phase = 'blocked', fence_epoch = ${Number(updated.auth_epoch)},
        error_code = 'direct_unavailable', updated_at = ${this.now().toISOString()} WHERE scope_id = ${key.scopeId}`.execute(trx);
      return { ...result(row), phase: "blocked", fenceEpoch: Number(updated.auth_epoch),
        fenceDigest: durableFenceDigest(key.scopeId, row.ceiling_digest, Number(updated.auth_epoch)) };
    });
  }

  /** A recovery gate for write paths that do not use CollaborationAuthority. */
  async assertWritable(scopeId: string): Promise<void> {
    const row = await sql<{ phase: GatewayCutoverPhase }>`SELECT phase FROM collaboration_cutover_journal WHERE scope_id = ${scopeId}`.execute(this.db);
    if (row.rows[0] && !["inventoried", "active", "rolled_back"].includes(row.rows[0].phase)) {
      throw new GatewayCutoverError("unavailable", "Collaboration is in maintenance");
    }
  }

  /** Runtime-wide gate covers owner proof routes that do not call CollaborationAuthority. */
  async assertRuntimeWritable(runtimeId: string): Promise<void> {
    const row = await sql<{ scope_id: string }>`SELECT scope_id FROM collaboration_cutover_journal
      WHERE runtime_id = ${runtimeId} AND phase IN ('fenced', 'drained', 'staged', 'verified', 'blocked')
      LIMIT 1`.execute(this.db);
    if (row.rows[0]) throw new GatewayCutoverError("unavailable", "Collaboration is in maintenance");
  }
}
