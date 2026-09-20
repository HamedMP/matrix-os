/**
 * Organization projection repository (S03 / T016, T017). All multi-row
 * changes run inside one transaction that locks the organization row, so
 * the membership epoch is monotonic under concurrent webhooks and
 * reconciliations. Clerk timestamps decide staleness; local receipt time
 * never does.
 */
import { randomUUID } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import type {
  CollaborationDenialState,
  OrganizationInboxOutcome,
  OrganizationMembershipState,
  OrganizationPlatformDatabase,
} from "./database.js";
import type { MembershipSnapshot, OrganizationSnapshot } from "./roles.js";

type Executor = Kysely<OrganizationPlatformDatabase> | Transaction<OrganizationPlatformDatabase>;

export interface OrganizationRecord {
  organizationId: string;
  name: string;
  slug: string;
  aiSubmission: "members" | "owner_only";
  lifecycle: "active" | "deleted";
  membershipEpoch: number;
  sourceUpdatedAt: Date;
  verifiedAt: Date | null;
}

export interface MembershipRecord {
  organizationId: string;
  actorId: string;
  membershipId: string;
  role: string;
  state: OrganizationMembershipState;
  membershipEpoch: number;
  sourceUpdatedAt: Date;
}

export interface EndedMembership {
  organizationId: string;
  actorId: string;
}

export type MembershipApplyOutcome = "applied" | "stale" | "unchanged";

export interface DenialRecord {
  denialId: string;
  organizationId?: string;
  actorId?: string;
  scopeId?: string;
  generation: number;
  fencedAt: string;
  ackDeadline: string;
  state: CollaborationDenialState;
  acknowledgedAt?: string;
}

export interface DenialRuntimeRecord {
  runtimeId: string;
  attempts: number;
  deadLetter: boolean;
  acknowledgedAt: string | null;
}

export const ORGANIZATION_LIST_LIMIT = 100;
export const MEMBERSHIP_PAGE_LIMIT = 100;
const MAX_DENIAL_RUNTIMES = 256;

function asDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(value);
}

function asIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function asNumber(value: number | string): number {
  return typeof value === "number" ? value : Number(value);
}

export class PlatformOrganizationRepository {
  private readonly now: () => Date;

