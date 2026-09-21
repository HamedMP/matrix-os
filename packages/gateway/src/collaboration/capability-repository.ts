/**
 * S04 / T021, T024: whole-project preset grants and per-member activations.
 *
 * Every mutation runs in one transaction with the scope row locked first
 * (home lock order: scope, grants, operation, audit/outbox), enforces the
 * expected scope revision in the UPDATE, replays by client request id and
 * payload hash, and writes its audit and directory-outbox records in the
 * same transaction. Accept and decline of an organization-wide grant are one
 * atomic upsert on `collaboration_grant_activations`; reads never activate.
 */
import { sql, type Kysely, type Transaction } from "kysely";
import type { CollaborationAudience, CollaborationPreset } from "@matrix-os/contracts";
import {
  toActivationRecord,
  toGrantRecord,
  type ActivationRecord,
  type ActivationRow,
  type GrantRecord,
  type GrantRow,
} from "./capability-records.js";
import type { OwnerCollaborationDatabase } from "./database.js";

export { toActivationRecord, toGrantRecord, type ActivationRecord, type GrantRecord, type GrantRow };
import {
  appendMutationRecords,
  CollaborationRepositoryError,
  lockDirectScope,
  OPERATION_RETENTION_MS,
  readOperationReplay,
  requireAcceptedOwner,
  type ScopeRow,
  updateScopeRevision,
  writeOperation,
} from "./repository-shared.js";

/** Contract limit: grants 100 per scope. */
export const MAX_GRANTS_PER_SCOPE = 100;
/** Bound on any in-memory participant/activation enumeration; larger audiences page through listActivations. */
export const MAX_LISTED_PARTICIPANTS = 1_000;
/** Scopes handled per departure batch; endActorGrants keeps paging until no qualifying scope remains. */
export const DEPARTURE_SCOPE_BATCH_SIZE = 100;

interface MutationKey {
  scopeId: string;
  actorId: string;
  clientRequestId: string;
  expectedRevision: number;
  payloadHash: string;
}

export interface CreateGrantInput extends MutationKey {
  audience: CollaborationAudience;
  preset: CollaborationPreset;
  policyVersion: string;
  expiresAt?: string;
}

export interface GrantMutationResult {
  grantId: string;
  scopeId: string;
  state: GrantRow["state"];
  scopeRevision: number;
  grantRevision: number;
}

export interface PatchGrantPresetInput extends MutationKey {
  grantId: string;
  expectedGrantRevision: number;
  preset: CollaborationPreset;
}

export interface RevokeGrantInput extends MutationKey {
  grantId: string;
  expectedGrantRevision: number;
}

export interface ActivationDecisionInput {
  grantId: string;
  actorId: string;
  /** Decimal-string membership epoch the decision was made under. */
  membershipEvidenceEpoch: string;
}

export interface ActorGrantResolution {
  scope: ScopeRow;
  memberGrant: GrantRow | null;
  organizationGrant: GrantRow | null;
  activation: ActivationRow | null;
}

export interface CollaborationCapabilityRepositoryOptions {
  now: () => Date;
  createId: () => string;
  maxGrantsPerScope?: number;
}

export class CollaborationCapabilityRepository {
  private readonly maxGrantsPerScope: number;

  constructor(
    readonly db: Kysely<OwnerCollaborationDatabase>,
    private readonly options: CollaborationCapabilityRepositoryOptions,
  ) {
    this.maxGrantsPerScope = options.maxGrantsPerScope ?? MAX_GRANTS_PER_SCOPE;
  }

