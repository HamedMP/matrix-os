import { createHash, randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { CollaborationDirectoryKind, CollaborationPlatformDatabase } from "./database.js";
import { lockLegacyDirectoryIngestion } from "./legacy-ingestion-lock.js";

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
  kind: CollaborationDirectoryKind;
  organizationId?: string;
  audience?: "members" | "organization";
  organizationGrantId?: string;
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
  kind: CollaborationDirectoryKind;
  authorityGeneration: number;
  status: "invited" | "accepted" | "revoked";
  invitationId?: string;
  organizationId?: string;
}

/** An organization-wide share a current member has not opened (S06 / T032); content stays on the home. */
export interface CollaborationOrganizationShareEntry {
  scopeId: string;
  runtimeId: string;
  ownerId: string;
  kind: CollaborationDirectoryKind;
  authorityGeneration: number;
  organizationId: string;
  grantId: string;
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
      // A person-to-person event is legacy ingestion: it must not commit inside
      // the cutover's final inventory-to-activation interval, so it takes the
      // shared ingestion lock first. Organization events skip it and stay
      // parallel. The lock is always taken before any row lock, so the two
      // paths cannot deadlock.
      if (!input.organizationId) await lockLegacyDirectoryIngestion(trx);
      const existing = await trx.selectFrom("collaboration_directory")
        .selectAll()
        .where("scope_id", "=", input.scopeId)
        .forUpdate()
        .executeTakeFirst();
      const cutover = await trx.selectFrom("collaboration_cutover_journal")
        .select(["phase", "target_generation"])
        .where("scope_id", "=", input.scopeId)
        .executeTakeFirst();
      // The cutover journal freezes directory writes under the same row lock
      // used by generation activation. A delayed pre-cutover event cannot
      // reopen an older authority generation after direct activation.
      if (cutover && (cutover.phase !== "active"
        || input.authorityGeneration < Number(cutover.target_generation))) {
        throw new PlatformCollaborationRepositoryError("conflict", "Directory is fenced for collaboration cutover");
      }
      if (existing && (existing.owner_id !== input.ownerId || existing.runtime_id !== input.runtimeId)) {
        throw new PlatformCollaborationRepositoryError("conflict", "Directory authority changed without transition");
      }
      if (existing && Number(existing.metadata_revision) >= input.metadataRevision) return;

