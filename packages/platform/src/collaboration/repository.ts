import { createHash, randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { CollaborationPlatformDatabase } from "./database.js";

const MAX_OUTSTANDING_TICKETS = 20;
const MAX_TICKET_LIFETIME_MS = 30_000;

export type PlatformCollaborationRepositoryErrorCode =
  | "conflict"
  | "capacity"
  | "invalid_ticket"
  | "invalid_expiry";

export class PlatformCollaborationRepositoryError extends Error {
  constructor(
    public readonly code: PlatformCollaborationRepositoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PlatformCollaborationRepositoryError";
  }
}

export interface DirectoryEventInput {
  eventId: string;
  scopeId: string;
  runtimeId: string;
  ownerId: string;
  kind: "chat" | "terminal" | "project";
  authorityGeneration: number;
  metadataRevision: number;
  recipients: Array<{
    actorId: string;
    status: "invited" | "accepted" | "revoked";
    invitationId?: string;
  }>;
}

export interface CollaborationDirectoryEntry {
  scopeId: string;
  runtimeId: string;
  ownerId: string;
  kind: "chat" | "terminal" | "project";
  authorityGeneration: number;
  status: "invited" | "accepted" | "revoked";
}

export interface CollaborationRolloutPolicyRecord {
  milestone: "m1" | "m2" | "m3" | "m4";
  revision: number;
  mode: "off" | "internal" | "enabled" | "read_only";
  cohort: string[];
  changedBy: string;
  changedAt: string;
}

export class PlatformCollaborationRepository {
  private readonly now: () => Date;

  constructor(
    public readonly db: Kysely<CollaborationPlatformDatabase>,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async applyDirectoryEvent(input: DirectoryEventInput): Promise<void> {
    const now = this.now().toISOString();
    await this.db.transaction().execute(async (trx) => {
      const existing = await trx.selectFrom("collaboration_directory")
        .selectAll()
        .where("scope_id", "=", input.scopeId)
        .forUpdate()
        .executeTakeFirst();
      if (existing && (existing.owner_id !== input.ownerId || existing.runtime_id !== input.runtimeId)) {
        throw new PlatformCollaborationRepositoryError("conflict", "Directory authority changed without transition");
      }
      if (existing && Number(existing.metadata_revision) >= input.metadataRevision) return;

      await trx.insertInto("collaboration_directory").values({
        scope_id: input.scopeId,
        runtime_id: input.runtimeId,
        owner_id: input.ownerId,
        kind: input.kind,
        authority_generation: input.authorityGeneration,
        metadata_revision: input.metadataRevision,
        last_event_id: input.eventId,
        updated_at: now,
      }).onConflict((conflict) => conflict.column("scope_id").doUpdateSet({
        kind: input.kind,
        authority_generation: input.authorityGeneration,
        metadata_revision: input.metadataRevision,
        last_event_id: input.eventId,
        updated_at: now,
      })).execute();

      for (const recipient of input.recipients) {
        await trx.insertInto("collaboration_user_index").values({
          actor_id: recipient.actorId,
          scope_id: input.scopeId,
          status: recipient.status,
          invitation_id: recipient.invitationId ?? null,
          locator_generation: input.authorityGeneration,
          last_event_id: input.eventId,
          updated_at: now,
        }).onConflict((conflict) => conflict.columns(["actor_id", "scope_id"]).doUpdateSet({
          status: recipient.status,
          invitation_id: recipient.invitationId ?? null,
          locator_generation: input.authorityGeneration,
          last_event_id: input.eventId,
          updated_at: now,
        })).execute();
      }
    });
  }

  async getDirectoryRoute(scopeId: string): Promise<{
    scopeId: string;
    runtimeId: string;
    ownerId: string;
    authorityGeneration: number;
  } | null> {
    const row = await this.db.selectFrom("collaboration_directory")
      .select(["scope_id", "runtime_id", "owner_id", "authority_generation"])
      .where("scope_id", "=", scopeId)
      .executeTakeFirst();
    return row ? {
      scopeId: row.scope_id,
      runtimeId: row.runtime_id,
      ownerId: row.owner_id,
      authorityGeneration: Number(row.authority_generation),
    } : null;
  }

  async getInvitationRoute(actorId: string, invitationId: string): Promise<{
    scopeId: string;
    runtimeId: string;
    ownerId: string;
    authorityGeneration: number;
  } | null> {
    const row = await this.db.selectFrom("collaboration_user_index as user_index")
      .innerJoin("collaboration_directory as directory", "directory.scope_id", "user_index.scope_id")
      .select(["directory.scope_id", "directory.runtime_id", "directory.owner_id", "directory.authority_generation"])
      .where("user_index.actor_id", "=", actorId)
      .where("user_index.invitation_id", "=", invitationId)
      .where("user_index.status", "=", "invited")
      .executeTakeFirst();
    return row ? {
      scopeId: row.scope_id,
      runtimeId: row.runtime_id,
      ownerId: row.owner_id,
      authorityGeneration: Number(row.authority_generation),
    } : null;
  }

  async listScopeActors(scopeId: string): Promise<string[]> {
    const rows = await this.db.selectFrom("collaboration_user_index")
      .select("actor_id")
      .where("scope_id", "=", scopeId)
      .where("status", "!=", "revoked")
      .orderBy("actor_id", "asc")
      .limit(100)
      .execute();
    return rows.map((row) => row.actor_id);
  }

  async listForActor(actorId: string): Promise<CollaborationDirectoryEntry[]> {
    const rows = await this.db.selectFrom("collaboration_user_index as user_index")
      .innerJoin("collaboration_directory as directory", "directory.scope_id", "user_index.scope_id")
      .select([
        "directory.scope_id",
        "directory.runtime_id",
        "directory.owner_id",
        "directory.kind",
        "directory.authority_generation",
        "user_index.status",
      ])
      .where("user_index.actor_id", "=", actorId)
      .where("user_index.status", "!=", "revoked")
      .orderBy("user_index.updated_at", "desc")
      .limit(100)
      .execute();
    return rows.map((row) => ({
      scopeId: row.scope_id,
      runtimeId: row.runtime_id,
      ownerId: row.owner_id,
      kind: row.kind,
      authorityGeneration: Number(row.authority_generation),
      status: row.status,
    }));
  }

  async cleanupRevokedDirectoryEntries(input: { olderThan: string; limit: number }): Promise<number> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100
      || !Number.isFinite(Date.parse(input.olderThan))) {
      throw new PlatformCollaborationRepositoryError("invalid_expiry", "Cleanup boundary is invalid");
    }
    return this.db.transaction().execute(async (trx) => {
      const rows = await trx.selectFrom("collaboration_user_index")
        .select(["actor_id", "scope_id"])
        .where("status", "=", "revoked")
        .where("updated_at", "<", input.olderThan)
        .orderBy("updated_at", "asc")
        .orderBy("actor_id", "asc")
        .limit(input.limit)
        .forUpdate()
        .execute();
      for (const row of rows) {
        await trx.deleteFrom("collaboration_user_index")
          .where("actor_id", "=", row.actor_id)
          .where("scope_id", "=", row.scope_id)
          .where("status", "=", "revoked")
          .where("updated_at", "<", input.olderThan)
          .execute();
      }
      for (const scopeId of new Set(rows.map((row) => row.scope_id))) {
        const remaining = await trx.selectFrom("collaboration_user_index")
          .select("actor_id")
          .where("scope_id", "=", scopeId)
          .limit(1)
          .executeTakeFirst();
        if (!remaining) {
          await trx.deleteFrom("collaboration_directory")
            .where("scope_id", "=", scopeId)
            .execute();
        }
      }
      return rows.length;
    });
  }

  async getPolicy(
    milestone: "m1" | "m2" | "m3" | "m4",
  ): Promise<CollaborationRolloutPolicyRecord> {
    const row = await this.db.selectFrom("collaboration_rollout_policy")
      .selectAll()
      .where("milestone", "=", milestone)
      .executeTakeFirstOrThrow();
    return {
      milestone: row.milestone,
      revision: Number(row.revision),
      mode: row.mode,
      cohort: parseStringArray(row.cohort),
      changedBy: row.changed_by,
      changedAt: toIso(row.changed_at),
    };
  }

  async setPolicy(input: {
    milestone: "m1" | "m2" | "m3" | "m4";
    expectedRevision: number;
    mode: "off" | "internal" | "enabled" | "read_only";
    cohort: string[];
    changedBy: string;
  }): Promise<CollaborationRolloutPolicyRecord> {
    if (input.cohort.length > 1_000) {
      throw new PlatformCollaborationRepositoryError("capacity", "Policy cohort is too large");
    }
    const now = this.now().toISOString();
    const updated = await this.db.updateTable("collaboration_rollout_policy").set({
      revision: input.expectedRevision + 1,
      mode: input.mode,
      cohort: jsonb([...new Set(input.cohort)].sort()),
      changed_by: input.changedBy,
      changed_at: now,
    }).where("milestone", "=", input.milestone)
      .where("revision", "=", input.expectedRevision)
      .returningAll()
      .executeTakeFirst();
    if (!updated) throw new PlatformCollaborationRepositoryError("conflict", "Policy revision changed");
    return {
      milestone: updated.milestone,
      revision: Number(updated.revision),
      mode: updated.mode,
      cohort: parseStringArray(updated.cohort),
      changedBy: updated.changed_by,
      changedAt: toIso(updated.changed_at),
    };
  }

  async createConnectionTicket(input: {
    token: string;
    actorId: string;
    scopeId: string;
    purpose: "events" | "terminal";
    policyRevision: number;
    expiresAt: string;
  }): Promise<{ ticketId: string; expiresAt: string }> {
    const nowDate = this.now();
    const expiresAt = new Date(input.expiresAt);
    const lifetime = expiresAt.getTime() - nowDate.getTime();
    if (!Number.isFinite(lifetime) || lifetime <= 0 || lifetime > MAX_TICKET_LIFETIME_MS) {
      throw new PlatformCollaborationRepositoryError("invalid_expiry", "Ticket expiry is invalid");
    }
    const now = nowDate.toISOString();
    return this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.actorId}, 0))`.execute(trx);
      await trx.deleteFrom("collaboration_connection_tickets")
        .where("expires_at", "<=", now)
        .execute();
      const outstanding = await trx.selectFrom("collaboration_connection_tickets")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("actor_id", "=", input.actorId)
        .where("consumed_at", "is", null)
        .where("expires_at", ">", now)
        .executeTakeFirstOrThrow();
      if (Number(outstanding.count) >= MAX_OUTSTANDING_TICKETS) {
        throw new PlatformCollaborationRepositoryError("capacity", "Outstanding ticket limit reached");
      }
      const ticketId = randomUUID();
      await trx.insertInto("collaboration_connection_tickets").values({
        token_hash: hashToken(input.token),
        ticket_id: ticketId,
        actor_id: input.actorId,
        scope_id: input.scopeId,
        purpose: input.purpose,
        policy_revision: input.policyRevision,
        expires_at: input.expiresAt,
        consumed_at: null,
        created_at: now,
      }).execute();
      return { ticketId, expiresAt: expiresAt.toISOString() };
    });
  }

  async consumeConnectionTicket(input: {
    token: string;
    actorId: string;
    scopeId: string;
    purpose: "events" | "terminal";
  }): Promise<{ ticketId: string; policyRevision: number }> {
    const consumed = await this.db.updateTable("collaboration_connection_tickets").set({
      consumed_at: this.now().toISOString(),
    }).where("token_hash", "=", hashToken(input.token))
      .where("actor_id", "=", input.actorId)
      .where("scope_id", "=", input.scopeId)
      .where("purpose", "=", input.purpose)
      .where("consumed_at", "is", null)
      .where("expires_at", ">", this.now().toISOString())
      .returning(["ticket_id", "policy_revision"])
      .executeTakeFirst();
    if (!consumed) {
      throw new PlatformCollaborationRepositoryError("invalid_ticket", "Ticket is invalid");
    }
    return { ticketId: consumed.ticket_id, policyRevision: Number(consumed.policy_revision) };
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function jsonb(value: unknown) {
  return sql`${JSON.stringify(value)}::jsonb`;
}

function parseStringArray(value: unknown): string[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) return [];
  return parsed;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