  async createGrant(input: CreateGrantInput): Promise<GrantMutationResult> {
    const nowDate = this.options.now();
    const now = nowDate.toISOString();
    const operationExpiresAt = new Date(nowDate.getTime() + OPERATION_RETENTION_MS).toISOString();
    return this.db.transaction().execute(async (trx) => {
      const scope = await lockDirectScope(trx, input.scopeId);
      await requireAcceptedOwner(trx, input.scopeId, input.actorId);
      const replay = await readOperationReplay<GrantMutationResult>(trx, input, "grant.create");
      if (replay) return replay;
      if (scope.lifecycle !== "private" && scope.lifecycle !== "shared") {
        throw new CollaborationRepositoryError("conflict", "Scope membership is not mutable");
      }
      if (Number(scope.revision) !== input.expectedRevision) {
        throw new CollaborationRepositoryError("conflict", "Scope revision changed");
      }
      if (!scope.organization_id) {
        throw new CollaborationRepositoryError("conflict", "Scope has no organization context");
      }
      if (input.audience.kind === "member" && input.audience.actorId === scope.owner_id) {
        throw new CollaborationRepositoryError("conflict", "Owner is already a participant");
      }
      if (input.expiresAt !== undefined && Date.parse(input.expiresAt) <= nowDate.getTime()) {
        throw new CollaborationRepositoryError("conflict", "Grant expiry is in the past");
      }
      const live = await trx.selectFrom("collaboration_grants")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("scope_id", "=", input.scopeId)
        .where("state", "in", ["pending", "active"])
        .executeTakeFirstOrThrow();
      if (Number(live.count) >= this.maxGrantsPerScope) {
        throw new CollaborationRepositoryError("capacity", "Scope grant capacity reached");
      }
      const duplicate = await trx.selectFrom("collaboration_grants")
        .select("id")
        .where("scope_id", "=", input.scopeId)
        .where("state", "in", ["pending", "active"])
        .where("audience_kind", "=", input.audience.kind)
        .$if(input.audience.kind === "member", (qb) => qb.where(
          "audience_actor_id", "=", input.audience.kind === "member" ? input.audience.actorId : "",
        ))
        .executeTakeFirst();
      if (duplicate) throw new CollaborationRepositoryError("conflict", "Audience already has a grant");

      const grantId = this.options.createId();
      const state: GrantRow["state"] = input.audience.kind === "organization" ? "active" : "pending";
      await trx.insertInto("collaboration_grants").values({
        id: grantId,
        scope_id: input.scopeId,
        organization_id: scope.organization_id,
        audience_kind: input.audience.kind,
        audience_actor_id: input.audience.kind === "member" ? input.audience.actorId : null,
        preset: input.preset,
        state,
        policy_version: input.policyVersion,
        source_id: null,
        legacy_ceiling: null,
        expires_at: input.expiresAt ?? null,
        revision: 1,
        created_by: input.actorId,
        created_at: now,
        updated_at: now,
        revoked_at: null,
      }).execute();
      const nextRevision = input.expectedRevision + 1;
      await updateScopeRevision(trx, input.scopeId, input.expectedRevision, nextRevision, now);
      const result: GrantMutationResult = { grantId, scopeId: input.scopeId, state, scopeRevision: nextRevision, grantRevision: 1 };
      await writeOperation(trx, input, "grant.create", scope, result, now, operationExpiresAt);
      await appendMutationRecords(trx, {
        scope: { ...scope, revision: nextRevision, auth_epoch: Number(scope.auth_epoch) + 1 },
        actorId: input.actorId,
        action: "grant.created",
        recipients: input.audience.kind === "member" ? [{ actorId: input.audience.actorId }] : [],
        discoveryState: "invited",
        now,
        reasonCode: `${input.audience.kind}:${input.preset}`,
      });
      return result;
    });
  }

  async patchGrantPreset(input: PatchGrantPresetInput): Promise<GrantMutationResult> {
    return this.mutateGrant(input, "grant.preset_change", "grant.preset_changed", async (trx, grant, now) => {
      const updated = await trx.updateTable("collaboration_grants").set({
        preset: input.preset,
        revision: input.expectedGrantRevision + 1,
        updated_at: now,
      }).where("id", "=", grant.id)
        .where("revision", "=", input.expectedGrantRevision)
        .where("state", "in", ["pending", "active"])
        .returning(["state", "revision"])
        .executeTakeFirst();
      if (!updated) throw new CollaborationRepositoryError("conflict", "Grant revision changed");
      return { state: updated.state, grantRevision: Number(updated.revision), reasonCode: input.preset };
    });
  }