      await trx.insertInto("collaboration_directory").values({
        scope_id: input.scopeId,
        runtime_id: input.runtimeId,
        owner_id: input.ownerId,
        kind: input.kind,
        organization_id: input.organizationId ?? null,
        audience: input.audience ?? null,
        organization_grant_id: input.audience === "organization" ? input.organizationGrantId ?? null : null,
        authority_generation: input.authorityGeneration,
        metadata_revision: input.metadataRevision,
        last_event_id: input.eventId,
        updated_at: now,
      }).onConflict((conflict) => conflict.column("scope_id").doUpdateSet({
        kind: input.kind,
        ...(input.organizationId ? { organization_id: input.organizationId } : {}),
        audience: input.audience ?? null,
        organization_grant_id: input.audience === "organization" ? input.organizationGrantId ?? null : null,
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
    kind: CollaborationDirectoryKind;
    /** S05: owning organization, null only for pre-organization rows (tickets fail closed). */
    organizationId: string | null;
    audience: "members" | "organization" | null;
    organizationGrantId: string | null;
    authorityGeneration: number;
  } | null> {
    const row = await this.db.selectFrom("collaboration_directory")
      .select(["scope_id", "runtime_id", "owner_id", "kind", "organization_id", "audience", "organization_grant_id", "authority_generation"])
      .where("scope_id", "=", scopeId)
      .executeTakeFirst();
    return row ? {
      scopeId: row.scope_id,
      runtimeId: row.runtime_id,
      ownerId: row.owner_id,
      kind: row.kind,
      organizationId: row.organization_id ?? null,
      audience: row.audience,
      organizationGrantId: row.organization_grant_id,
      authorityGeneration: Number(row.authority_generation),
    } : null;
  }

  async getInvitationRoute(actorId: string, invitationId: string): Promise<{
    scopeId: string;
    runtimeId: string;
    ownerId: string;
    kind: CollaborationDirectoryKind;
    authorityGeneration: number;
  } | null> {
    const row = await this.db.selectFrom("collaboration_user_index as user_index")
      .innerJoin("collaboration_directory as directory", "directory.scope_id", "user_index.scope_id")
      .select([
        "directory.scope_id",
        "directory.runtime_id",
        "directory.owner_id",
        "directory.kind",
        "directory.authority_generation",
      ])
      .where("user_index.actor_id", "=", actorId)
      .where("user_index.invitation_id", "=", invitationId)
      .where("user_index.status", "=", "invited")
      .executeTakeFirst();
    return row ? {
      scopeId: row.scope_id,
      runtimeId: row.runtime_id,
      ownerId: row.owner_id,
      kind: row.kind,
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

  async getScopeActorStatus(scopeId: string, actorId: string): Promise<"invited" | "accepted" | "revoked" | null> {
    const row = await this.db.selectFrom("collaboration_user_index")
      .select("status")
      .where("scope_id", "=", scopeId)
      .where("actor_id", "=", actorId)
      .executeTakeFirst();
    return row?.status ?? null;
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
        "user_index.invitation_id",
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
      ...(row.invitation_id === null ? {} : { invitationId: row.invitation_id }),
    }));
  }

  async cleanupRevokedDirectoryEntries(input: { olderThan: string; limit: number }): Promise<number> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100
      || !Number.isFinite(Date.parse(input.olderThan))) {
      throw new PlatformCollaborationRepositoryError("invalid_expiry", "Cleanup boundary is invalid");
    }
    return this.db.transaction().execute(async (trx) => {
      const candidates = await trx.selectFrom("collaboration_user_index")
        .select(["actor_id", "scope_id", "updated_at"])
        .where("status", "=", "revoked")
        .where("updated_at", "<", input.olderThan)
        .orderBy("updated_at", "asc")
        .orderBy("actor_id", "asc")
        .limit(input.limit)
        .execute();
      const scopeIds = candidates.map((row) => row.scope_id).sort()
        .filter((scopeId, index, values) => index === 0 || values[index - 1] !== scopeId);
      if (scopeIds.length === 0) return 0;

      const lockedDirectories = await trx.selectFrom("collaboration_directory")
        .select("scope_id")
        .where("scope_id", "in", scopeIds)
        .orderBy("scope_id", "asc")
        .forUpdate()
        .execute();
      let deletedCount = 0;
      for (const candidate of candidates) {
        if (!lockedDirectories.some((directory) => directory.scope_id === candidate.scope_id)) continue;
        const deleted = await trx.deleteFrom("collaboration_user_index")
          .where("actor_id", "=", candidate.actor_id)
          .where("scope_id", "=", candidate.scope_id)
          .where("status", "=", "revoked")
          .where("updated_at", "=", candidate.updated_at)
          .where("updated_at", "<", input.olderThan)
          .returning("actor_id")
          .executeTakeFirst();
        if (deleted) deletedCount += 1;
      }
      for (const directory of lockedDirectories) {
        const remaining = await trx.selectFrom("collaboration_user_index")
          .select("actor_id")
          .where("scope_id", "=", directory.scope_id)
          .limit(1)
          .executeTakeFirst();
        if (!remaining) {
          await trx.deleteFrom("collaboration_directory")
            .where("scope_id", "=", directory.scope_id)
            .execute();
        }
      }
      return deletedCount;
    });
  }

  async listForActorPage(
    actorId: string,
    status: "invited" | "accepted",
    options: { limit: number; after?: { updatedAt: string; scopeId: string } },
  ): Promise<{
    items: CollaborationDirectoryEntry[];
    nextCursor?: { updatedAt: string; scopeId: string };
  }> {
    const limit = Math.max(1, Math.min(100, Math.trunc(options.limit)));
    let query = this.db.selectFrom("collaboration_user_index as user_index")
      .innerJoin("collaboration_directory as directory", "directory.scope_id", "user_index.scope_id")
      .select([
        "directory.scope_id",
        "directory.runtime_id",
        "directory.owner_id",
        "directory.kind",
        "directory.organization_id",
        "directory.authority_generation",
        "user_index.status",
        "user_index.invitation_id",
        "user_index.updated_at",
      ])
      .where("user_index.actor_id", "=", actorId)
      .where("user_index.status", "=", status);
    if (options.after) {
      query = query.where(({ and, eb, or }) => or([
        eb("user_index.updated_at", "<", options.after!.updatedAt),
        and([
          eb("user_index.updated_at", "=", options.after!.updatedAt),
          eb("directory.scope_id", ">", options.after!.scopeId),
        ]),
      ]));
    }
    const rows = await query.orderBy("user_index.updated_at", "desc")
      .orderBy("directory.scope_id", "asc").limit(limit + 1).execute();
    const page = rows.slice(0, limit);
    const last = rows.length > limit ? page.at(-1) : undefined;
    return {
      items: page.map((row) => ({
        scopeId: row.scope_id,
        runtimeId: row.runtime_id,
        ownerId: row.owner_id,
        kind: row.kind,
        authorityGeneration: Number(row.authority_generation),
        status: row.status,
        ...(row.invitation_id === null ? {} : { invitationId: row.invitation_id }),
        ...(row.organization_id === null ? {} : { organizationId: row.organization_id }),
      })),
      ...(last ? { nextCursor: { updatedAt: toIso(last.updated_at), scopeId: last.scope_id } } : {}),
    };
  }

  /**
   * Organization-wide shares in the actor's current organizations that the actor has no index row
   * for (never opened, accepted or declined) and does not own. Metadata only; bounded.
   */
  async listOrganizationSharesForActorPage(
    actorId: string,
    organizationIds: readonly string[],
    options: { limit: number; after?: { updatedAt: string; scopeId: string } },
  ): Promise<{ items: CollaborationOrganizationShareEntry[]; nextCursor?: { updatedAt: string; scopeId: string } }> {
    const organizations = [...new Set(organizationIds)].filter((id) => id.length > 0 && id.length <= 128).slice(0, 100);
    if (organizations.length === 0) return { items: [] };
    const limit = Math.max(1, Math.min(100, Math.trunc(options.limit)));
    let query = this.db.selectFrom("collaboration_directory as directory")
      .select(["directory.scope_id", "directory.runtime_id", "directory.owner_id", "directory.kind", "directory.organization_id", "directory.organization_grant_id", "directory.authority_generation", "directory.updated_at"])
      .where("directory.audience", "=", "organization")
      .where("directory.organization_grant_id", "is not", null)
      .where("directory.organization_id", "in", organizations)
      .where("directory.owner_id", "!=", actorId)
      .where(({ not, exists, selectFrom }) => not(exists(
        selectFrom("collaboration_user_index as user_index").select("user_index.scope_id")
          .whereRef("user_index.scope_id", "=", "directory.scope_id").where("user_index.actor_id", "=", actorId),
      )));
    if (options.after) {
      query = query.where(({ and, eb, or }) => or([
        eb("directory.updated_at", "<", options.after!.updatedAt),
        and([
          eb("directory.updated_at", "=", options.after!.updatedAt),
          eb("directory.scope_id", ">", options.after!.scopeId),
        ]),
      ]));
    }
    const rows = await query.orderBy("directory.updated_at", "desc").orderBy("directory.scope_id", "asc")
      .limit(limit + 1).execute();
    const page = rows.slice(0, limit);
    const last = rows.length > limit ? page.at(-1) : undefined;
    return {
      items: page.map((row) => ({
        scopeId: row.scope_id, runtimeId: row.runtime_id, ownerId: row.owner_id, kind: row.kind,
        authorityGeneration: Number(row.authority_generation), organizationId: row.organization_id!, grantId: row.organization_grant_id!,
      })),
      ...(last ? { nextCursor: { updatedAt: toIso(last.updated_at), scopeId: last.scope_id } } : {}),
    };
  }

  async createConnectionTicket(input: {
    token: string;
    actorId: string;
    scopeId: string;
    purpose: "events" | "terminal";
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
  }): Promise<{ ticketId: string }> {
    const consumed = await this.db.updateTable("collaboration_connection_tickets").set({
      consumed_at: this.now().toISOString(),
    }).where("token_hash", "=", hashToken(input.token))
      .where("actor_id", "=", input.actorId)
      .where("scope_id", "=", input.scopeId)
      .where("purpose", "=", input.purpose)
      .where("consumed_at", "is", null)
      .where("expires_at", ">", this.now().toISOString())
      .returning(["ticket_id"])
      .executeTakeFirst();
    if (!consumed) {
      throw new PlatformCollaborationRepositoryError("invalid_ticket", "Ticket is invalid");
    }
    return { ticketId: consumed.ticket_id };
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
