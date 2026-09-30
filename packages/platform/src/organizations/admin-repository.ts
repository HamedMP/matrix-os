import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import { createHmac, hkdfSync, randomUUID } from "node:crypto";
import type { OrganizationAdminRequestsTable, OrganizationAdminRequestState, OrganizationInvitationRecordsTable, OrganizationPlatformDatabase } from "./database.js";

const CREATE_LIMIT = 3;
const DAY_MS = 24 * 60 * 60_000;
const INITIAL_SETTLE_MS = 2 * 60_000;
const CLAIM_LEASE_MS = 5 * 60_000;
const INVITE_SETTLE_MS = 2 * 60_000;
const INVITE_TTL_MS = 30 * DAY_MS;
const HOUR_MS = 60 * 60_000;

export class OrganizationInvitationLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) { super("Organization invitation limit reached"); }
}

export class OrganizationInvitationConflictError extends Error {
  constructor() { super("Invitation request conflicts with a pending role or address"); }
}

export interface OrganizationInvitationRecord {
  organizationId: string;
  addressDigest: string;
  clientRequestId: string;
  attemptRequestId: string;
  role: "org:admin" | "org:member";
  invitationId: string | null;
  inviterId: string;
  expiresAt: Date;
  leaseUntil: Date;
}

export class OrganizationCreateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) { super("Organization creation limit reached"); }
}

export interface OrganizationAdminRequest {
  actorId: string;
  clientRequestId: string;
  name: string;
  state: OrganizationAdminRequestState;
  organizationId: string | null;
  createdAt: Date;
  leaseUntil: Date | null;
}

export class OrganizationAdminRepository {
  private readonly now: () => Date;
  constructor(private readonly db: Kysely<OrganizationPlatformDatabase>, options?: { now?: () => Date }) {
    this.now = options?.now ?? (() => new Date());
  }

  /** The digest key is distinct from other uses of PLATFORM_SECRET. No address reaches Postgres. */
  invitationDigest(address: string, platformSecret: string): string {
    if (!platformSecret) throw new Error("Invitation digest secret missing");
    const key = hkdfSync("sha256", Buffer.from(platformSecret), Buffer.from("matrix-os-platform-organizations"),
      Buffer.from("invitation-address-digest-v1"), 32);
    return createHmac("sha256", Buffer.from(key)).update(address.trim().toLowerCase()).digest("hex");
  }