  async revokeGrant(input: RevokeGrantInput): Promise<GrantMutationResult> {
    return this.mutateGrant(input, "grant.revoke", "grant.revoked", async (trx, grant, now) => {
      const updated = await trx.updateTable("collaboration_grants").set({
        state: "revoked",
        revision: input.expectedGrantRevision + 1,
        revoked_at: now,
        updated_at: now,
      }).where("id", "=", grant.id)
        .where("revision", "=", input.expectedGrantRevision)
        .where("state", "in", ["pending", "active"])
        .returning(["state", "revision"])
        .executeTakeFirst();
      if (!updated) throw new CollaborationRepositoryError("conflict", "Grant revision changed");
      return { state: updated.state, grantRevision: Number(updated.revision) };
    });
  }

  private async mutateGrant(
    input: MutationKey & { grantId: string },
    operationKind: string,
    auditAction: string,
    apply: (trx: Transaction<OwnerCollaborationDatabase>, grant: GrantRow, now: string) =>
      Promise<{ state: GrantRow["state"]; grantRevision: number; reasonCode?: string }>,
  ): Promise<GrantMutationResult> {
    const nowDate = this.options.now();
    const now = nowDate.toISOString();
    const operationExpiresAt = new Date(nowDate.getTime() + OPERATION_RETENTION_MS).toISOString();
    return this.db.transaction().execute(async (trx) => {
      const scope = await lockDirectScope(trx, input.scopeId);
      await requireAcceptedOwner(trx, input.scopeId, input.actorId);
      const replay = await readOperationReplay<GrantMutationResult>(trx, input, operationKind);
      if (replay) return replay;
      if (Number(scope.revision) !== input.expectedRevision) {
        throw new CollaborationRepositoryError("conflict", "Scope revision changed");
      }
      const grant = await trx.selectFrom("collaboration_grants")
        .selectAll()
        .where("id", "=", input.grantId)
        .where("scope_id", "=", input.scopeId)
        .forUpdate()
        .executeTakeFirst();
      if (!grant) throw new CollaborationRepositoryError("not_found", "Grant not found");
      const applied = await apply(trx, grant, now);
      const nextRevision = input.expectedRevision + 1;
      await updateScopeRevision(trx, input.scopeId, input.expectedRevision, nextRevision, now);
      const result: GrantMutationResult = {
        grantId: grant.id, scopeId: input.scopeId, state: applied.state, scopeRevision: nextRevision, grantRevision: applied.grantRevision,
      };
      await writeOperation(trx, input, operationKind, scope, result, now, operationExpiresAt);
      const recipients = grant.audience_kind === "member" && grant.audience_actor_id
        ? [{ actorId: grant.audience_actor_id }]
        : (await this.activeActors(trx, grant.id)).map((actorId) => ({ actorId }));
      await appendMutationRecords(trx, {
        scope: { ...scope, revision: nextRevision, auth_epoch: Number(scope.auth_epoch) + 1 },
        actorId: input.actorId,
        action: auditAction,
        recipients,
        discoveryState: applied.state === "revoked" ? "revoked" : "accepted",
        now,
        ...(applied.reasonCode ? { reasonCode: applied.reasonCode } : {}),
      });
      return result;
    });
  }

