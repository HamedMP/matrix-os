import { sql, type Kysely, type Selectable } from "kysely";
import type { OrganizationAdminRequestsTable, OrganizationAdminRequestState, OrganizationPlatformDatabase } from "./database.js";

const CREATE_LIMIT = 3;
const DAY_MS = 24 * 60 * 60_000;
const INITIAL_SETTLE_MS = 2 * 60_000;
const CLAIM_LEASE_MS = 5 * 60_000;

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

function mapRow(row: Selectable<OrganizationAdminRequestsTable>): OrganizationAdminRequest {
  return {
    actorId: row.actor_id, clientRequestId: row.client_request_id, name: row.name,
    state: row.state, organizationId: row.organization_id,
    createdAt: new Date(row.created_at), leaseUntil: row.lease_until ? new Date(row.lease_until) : null,
  };
}