  async beginInvitation(input: { organizationId: string; actorId: string; addressDigest: string; clientRequestId: string; role: "org:admin" | "org:member" }): Promise<{ record: OrganizationInvitationRecord; claimed: boolean; reclaim: boolean }> {
    const now = this.now();
    const leaseUntil = new Date(now.getTime() + INVITE_SETTLE_MS);
    const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
    return this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom("organization_invitation_records")
        .where("organization_id", "=", input.organizationId).where("address_digest", "=", input.addressDigest)
        .where("expires_at", "<=", now).execute();
      // A reused request ID for another address is a conflict, never an invitation to the new address.
      const reused = await trx.selectFrom("organization_invitation_records").selectAll()
        .where("organization_id", "=", input.organizationId).where("client_request_id", "=", input.clientRequestId).executeTakeFirst();
      if (reused && reused.address_digest !== input.addressDigest) throw new OrganizationInvitationConflictError();
      const inserted = await trx.insertInto("organization_invitation_records").values({
        organization_id: input.organizationId, address_digest: input.addressDigest,
        client_request_id: input.clientRequestId, attempt_request_id: randomUUID(), role: input.role, invitation_id: null,
        inviter_id: input.actorId, expires_at: expiresAt, lease_until: leaseUntil, created_at: now,
      }).onConflict((conflict) => conflict.columns(["organization_id", "address_digest"]).doNothing())
        .returningAll().executeTakeFirst();
      if (inserted) {
        await this.chargeInvitation(trx, input.actorId, "invite_actor", HOUR_MS, 20, now);
        await this.chargeInvitation(trx, input.organizationId, "invite_org", DAY_MS, 100, now);
        return { record: mapInvitation(inserted), claimed: true, reclaim: false };
      }
      const existing = await trx.selectFrom("organization_invitation_records").selectAll()
        .where("organization_id", "=", input.organizationId).where("address_digest", "=", input.addressDigest)
        .forUpdate().executeTakeFirstOrThrow();
      if (existing.role !== input.role) throw new OrganizationInvitationConflictError();
      if (existing.invitation_id || new Date(existing.lease_until).getTime() > now.getTime()) {
        return { record: mapInvitation(existing), claimed: false, reclaim: false };
      }
      const claimed = await trx.updateTable("organization_invitation_records")
        .set({ lease_until: leaseUntil, inviter_id: input.actorId, attempt_request_id: randomUUID() }).where("organization_id", "=", input.organizationId)
        .where("address_digest", "=", input.addressDigest).where("invitation_id", "is", null)
        .where("lease_until", "<=", now).returningAll().executeTakeFirst();
      return { record: mapInvitation(claimed ?? existing), claimed: Boolean(claimed), reclaim: Boolean(claimed) };
    });
  }

  private async chargeInvitation(trx: Transaction<OrganizationPlatformDatabase>, scopeId: string, action: string, windowMs: number, limit: number, now: Date): Promise<void> {
    const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
    const result = await sql`INSERT INTO organization_admin_counters (scope_id, action, window_start, count)
      VALUES (${scopeId}, ${action}, ${windowStart}, 1)
      ON CONFLICT (scope_id, action, window_start)
      DO UPDATE SET count = organization_admin_counters.count + 1 WHERE organization_admin_counters.count < ${limit}
      RETURNING count`.execute(trx);
    if (!result.rows.length) throw new OrganizationInvitationLimitError(Math.max(1, Math.ceil((windowStart.getTime() + windowMs - now.getTime()) / 1000)));
  }

  async getInvitation(organizationId: string, addressDigest: string): Promise<OrganizationInvitationRecord | null> {
    const row = await this.db.selectFrom("organization_invitation_records").selectAll()
      .where("organization_id", "=", organizationId).where("address_digest", "=", addressDigest).executeTakeFirst();
    return row ? mapInvitation(row) : null;
  }

  async completeInvitation(record: OrganizationInvitationRecord, invitationId: string, expiresAt: Date): Promise<OrganizationInvitationRecord> {
    const updated = await this.db.updateTable("organization_invitation_records")
      .set({ invitation_id: invitationId, expires_at: expiresAt })
      .where("organization_id", "=", record.organizationId).where("address_digest", "=", record.addressDigest)
      .where("attempt_request_id", "=", record.attemptRequestId).where("invitation_id", "is", null)
      .where("lease_until", "=", record.leaseUntil)
      .returningAll().executeTakeFirst();
    if (!updated) throw new Error("Invitation claim lost");
    return mapInvitation(updated);
  }

  async deleteInvitation(organizationId: string, invitationId: string): Promise<void> {
    await this.db.deleteFrom("organization_invitation_records")
      .where("organization_id", "=", organizationId).where("invitation_id", "=", invitationId).execute();
  }

  async deleteInvitationTerminal(organizationId: string, invitationId: string, requestId?: string): Promise<void> {
    await this.db.deleteFrom("organization_invitation_records")
      .where("organization_id", "=", organizationId)
      .where((eb) => requestId
        ? eb.or([eb("invitation_id", "=", invitationId), eb.and([eb("invitation_id", "is", null), eb("attempt_request_id", "=", requestId)])])
        : eb("invitation_id", "=", invitationId))
      .execute();
  }

  async pruneInvitations(): Promise<void> {
    await this.db.deleteFrom("organization_invitation_records").where("expires_at", "<", this.now()).execute();
  }

  /** The request row and its rate charge commit atomically. Replays are free. */
  async beginCreate(actorId: string, clientRequestId: string, name: string): Promise<{ request: OrganizationAdminRequest; inserted: boolean }> {
    const now = this.now();
    return this.db.transaction().execute(async (trx) => {
      const inserted = await trx.insertInto("organization_admin_requests").values({
        actor_id: actorId, client_request_id: clientRequestId, name,
        state: "pending", organization_id: null, created_at: now, updated_at: now,
        lease_until: new Date(now.getTime() + INITIAL_SETTLE_MS),
      }).onConflict((conflict) => conflict.columns(["actor_id", "client_request_id"]).doNothing())
        .returningAll().executeTakeFirst();
      if (inserted) {
        const windowStart = new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS);
        const counter = await sql<{ count: number }>`
          INSERT INTO organization_admin_counters (scope_id, action, window_start, count)
          VALUES (${actorId}, 'create', ${windowStart}, 1)
          ON CONFLICT (scope_id, action, window_start)
          DO UPDATE SET count = organization_admin_counters.count + 1
          WHERE organization_admin_counters.count < ${CREATE_LIMIT}
          RETURNING count
        `.execute(trx);
        if (counter.rows.length === 0) {
          throw new OrganizationCreateLimitError(Math.max(1, Math.ceil((windowStart.getTime() + DAY_MS - now.getTime()) / 1000)));
        }
      }
      const row = inserted ?? await trx.selectFrom("organization_admin_requests").selectAll()
        .where("actor_id", "=", actorId).where("client_request_id", "=", clientRequestId).executeTakeFirstOrThrow();
      return { request: mapRow(row), inserted: Boolean(inserted) };
    });
  }

  async getRequest(actorId: string, clientRequestId: string): Promise<OrganizationAdminRequest | null> {
    const row = await this.db.selectFrom("organization_admin_requests").selectAll()
      .where("actor_id", "=", actorId).where("client_request_id", "=", clientRequestId).executeTakeFirst();
    return row ? mapRow(row) : null;
  }

  async listSettingUp(actorId: string): Promise<Array<{ organizationId: string; name: string; state: "setting_up" }>> {
    const rows = await this.db.selectFrom("organization_admin_requests")
      .select(["organization_id", "name"])
      .where("actor_id", "=", actorId).where("state", "=", "created")
      .where("organization_id", "is not", null).orderBy("created_at", "desc").limit(100).execute();
    return rows.filter((row): row is typeof row & { organization_id: string } => row.organization_id !== null)
      .map((row) => ({ organizationId: row.organization_id, name: row.name, state: "setting_up" }));
  }

  async markCreated(request: OrganizationAdminRequest, organizationId: string): Promise<void> {
    await this.db.updateTable("organization_admin_requests")
      .set({ state: "created", organization_id: organizationId, updated_at: this.now(), lease_until: this.now() })
      .where("actor_id", "=", request.actorId).where("client_request_id", "=", request.clientRequestId)
      .where("state", "=", "pending").execute();
  }

  async markListed(request: OrganizationAdminRequest): Promise<void> {
    await this.setState(request, "listed");
  }

  async markNeedsReview(request: OrganizationAdminRequest): Promise<void> {
    await this.setState(request, "needs_review");
  }

  async markFailed(request: OrganizationAdminRequest): Promise<void> {
    await this.setState(request, "failed");
  }

  private async setState(request: OrganizationAdminRequest, state: OrganizationAdminRequestState): Promise<void> {
    await this.db.updateTable("organization_admin_requests")
      .set({ state, updated_at: this.now(), lease_until: null })
      .where("actor_id", "=", request.actorId).where("client_request_id", "=", request.clientRequestId)
      .where("state", "=", request.state).execute();
  }

  async defer(request: OrganizationAdminRequest, delayMs: number): Promise<void> {
    const now = this.now();
    await this.db.updateTable("organization_admin_requests")
      .set({ lease_until: new Date(now.getTime() + delayMs), updated_at: now })
      .where("actor_id", "=", request.actorId).where("client_request_id", "=", request.clientRequestId)
      .where("state", "=", request.state).execute();
  }

  /** A durable lease prevents two platform instances from calling Clerk for one request. */
  async claimDue(limit = 50): Promise<OrganizationAdminRequest[]> {
    const now = this.now();
    return this.db.transaction().execute(async (trx) => {
      const due = await trx.selectFrom("organization_admin_requests").selectAll()
        .where("state", "in", ["pending", "created"])
        .where("lease_until", "<=", now)
        .orderBy("created_at", "asc").limit(Math.min(limit, 50))
        .forUpdate().skipLocked().execute();
      for (const row of due) {
        await trx.updateTable("organization_admin_requests")
          .set({ lease_until: new Date(now.getTime() + CLAIM_LEASE_MS), updated_at: now })
          .where("actor_id", "=", row.actor_id).where("client_request_id", "=", row.client_request_id).execute();
      }
      return due.map(mapRow);
    });
  }

  async prune(): Promise<void> {
    const now = this.now();
    await this.db.deleteFrom("organization_admin_requests")
      .where("created_at", "<", new Date(now.getTime() - 7 * DAY_MS))
      .where("state", "in", ["listed", "failed", "needs_review"]).execute();
    await this.db.deleteFrom("organization_admin_counters")
      .where("window_start", "<", new Date(now.getTime() - 2 * DAY_MS)).execute();
    await this.pruneInvitations();
  }

  async readinessCounts(): Promise<{ needsReviewCount: number; failedCount: number }> {
    const rows = await this.db.selectFrom("organization_admin_requests")
      .select(["state", (eb) => eb.fn.countAll<string>().as("count")])
      .where("state", "in", ["needs_review", "failed"])
      .groupBy("state").execute();
    const count = (state: OrganizationAdminRequestState) => Number(rows.find((row) => row.state === state)?.count ?? 0);
    return { needsReviewCount: count("needs_review"), failedCount: count("failed") };
  }
}

function mapInvitation(row: Selectable<OrganizationInvitationRecordsTable>): OrganizationInvitationRecord {
  return {
    organizationId: row.organization_id, addressDigest: row.address_digest,
    clientRequestId: row.client_request_id, attemptRequestId: row.attempt_request_id, role: row.role, invitationId: row.invitation_id,
    inviterId: row.inviter_id, expiresAt: new Date(row.expires_at), leaseUntil: new Date(row.lease_until),
  };
}

function mapRow(row: Selectable<OrganizationAdminRequestsTable>): OrganizationAdminRequest {
  return {
    actorId: row.actor_id, clientRequestId: row.client_request_id, name: row.name,
    state: row.state, organizationId: row.organization_id,
    createdAt: new Date(row.created_at), leaseUntil: row.lease_until ? new Date(row.lease_until) : null,
  };
}