  /**
   * Accept: for a member grant, the conditional pending→active update; for an
   * organization grant, the atomic per-member activation upsert that inserts
   * a new row, reactivates a declined one, or refreshes a row recorded under
   * an older membership epoch, always with fresh decision metadata; it is a
   * no-op when already active under the current epoch. The grant row is locked so a concurrent
   * revocation serializes before or after the whole decision.
   */
  async acceptGrant(input: ActivationDecisionInput): Promise<{ state: "active" }> {
    return this.decide(input, "grant.accepted", async (trx, grant, now) => {
      if (grant.audience_kind === "member") {
        if (grant.audience_actor_id !== input.actorId) {
          throw new CollaborationRepositoryError("not_found", "Grant not found");
        }
        if (grant.state === "pending") {
          const updated = await trx.updateTable("collaboration_grants").set({
            state: "active", revision: Number(grant.revision) + 1, updated_at: now,
          }).where("id", "=", grant.id).where("state", "=", "pending").returning("id").executeTakeFirst();
          if (!updated) throw new CollaborationRepositoryError("conflict", "Grant state changed");
          return true;
        }
        return false;
      }
      if (!/^\d{1,20}$/.test(input.membershipEvidenceEpoch)) {
        throw new CollaborationRepositoryError("conflict", "Membership evidence epoch is invalid");
      }
      const upserted = await sql<{ inserted: boolean }>`
        INSERT INTO collaboration_grant_activations (grant_id, actor_id, state, decided_at, membership_evidence_epoch)
        VALUES (${grant.id}, ${input.actorId}, 'active', ${now}, ${sql.raw(input.membershipEvidenceEpoch)}::bigint)
        ON CONFLICT (grant_id, actor_id) DO UPDATE
          SET state = 'active', decided_at = EXCLUDED.decided_at, membership_evidence_epoch = EXCLUDED.membership_evidence_epoch
          WHERE collaboration_grant_activations.state = 'declined'
             OR collaboration_grant_activations.membership_evidence_epoch < EXCLUDED.membership_evidence_epoch
        RETURNING (xmax = 0) AS inserted
      `.execute(trx);
      return upserted.rows.length > 0;
    }).then(() => ({ state: "active" as const }));
  }

  /** Decline: durable per-member suppression; refused once the member is active. */
  async declineGrant(input: ActivationDecisionInput): Promise<{ state: "declined" }> {
    return this.decide(input, "grant.declined", async (trx, grant, now) => {
      if (grant.audience_kind === "member") {
        if (grant.audience_actor_id !== input.actorId) {
          throw new CollaborationRepositoryError("not_found", "Grant not found");
        }
        if (grant.state !== "pending") throw new CollaborationRepositoryError("conflict", "Grant is already active");
        await trx.updateTable("collaboration_grants").set({
          state: "revoked", revision: Number(grant.revision) + 1, revoked_at: now, updated_at: now,
        }).where("id", "=", grant.id).where("state", "=", "pending").execute();
        return true;
      }
      const existing = await trx.selectFrom("collaboration_grant_activations")
        .select("state")
        .where("grant_id", "=", grant.id)
        .where("actor_id", "=", input.actorId)
        .executeTakeFirst();
      if (existing?.state === "active") throw new CollaborationRepositoryError("conflict", "Share is already active");
      if (existing?.state === "declined") return false;
      if (!/^\d{1,20}$/.test(input.membershipEvidenceEpoch)) {
        throw new CollaborationRepositoryError("conflict", "Membership evidence epoch is invalid");
      }
      await sql`
        INSERT INTO collaboration_grant_activations (grant_id, actor_id, state, decided_at, membership_evidence_epoch)
        VALUES (${grant.id}, ${input.actorId}, 'declined', ${now}, ${sql.raw(input.membershipEvidenceEpoch)}::bigint)
        ON CONFLICT (grant_id, actor_id) DO NOTHING
      `.execute(trx);
      return true;
    }).then(() => ({ state: "declined" as const }));
  }