  constructor(private readonly db: Executor, options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async transaction<T>(fn: (repository: PlatformOrganizationRepository) => Promise<T>): Promise<T> {
    if (this.db.isTransaction) return fn(this);
    return (this.db as Kysely<OrganizationPlatformDatabase>).transaction().execute(async (trx) => fn(new PlatformOrganizationRepository(trx, { now: this.now })));
  }

  async getOrganization(organizationId: string): Promise<OrganizationRecord | null> {
    const row = await this.db.selectFrom("organizations").selectAll().where("organization_id", "=", organizationId).executeTakeFirst();
    return row ? toOrganization(row) : null;
  }

  async getMembership(input: { organizationId: string; actorId: string }): Promise<MembershipRecord | null> {
    const row = await this.db.selectFrom("organization_memberships").selectAll()
      .where("organization_id", "=", input.organizationId).where("actor_id", "=", input.actorId).executeTakeFirst();
    return row ? toMembership(row) : null;
  }

  /** Upserts the organization; name/slug/policy/lifecycle only move forward in Clerk time. */
  async applyOrganization(snapshot: OrganizationSnapshot): Promise<OrganizationRecord> {
    const now = this.now();
    await this.db.insertInto("organizations").values({
      organization_id: snapshot.organizationId,
      name: snapshot.name,
      slug: snapshot.slug,
      ai_submission: snapshot.aiSubmission,
      lifecycle: snapshot.lifecycle ?? "active",
      source_updated_at: snapshot.sourceUpdatedAt,
      updated_at: now,
    }).onConflict((oc) => oc.column("organization_id").doUpdateSet({
      name: snapshot.name,
      slug: snapshot.slug,
      ai_submission: snapshot.aiSubmission,
      lifecycle: snapshot.lifecycle ?? "active",
      source_updated_at: snapshot.sourceUpdatedAt,
      updated_at: now,
    }).where("organizations.source_updated_at", "<=", snapshot.sourceUpdatedAt)).execute();
    const record = await this.getOrganization(snapshot.organizationId);
    if (!record) throw new Error("Organization upsert did not persist");
    return record;
  }

  /**
   * Applies one membership state from Clerk. Runs in its own transaction
   * (or the caller's), locks the organization row, refuses events older than
   * the stored source time, and bumps the organization epoch on every
   * applied change.
   */
  async applyMembership(input: MembershipSnapshot & { organizationId: string; state: OrganizationMembershipState }): Promise<{
    outcome: MembershipApplyOutcome;
    membershipEpoch: number;
    ended: boolean;
  }> {
    return this.transaction(async (repo) => {
      const org = await repo.lockOrganization(input.organizationId);
      const existing = await repo.getMembership({ organizationId: input.organizationId, actorId: input.actorId });
      if (existing && existing.sourceUpdatedAt.getTime() > input.sourceUpdatedAt.getTime()) {
        return { outcome: "stale", membershipEpoch: existing.membershipEpoch, ended: false };
      }
      if (existing && existing.sourceUpdatedAt.getTime() === input.sourceUpdatedAt.getTime()
        && existing.state === input.state && existing.role === input.role && existing.membershipId === input.membershipId) {
        return { outcome: "unchanged", membershipEpoch: existing.membershipEpoch, ended: false };
      }
      const epoch = await repo.bumpEpoch(input.organizationId, org.membershipEpoch);
      const now = repo.now();
      await repo.db.insertInto("organization_memberships").values({
        organization_id: input.organizationId,
        actor_id: input.actorId,
        membership_id: input.membershipId,
        role: input.role,
        state: input.state,
        membership_epoch: epoch,
        source_updated_at: input.sourceUpdatedAt,
        updated_at: now,
      }).onConflict((oc) => oc.columns(["organization_id", "actor_id"]).doUpdateSet({
        membership_id: input.membershipId,
        role: input.role,
        state: input.state,
        membership_epoch: epoch,
        source_updated_at: input.sourceUpdatedAt,
        updated_at: now,
      })).execute();
      const ended = input.state === "removed" && existing?.state === "active";
      if (ended) {
        // Durable revocation intent in the same transaction: a fence can be created
        // later by the control authority's drain even if this request fails afterwards.
        await repo.db.insertInto("organization_revocation_outbox").values({
          intent_id: randomUUID(),
          organization_id: input.organizationId,
          actor_id: input.actorId,
          membership_epoch: epoch,
          created_at: now,
          denial_id: null,
          next_attempt_at: now,
        }).execute();
      }
      return { outcome: "applied", membershipEpoch: epoch, ended };
    });
  }

  /** Full upstream snapshot: listed members become active, unlisted active members are tombstoned, verification time is recorded. */
  async reconcileOrganization(snapshot: { organization: OrganizationSnapshot; members: readonly MembershipSnapshot[] }, verifiedAt: Date): Promise<{
    endedMemberships: EndedMembership[];
    membershipEpoch: number;
  }> {
    return this.transaction(async (repo) => {
      await repo.applyOrganization(snapshot.organization);
      const org = await repo.lockOrganization(snapshot.organization.organizationId);
      const ended: EndedMembership[] = [];
      const listed = new Set<string>();
      for (const member of snapshot.members) {
        listed.add(member.actorId);
        await repo.applyMembership({ ...member, organizationId: org.organizationId, state: "active" });
      }
      const active = await repo.db.selectFrom("organization_memberships").select("actor_id")
        .where("organization_id", "=", org.organizationId).where("state", "=", "active").execute();
      for (const row of active) {
        if (listed.has(row.actor_id)) continue;
        const result = await repo.applyMembership({
          organizationId: org.organizationId,
          actorId: row.actor_id,
          membershipId: `removed:${row.actor_id}`,
          role: "org:member",
          sourceUpdatedAt: verifiedAt,
          state: "removed",
        });
        if (result.ended) ended.push({ organizationId: org.organizationId, actorId: row.actor_id });
      }
      await repo.db.updateTable("organizations").set({ verified_at: verifiedAt, updated_at: repo.now() })
        .where("organization_id", "=", org.organizationId).execute();
      const current = await repo.getOrganization(org.organizationId);
      return { endedMemberships: ended, membershipEpoch: current?.membershipEpoch ?? org.membershipEpoch };
    });
  }

  async tombstoneAllMemberships(organizationId: string, sourceUpdatedAt: Date): Promise<EndedMembership[]> {
    return this.transaction(async (repo) => {
      await repo.lockOrganization(organizationId);
      const active = await repo.db.selectFrom("organization_memberships").select("actor_id")
        .where("organization_id", "=", organizationId).where("state", "=", "active").limit(MAX_DENIAL_RUNTIMES * 4).execute();
      const ended: EndedMembership[] = [];
      for (const row of active) {
        const result = await repo.applyMembership({
          organizationId, actorId: row.actor_id, membershipId: `removed:${row.actor_id}`, role: "org:member", sourceUpdatedAt, state: "removed",
        });
        if (result.ended) ended.push({ organizationId, actorId: row.actor_id });
      }
      return ended;
    });
  }

  async recordInboxEvent(input: { eventId: string; eventType: string; payloadHash: string }): Promise<"new" | "duplicate" | "conflict"> {
    const inserted = await this.db.insertInto("organization_webhook_inbox").values({
      event_id: input.eventId,
      event_type: input.eventType,
      payload_hash: input.payloadHash,
      received_at: this.now(),
    }).onConflict((oc) => oc.column("event_id").doNothing()).returning("event_id").executeTakeFirst();
    if (inserted) return "new";
    const existing = await this.db.selectFrom("organization_webhook_inbox").select("payload_hash")
      .where("event_id", "=", input.eventId).executeTakeFirst();
    return existing?.payload_hash === input.payloadHash ? "duplicate" : "conflict";
  }

  async markInboxOutcome(eventId: string, outcome: OrganizationInboxOutcome): Promise<void> {
    await this.db.updateTable("organization_webhook_inbox").set({ outcome, processed_at: this.now() })
      .where("event_id", "=", eventId).execute();
  }

  async pruneInbox(before: Date): Promise<number> {
    const result = await this.db.deleteFrom("organization_webhook_inbox").where("received_at", "<", before).executeTakeFirst();
    return Number(result.numDeletedRows ?? 0);
  }

  async listOrganizationsForActor(actorId: string, limit = ORGANIZATION_LIST_LIMIT): Promise<Array<{ organization: OrganizationRecord; membership: MembershipRecord }>> {
    const rows = await this.db.selectFrom("organization_memberships as m")
      .innerJoin("organizations as o", "o.organization_id", "m.organization_id")
      .selectAll("m")
      .select(["o.name", "o.slug", "o.ai_submission", "o.lifecycle", "o.source_updated_at as org_source_updated_at", "o.verified_at", "o.membership_epoch as org_epoch"])
      .where("m.actor_id", "=", actorId).where("m.state", "=", "active").where("o.lifecycle", "=", "active")
      .orderBy("m.organization_id").limit(Math.min(Math.max(limit, 1), ORGANIZATION_LIST_LIMIT)).execute();
    return rows.map((row) => ({
      organization: {
        organizationId: row.organization_id,
        name: row.name,
        slug: row.slug,
        aiSubmission: row.ai_submission,
        lifecycle: row.lifecycle,
        membershipEpoch: asNumber(row.org_epoch),
        sourceUpdatedAt: asDate(row.org_source_updated_at)!,
        verifiedAt: asDate(row.verified_at),
      },
      membership: toMembership(row),
    }));
  }

  async listMembers(organizationId: string, page: { limit: number; afterActorId?: string }): Promise<{ members: MembershipRecord[]; nextActorId?: string }> {
    const limit = Math.min(Math.max(page.limit, 1), MEMBERSHIP_PAGE_LIMIT);
    let query = this.db.selectFrom("organization_memberships").selectAll()
      .where("organization_id", "=", organizationId).where("state", "=", "active").orderBy("actor_id").limit(limit + 1);
    if (page.afterActorId) query = query.where("actor_id", ">", page.afterActorId);
    const rows = await query.execute();
    const members = rows.slice(0, limit).map(toMembership);
    return rows.length > limit ? { members, nextActorId: members[members.length - 1]!.actorId } : { members };
  }

  // --- revocation intents (durable outbox drained by the control authority) --------------------

  async listDueRevocationIntents(now: Date, limit = 100): Promise<Array<{ intentId: string; organizationId: string; actorId: string; membershipEpoch: number; attempts: number }>> {
    const rows = await this.db.selectFrom("organization_revocation_outbox").selectAll()
      .where("denial_id", "is", null).where("dead_letter", "=", false).where("next_attempt_at", "<=", now)
      .orderBy("created_at").limit(Math.min(Math.max(limit, 1), 1_000)).execute();
    return rows.map((row) => ({
      intentId: row.intent_id, organizationId: row.organization_id, actorId: row.actor_id,
      membershipEpoch: asNumber(row.membership_epoch), attempts: row.attempts,
    }));
  }

  async completeRevocationIntent(intentId: string, denialId: string): Promise<void> {
    await this.db.updateTable("organization_revocation_outbox").set({ denial_id: denialId })
      .where("intent_id", "=", intentId).where("denial_id", "is", null).execute();
  }

  async recordRevocationIntentFailure(input: { intentId: string; nextAttemptAt: Date; deadLetter: boolean }): Promise<void> {
    await this.db.updateTable("organization_revocation_outbox")
      .set({ attempts: sql`attempts + 1`, next_attempt_at: input.nextAttemptAt, dead_letter: input.deadLetter })
      .where("intent_id", "=", input.intentId).execute();
  }

  async describeRevocationIntents(input: { organizationId: string; actorId: string }): Promise<Array<{ intentId: string; denialId: string | null; attempts: number; deadLetter: boolean }>> {
    const rows = await this.db.selectFrom("organization_revocation_outbox").selectAll()
      .where("organization_id", "=", input.organizationId).where("actor_id", "=", input.actorId).orderBy("created_at").execute();
    return rows.map((row) => ({ intentId: row.intent_id, denialId: row.denial_id, attempts: row.attempts, deadLetter: row.dead_letter }));
  }

  // --- control authority: denials, fences, acknowledgements -------------------------------------

  async createDenial(input: {
    organizationId?: string; actorId?: string; scopeId?: string; generation: number; fencedAt: Date; ackDeadline: Date; runtimeIds: readonly string[];
  }): Promise<DenialRecord> {
    if (input.runtimeIds.length > MAX_DENIAL_RUNTIMES) throw new Error("Too many affected runtimes for one denial");
    return this.transaction(async (repo) => {
      const denialId = randomUUID();
      await repo.db.insertInto("collaboration_denials").values({
        denial_id: denialId,
        organization_id: input.organizationId ?? null,
        actor_id: input.actorId ?? null,
        scope_id: input.scopeId ?? null,
        generation: input.generation,
        fenced_at: input.fencedAt,
        ack_deadline: input.ackDeadline,
        state: "pending",
        acknowledged_at: null,
        created_at: repo.now(),
      }).execute();
      for (const runtimeId of new Set(input.runtimeIds)) {
        await repo.db.insertInto("collaboration_denial_runtimes").values({
          denial_id: denialId, runtime_id: runtimeId, acknowledged_at: null, next_attempt_at: input.fencedAt,
        }).execute();
      }
      if (input.runtimeIds.length === 0) {
        await repo.db.updateTable("collaboration_denials").set({ state: "completed", acknowledged_at: input.fencedAt })
          .where("denial_id", "=", denialId).execute();
      }
      const record = await repo.getDenial(denialId);
      if (!record) throw new Error("Denial insert did not persist");
      return record;
    });
  }

  async getDenial(denialId: string): Promise<DenialRecord | null> {
    const row = await this.db.selectFrom("collaboration_denials").selectAll().where("denial_id", "=", denialId).executeTakeFirst();
    return row ? toDenial(row) : null;
  }

  async listPendingDenials(limit = 100): Promise<DenialRecord[]> {
    const rows = await this.db.selectFrom("collaboration_denials").selectAll().where("state", "=", "pending")
      .orderBy("fenced_at").limit(Math.min(Math.max(limit, 1), 1_000)).execute();
    return rows.map(toDenial);
  }

  async listDenialRuntimes(denialId: string): Promise<DenialRuntimeRecord[]> {
    const rows = await this.db.selectFrom("collaboration_denial_runtimes").selectAll().where("denial_id", "=", denialId).orderBy("runtime_id").execute();
    return rows.map((row) => ({
      runtimeId: row.runtime_id,
      attempts: row.attempts,
      deadLetter: row.dead_letter,
      acknowledgedAt: row.acknowledged_at ? asIso(row.acknowledged_at) : null,
    }));
  }

  /**
   * A runtime acknowledging generation G with a fence at time T completes its
   * part of every pending denial fenced at or before T whose generation is at
   * most G; a stale generation cannot acknowledge a newer denial.
   */
  async acknowledgeRuntime(input: { runtimeId: string; fenceAt: Date; generation: number; acknowledgedAt: Date }): Promise<string[]> {
    return this.transaction(async (repo) => {
      const pending = await repo.db.selectFrom("collaboration_denial_runtimes as r")
        .innerJoin("collaboration_denials as d", "d.denial_id", "r.denial_id")
        .select(["r.denial_id"])
        .where("r.runtime_id", "=", input.runtimeId).where("r.acknowledged_at", "is", null)
        .where("d.state", "=", "pending").where("d.fenced_at", "<=", input.fenceAt)
        .where("d.generation", "<=", input.generation)
        .forUpdate().execute();
      const completed: string[] = [];
      for (const { denial_id } of pending) {
        await repo.db.updateTable("collaboration_denial_runtimes").set({ acknowledged_at: input.acknowledgedAt })
          .where("denial_id", "=", denial_id).where("runtime_id", "=", input.runtimeId).execute();
        const remaining = await repo.db.selectFrom("collaboration_denial_runtimes").select(sql<number>`count(*)`.as("count"))
          .where("denial_id", "=", denial_id).where("acknowledged_at", "is", null).executeTakeFirst();
        if (Number(remaining?.count ?? 0) === 0) {
          const updated = await repo.db.updateTable("collaboration_denials").set({ state: "completed", acknowledged_at: input.acknowledgedAt })
            .where("denial_id", "=", denial_id).where("state", "=", "pending").returning("denial_id").executeTakeFirst();
          if (updated) completed.push(denial_id);
        }
      }
      return completed;
    });
  }

  /** Lease expiry: a denial whose acknowledgement deadline passed is complete because every lease issued before the fence has lapsed. */
  async completeExpiredDenials(now: Date): Promise<number> {
    const rows = await this.db.updateTable("collaboration_denials")
      .set({ state: "completed", acknowledged_at: sql`ack_deadline` })
      .where("state", "=", "pending").where("ack_deadline", "<=", now).returning("denial_id").execute();
    return rows.length;
  }

  async listDueDeliveries(now: Date, limit = 100): Promise<Array<{ denial: DenialRecord; runtimeId: string; attempts: number }>> {
    const rows = await this.db.selectFrom("collaboration_denial_runtimes as r")
      .innerJoin("collaboration_denials as d", "d.denial_id", "r.denial_id")
      .select(["r.runtime_id", "r.attempts"]).selectAll("d")
      .where("r.acknowledged_at", "is", null).where("r.dead_letter", "=", false).where("r.next_attempt_at", "<=", now)
      .where("d.state", "=", "pending").orderBy("r.next_attempt_at").limit(Math.min(Math.max(limit, 1), 1_000)).execute();
    return rows.map((row) => ({ denial: toDenial(row), runtimeId: row.runtime_id, attempts: row.attempts }));
  }

  async recordDeliveryAttempt(input: { denialId: string; runtimeId: string; nextAttemptAt: Date; deadLetter: boolean }): Promise<void> {
    await this.db.updateTable("collaboration_denial_runtimes")
      .set({ attempts: sql`attempts + 1`, next_attempt_at: input.nextAttemptAt, dead_letter: input.deadLetter })
      .where("denial_id", "=", input.denialId).where("runtime_id", "=", input.runtimeId).execute();
  }

  private async lockOrganization(organizationId: string): Promise<OrganizationRecord> {
    const row = await this.db.selectFrom("organizations").selectAll().where("organization_id", "=", organizationId).forUpdate().executeTakeFirst();
    if (!row) throw new Error("Organization is not projected");
    return toOrganization(row);
  }

  private async bumpEpoch(organizationId: string, current: number): Promise<number> {
    const row = await this.db.updateTable("organizations")
      .set({ membership_epoch: sql`membership_epoch + 1`, updated_at: this.now() })
      .where("organization_id", "=", organizationId).where("membership_epoch", "=", current)
      .returning("membership_epoch").executeTakeFirst();
    if (!row) throw new Error("Organization epoch moved during the transaction");
    return asNumber(row.membership_epoch);
  }
}

function toOrganization(row: {
  organization_id: string; name: string; slug: string; ai_submission: "members" | "owner_only"; lifecycle: "active" | "deleted";
  membership_epoch: number | string; source_updated_at: Date | string; verified_at: Date | string | null;
}): OrganizationRecord {
  return {
    organizationId: row.organization_id,
    name: row.name,
    slug: row.slug,
    aiSubmission: row.ai_submission,
    lifecycle: row.lifecycle,
    membershipEpoch: asNumber(row.membership_epoch),
    sourceUpdatedAt: asDate(row.source_updated_at)!,
    verifiedAt: asDate(row.verified_at),
  };
}

function toMembership(row: {
  organization_id: string; actor_id: string; membership_id: string; role: string; state: OrganizationMembershipState;
  membership_epoch: number | string; source_updated_at: Date | string;
}): MembershipRecord {
  return {
    organizationId: row.organization_id,
    actorId: row.actor_id,
    membershipId: row.membership_id,
    role: row.role,
    state: row.state,
    membershipEpoch: asNumber(row.membership_epoch),
    sourceUpdatedAt: asDate(row.source_updated_at)!,
  };
}

function toDenial(row: {
  denial_id: string; organization_id: string | null; actor_id: string | null; scope_id: string | null; generation: number | string;
  fenced_at: Date | string; ack_deadline: Date | string; state: CollaborationDenialState; acknowledged_at: Date | string | null;
}): DenialRecord {
  return {
    denialId: row.denial_id,
    ...(row.organization_id ? { organizationId: row.organization_id } : {}),
    ...(row.actor_id ? { actorId: row.actor_id } : {}),
    ...(row.scope_id ? { scopeId: row.scope_id } : {}),
    generation: asNumber(row.generation),
    fencedAt: asIso(row.fenced_at),
    ackDeadline: asIso(row.ack_deadline),
    state: row.state,
    ...(row.acknowledged_at ? { acknowledgedAt: asIso(row.acknowledged_at) } : {}),
  };
}