  private async decide(
    input: ActivationDecisionInput,
    auditAction: "grant.accepted" | "grant.declined",
    apply: (trx: Transaction<OwnerCollaborationDatabase>, grant: GrantRow, now: string) => Promise<boolean>,
  ): Promise<void> {
    const nowDate = this.options.now();
    const now = nowDate.toISOString();
    await this.db.transaction().execute(async (trx) => {
      // Home lock order: scope row first, then the grant row, so two actors deciding different
      // grants on one scope serialize on the scope and never race on the event sequence.
      const located = await trx.selectFrom("collaboration_grants").select("scope_id").where("id", "=", input.grantId).executeTakeFirst();
      if (!located) throw new CollaborationRepositoryError("not_found", "Grant not found");
      const scope = await trx.selectFrom("collaboration_scopes").selectAll()
        .where("id", "=", located.scope_id).where("deleted_at", "is", null).forUpdate().executeTakeFirst();
      if (!scope || scope.lifecycle !== "shared") {
        throw new CollaborationRepositoryError("conflict", "Scope is not available");
      }
      const grant = await trx.selectFrom("collaboration_grants")
        .selectAll()
        .where("id", "=", input.grantId)
        .forUpdate()
        .executeTakeFirst();
      if (!grant || grant.state === "revoked" || grant.state === "expired") {
        throw new CollaborationRepositoryError("not_found", "Grant not found");
      }
      if (grant.expires_at !== null && new Date(grant.expires_at).getTime() <= nowDate.getTime()) {
        throw new CollaborationRepositoryError("expired", "Grant has expired");
      }
      const changed = await apply(trx, grant, now);
      if (!changed) return;
      await advanceScopeAuthEpoch(trx, scope, now);
      await appendMutationRecords(trx, {
        scope,
        actorId: input.actorId,
        action: auditAction,
        recipients: [{ actorId: input.actorId }],
        discoveryState: auditAction === "grant.accepted" ? "accepted" : "revoked",
        now,
      });
    });
  }

  /**
   * Departure ends every grant derived from the membership: member grants of
   * the actor in that organization are revoked and their activations of
   * organization-wide grants are deleted, in one transaction per scope with the
   * scope row locked, with an audit record per ended grant. S03 calls this from
   * the membership projection when it observes removal; it is idempotent.
   */
  async endActorGrants(input: { organizationId: string; actorId: string; scopeBatchSize?: number }): Promise<{ ended: number; scopes: number }> {
    const now = this.options.now().toISOString();
    const batchSize = Math.max(1, Math.min(input.scopeBatchSize ?? DEPARTURE_SCOPE_BATCH_SIZE, DEPARTURE_SCOPE_BATCH_SIZE));
    let ended = 0;
    let scopesTouched = 0;
    let after: string | null = null;
    // Keyset-page through every scope that still holds a live member grant or an activation for this actor;
    // each batch is re-queried after processing so completion is reported only when nothing qualifies.
    for (;;) {
      const batch: Array<{ scope_id: string }> = await this.db.selectFrom("collaboration_grants as g")
        .select("g.scope_id").distinct()
        .where("g.organization_id", "=", input.organizationId)
        .where((eb) => eb.or([
          eb.and([eb("g.audience_kind", "=", "member"), eb("g.audience_actor_id", "=", input.actorId), eb("g.state", "in", ["pending", "active"])]),
          eb.and([
            eb("g.audience_kind", "=", "organization"),
            eb.exists(eb.selectFrom("collaboration_grant_activations as a").select("a.grant_id")
              .whereRef("a.grant_id", "=", "g.id").where("a.actor_id", "=", input.actorId)),
          ]),
        ]))
        .$if(after !== null, (qb) => qb.where("g.scope_id", ">", after!))
        .orderBy("g.scope_id").limit(batchSize).execute();
      if (batch.length === 0) break;
      for (const { scope_id: scopeId } of batch) {
        scopesTouched += 1;
        ended += await this.endActorGrantsInScope(scopeId, input, now);
      }
      after = batch[batch.length - 1]!.scope_id;
    }
    return { ended, scopes: scopesTouched };
  }

  private async endActorGrantsInScope(scopeId: string, input: { actorId: string }, now: string): Promise<number> {
    {
      return this.db.transaction().execute(async (trx) => {
        const scope = await trx.selectFrom("collaboration_scopes").selectAll().where("id", "=", scopeId).forUpdate().executeTakeFirst();
        if (!scope) return 0;
        const revoked = await trx.updateTable("collaboration_grants").set({ state: "revoked", revoked_at: now, updated_at: now, revision: sql<number>`revision + 1` })
          .where("scope_id", "=", scopeId).where("audience_kind", "=", "member").where("audience_actor_id", "=", input.actorId)
          .where("state", "in", ["pending", "active"]).returning("id").execute();
        const deleted = await trx.deleteFrom("collaboration_grant_activations")
          .where("actor_id", "=", input.actorId)
          .where("grant_id", "in", trx.selectFrom("collaboration_grants").select("id").where("scope_id", "=", scopeId).where("audience_kind", "=", "organization"))
          .returning("grant_id").execute();
        const count = revoked.length + deleted.length;
        if (count > 0) {
          await advanceScopeAuthEpoch(trx, scope, now);
          await appendMutationRecords(trx, {
            scope, actorId: input.actorId, action: "grant.ended_by_departure",
            recipients: [{ actorId: input.actorId }], discoveryState: "revoked", now, reasonCode: "membership_ended",
          });
        }
        return count;
      });
    }
  }

  /** Lazily marks expired grants; effective access treats expiry by timestamp regardless. */
  async expireGrants(): Promise<number> {
    const now = this.options.now().toISOString();
    const rows = await this.db.updateTable("collaboration_grants").set({ state: "expired", updated_at: now })
      .where("state", "in", ["pending", "active"])
      .where("expires_at", "is not", null)
      .where("expires_at", "<=", now)
      .returning("id")
      .execute();
    return rows.length;
  }

  async getGrant(grantId: string): Promise<GrantRecord | null> {
    const row = await this.db.selectFrom("collaboration_grants").selectAll().where("id", "=", grantId).executeTakeFirst();
    return row ? toGrantRecord(row) : null;
  }

  async listGrants(scopeId: string): Promise<GrantRecord[]> {
    const rows = await this.db.selectFrom("collaboration_grants").selectAll()
      .where("scope_id", "=", scopeId).orderBy("created_at").orderBy("id").limit(MAX_GRANTS_PER_SCOPE).execute();
    return rows.map(toGrantRecord);
  }

  async listActivations(grantId: string): Promise<ActivationRecord[]> {
    const rows = await this.db.selectFrom("collaboration_grant_activations").selectAll()
      .where("grant_id", "=", grantId).orderBy("actor_id").limit(MAX_LISTED_PARTICIPANTS).execute();
    return rows.map(toActivationRecord);
  }

  /**
   * Owner plus every actor with an active member grant or an active activation of the organization grant,
   * bounded by MAX_LISTED_PARTICIPANTS (member grants are already capped by MAX_GRANTS_PER_SCOPE).
   */
  async listParticipants(scopeId: string): Promise<string[]> {
    const nowIso = this.options.now().toISOString();
    const scope = await this.db.selectFrom("collaboration_scopes").select("owner_id").where("id", "=", scopeId).executeTakeFirst();
    if (!scope) return [];
    const members = await this.db.selectFrom("collaboration_grants").select("audience_actor_id")
      .where("scope_id", "=", scopeId).where("audience_kind", "=", "member").where("state", "=", "active")
      .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", nowIso)]))
      .limit(MAX_GRANTS_PER_SCOPE)
      .execute();
    const activations = await this.db.selectFrom("collaboration_grant_activations as a")
      .innerJoin("collaboration_grants as g", "g.id", "a.grant_id")
      .select("a.actor_id")
      .where("g.scope_id", "=", scopeId).where("g.audience_kind", "=", "organization").where("g.state", "=", "active")
      .where("a.state", "=", "active")
      .where((eb) => eb.or([eb("g.expires_at", "is", null), eb("g.expires_at", ">", nowIso)]))
      .orderBy("a.decided_at").orderBy("a.actor_id")
      .limit(MAX_LISTED_PARTICIPANTS)
      .execute();
    const set = new Set<string>([scope.owner_id]);
    for (const row of members) if (row.audience_actor_id && set.size < MAX_LISTED_PARTICIPANTS) set.add(row.audience_actor_id);
    for (const row of activations) if (set.size < MAX_LISTED_PARTICIPANTS) set.add(row.actor_id);
    return [...set];
  }

  /** `Shared with me` pending items: organization grants of the actor's organization with no activation row, plus pending member grants. */
  async listPendingForActor(input: { actorId: string; organizationId: string }): Promise<Array<{ grantId: string; scopeId: string; preset: CollaborationPreset }>> {
    const nowIso = this.options.now().toISOString();
    const organizationGrants = await this.db.selectFrom("collaboration_grants as g")
      .leftJoin("collaboration_grant_activations as a", (join) => join
        .onRef("a.grant_id", "=", "g.id").on("a.actor_id", "=", input.actorId))
      .innerJoin("collaboration_scopes as s", "s.id", "g.scope_id")
      .select(["g.id", "g.scope_id", "g.preset"])
      .where("g.organization_id", "=", input.organizationId)
      .where("g.audience_kind", "=", "organization").where("g.state", "=", "active")
      .where("a.grant_id", "is", null)
      .where("s.owner_id", "!=", input.actorId)
      .where("s.lifecycle", "=", "shared")
      .where((eb) => eb.or([eb("g.expires_at", "is", null), eb("g.expires_at", ">", nowIso)]))
      .orderBy("g.created_at").limit(100).execute();
    const memberGrants = await this.db.selectFrom("collaboration_grants")
      .select(["id", "scope_id", "preset"])
      .where("organization_id", "=", input.organizationId)
      .where("audience_kind", "=", "member").where("audience_actor_id", "=", input.actorId).where("state", "=", "pending")
      .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", nowIso)]))
      .orderBy("created_at").limit(100).execute();
    return [...organizationGrants, ...memberGrants].map((row) => ({ grantId: row.id, scopeId: row.scope_id, preset: row.preset }));
  }

  /** Everything the evaluator needs for one actor on one membership scope, read without locks. */
  async resolveActorGrants(scopeId: string, actorId: string): Promise<ActorGrantResolution | null> {
    const scope = await this.db.selectFrom("collaboration_scopes").selectAll()
      .where("id", "=", scopeId).where("deleted_at", "is", null).where("lifecycle", "!=", "deleted").executeTakeFirst();
    if (!scope) return null;
    // Live grants win over historical ones explicitly; among equals the newest by created_at, then id, is deterministic.
    const rows = await this.db.selectFrom("collaboration_grants").selectAll()
      .where("scope_id", "=", scopeId)
      .where((eb) => eb.or([
        eb("audience_kind", "=", "organization"),
        eb.and([eb("audience_kind", "=", "member"), eb("audience_actor_id", "=", actorId)]),
      ]))
      .orderBy(sql`CASE WHEN state IN ('active', 'pending') THEN 0 ELSE 1 END`)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(MAX_GRANTS_PER_SCOPE).execute();
    const memberGrant = rows.find((row) => row.audience_kind === "member") ?? null;
    const organizationGrant = rows.find((row) => row.audience_kind === "organization") ?? null;
    const activation = organizationGrant
      ? await this.db.selectFrom("collaboration_grant_activations").selectAll()
        .where("grant_id", "=", organizationGrant.id).where("actor_id", "=", actorId).executeTakeFirst() ?? null
      : null;
    return { scope, memberGrant, organizationGrant, activation };
  }

  private async activeActors(trx: Transaction<OwnerCollaborationDatabase>, grantId: string): Promise<string[]> {
    const rows = await trx.selectFrom("collaboration_grant_activations").select("actor_id")
      .where("grant_id", "=", grantId).where("state", "=", "active").limit(MAX_LISTED_PARTICIPANTS).execute();
    return rows.map((row) => row.actor_id);
  }
}

/** A changed decision invalidates authorization snapshots while the caller holds the scope lock. */
async function advanceScopeAuthEpoch(
  trx: Transaction<OwnerCollaborationDatabase>,
  scope: ScopeRow,
  now: string,
): Promise<void> {
  const updated = await trx.updateTable("collaboration_scopes").set({
    auth_epoch: sql<number>`auth_epoch + 1`,
    updated_at: now,
  }).where("id", "=", scope.id)
    .where("auth_epoch", "=", Number(scope.auth_epoch))
    .returning("auth_epoch")
    .executeTakeFirst();
  if (!updated) throw new CollaborationRepositoryError("conflict", "Scope authorization epoch changed");
}
