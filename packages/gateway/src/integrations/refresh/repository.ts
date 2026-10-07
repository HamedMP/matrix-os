import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { IntegrationRefreshError, REFRESH_LIMITS, type RefreshBinding, type RefreshJob } from "./contracts.js";

const table = "integration_refresh_sources";
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
const instant = (value: Date | string | null): string | null => value === null ? null : new Date(value).toISOString();
function project(row: Record<string, any>): RefreshJob {
  return { id: row.id, ownerId: row.owner_id, binding: row.binding, revision: Number(row.revision), status: row.status,
    cursor: row.cursor, checkpoint: row.checkpoint, calls: Number(row.calls), pages: Number(row.pages), bytes: Number(row.bytes), failures: Number(row.failures),
    leaseToken: row.lease_token, leaseExpiresAt: instant(row.lease_expires_at), retryAt: instant(row.retry_at), errorCode: row.error_code };
}

/** Inject the owner's runtime Postgres; this repository never owns or closes the pool. */
export class IntegrationRefreshRepository {
  constructor(readonly db: Kysely<any>) {}
  async bootstrap(): Promise<void> {
    await this.db.transaction().execute(async trx => {
    await sql`CREATE TABLE IF NOT EXISTS integration_refresh_owners (owner_id TEXT PRIMARY KEY)`.execute(trx);
    await sql`CREATE TABLE IF NOT EXISTS integration_refresh_sources (
      id UUID PRIMARY KEY, owner_id TEXT NOT NULL, app_id TEXT NOT NULL, source_id TEXT NOT NULL, binding JSONB NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','running','complete','backoff','failed','exhausted')),
      revision INTEGER NOT NULL DEFAULT 0, cursor JSONB, checkpoint JSONB,
      calls INTEGER NOT NULL DEFAULT 0 CHECK(calls BETWEEN 0 AND 8), pages INTEGER NOT NULL DEFAULT 0 CHECK(pages BETWEEN 0 AND 5),
      bytes INTEGER NOT NULL DEFAULT 0 CHECK(bytes BETWEEN 0 AND 2097152), failures INTEGER NOT NULL DEFAULT 0,
      lease_token UUID, lease_expires_at TIMESTAMPTZ, retry_at TIMESTAMPTZ, error_code TEXT,
      created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
      UNIQUE(owner_id, app_id, source_id)
    )`.execute(trx);
    await sql`CREATE TABLE IF NOT EXISTS integration_refresh_pages (
      source_id UUID NOT NULL REFERENCES integration_refresh_sources(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL CHECK(seq BETWEEN 1 AND 5), data JSONB NOT NULL,
      PRIMARY KEY(source_id, seq)
    )`.execute(trx);
    });
  }
  async ensure(ownerId: string, binding: RefreshBinding, now: Date): Promise<RefreshJob> {
    return this.db.transaction().execute(async trx => {
      await trx.insertInto("integration_refresh_owners").values({ owner_id: ownerId }).onConflict(oc => oc.column("owner_id").doNothing()).execute();
      await trx.selectFrom("integration_refresh_owners").select("owner_id").where("owner_id", "=", ownerId).forUpdate().executeTakeFirstOrThrow();
      const existing = await trx.selectFrom(table).selectAll().where("owner_id", "=", ownerId).where("app_id", "=", binding.appId).where("source_id", "=", binding.sourceId).executeTakeFirst();
      if (existing) {
        if (canonical(existing.binding) !== canonical(binding)) throw new IntegrationRefreshError("conflict");
        return project(existing);
      }
      const count = await trx.selectFrom(table).select(({ fn }) => fn.countAll().as("count")).where("owner_id", "=", ownerId).executeTakeFirstOrThrow();
      if (Number(count.count) >= REFRESH_LIMITS.maxJobs) throw new IntegrationRefreshError("budget");
      const row = await trx.insertInto(table).values({ id: randomUUID(), owner_id: ownerId, app_id: binding.appId, source_id: binding.sourceId,
        binding: JSON.stringify(binding), status: "pending", created_at: now, updated_at: now }).onConflict(oc => oc.columns(["owner_id", "app_id", "source_id"]).doNothing()).returningAll().executeTakeFirstOrThrow();
      return project(row);
    });
  }
  async get(ownerId: string, appId: string, sourceId: string): Promise<RefreshJob | null> {
    const row = await this.db.selectFrom(table).selectAll().where("owner_id", "=", ownerId).where("app_id", "=", appId).where("source_id", "=", sourceId).executeTakeFirst();
    return row ? project(row) : null;
  }
  async pages(ownerId: string, appId: string, sourceId: string): Promise<unknown[]> {
    const rows = await this.db.selectFrom("integration_refresh_pages as pages").innerJoin(`${table} as sources`, "sources.id", "pages.source_id")
      .select("pages.data").where("sources.owner_id", "=", ownerId).where("sources.app_id", "=", appId).where("sources.source_id", "=", sourceId)
      .orderBy("pages.seq").limit(REFRESH_LIMITS.maxPages).execute();
    return rows.map(row => row.data);
  }
  async remove(ownerId: string, appId: string, sourceId: string): Promise<void> {
    // The FK cascade erases all pages in this same statement, including an in-flight lease.
    await this.db.deleteFrom(table).where("owner_id", "=", ownerId).where("app_id", "=", appId).where("source_id", "=", sourceId).execute();
  }
  async claim(ownerId: string, appId: string, sourceId: string, now: Date): Promise<RefreshJob | null> {
    return this.db.transaction().execute(async trx => {
    await trx.updateTable(table).set({ status: "exhausted", error_code: "budget_exhausted", lease_token: null, lease_expires_at: null, updated_at: now })
      .where("owner_id", "=", ownerId).where("app_id", "=", appId).where("source_id", "=", sourceId).where("status", "in", ["pending", "running", "backoff"])
      .where(eb => eb.or([eb("calls", ">=", REFRESH_LIMITS.maxCalls), eb("pages", ">=", REFRESH_LIMITS.maxPages), eb("bytes", ">=", REFRESH_LIMITS.maxBytes)]))
      .where(eb => eb.or([eb("lease_expires_at", "is", null), eb("lease_expires_at", "<=", now)])).execute();
    const row = await trx.updateTable(table).set({ status: "running", lease_token: randomUUID(), lease_expires_at: new Date(now.getTime() + REFRESH_LIMITS.leaseMs),
      calls: sql`calls + 1`, revision: sql`revision + 1`, updated_at: now })
      .where("owner_id", "=", ownerId).where("app_id", "=", appId).where("source_id", "=", sourceId)
      .where("status", "in", ["pending", "running", "backoff"]).where("calls", "<", REFRESH_LIMITS.maxCalls).where("pages", "<", REFRESH_LIMITS.maxPages).where("bytes", "<", REFRESH_LIMITS.maxBytes)
      .where(eb => eb.or([eb("lease_expires_at", "is", null), eb("lease_expires_at", "<=", now)]))
      .where(eb => eb.or([eb("retry_at", "is", null), eb("retry_at", "<=", now)]))
      .returningAll().executeTakeFirst();
    return row ? project(row) : null;
    });
  }
  private leased(lease: RefreshJob, now: Date, db: Kysely<any> = this.db) {
    return db.updateTable(table).where("id", "=", lease.id).where("owner_id", "=", lease.ownerId)
      .where("revision", "=", lease.revision).where("lease_token", "=", lease.leaseToken)
      .where("lease_expires_at", ">=", now).where("status", "=", "running");
  }
  async commit(lease: RefreshJob, data: unknown, cursor: Record<string, unknown> | null, checkpoint: Record<string, unknown> | null, now: Date): Promise<RefreshJob> {
    const bytes = Buffer.byteLength(JSON.stringify(data), "utf8");
    if (bytes > REFRESH_LIMITS.maxPageBytes || lease.bytes + bytes > REFRESH_LIMITS.maxBytes) return this.fail(lease, "budget_exhausted", now);
    return this.db.transaction().execute(async trx => {
      const exhausted = Boolean(cursor) && (lease.pages + 1 >= REFRESH_LIMITS.maxPages || lease.calls >= REFRESH_LIMITS.maxCalls);
      const row = await this.leased(lease, now, trx).set({ status: exhausted ? "exhausted" : cursor ? "pending" : "complete", cursor: cursor ? JSON.stringify(cursor) : null,
        checkpoint: checkpoint ? JSON.stringify(checkpoint) : lease.checkpoint ? JSON.stringify(lease.checkpoint) : null,
        pages: lease.pages + 1, bytes: lease.bytes + bytes, failures: 0, error_code: exhausted ? "budget_exhausted" : null,
        lease_token: null, lease_expires_at: null, retry_at: null, updated_at: now }).returningAll().executeTakeFirst();
      if (!row) throw new IntegrationRefreshError("conflict");
      await trx.insertInto("integration_refresh_pages").values({ source_id: lease.id, seq: lease.pages + 1, data: JSON.stringify(data) }).execute();
      return project(row);
    });
  }
  async fail(lease: RefreshJob, code: "source_unavailable" | "budget_exhausted", now: Date): Promise<RefreshJob> {
    const exhausted = code === "budget_exhausted" || lease.calls >= REFRESH_LIMITS.maxCalls;
    const row = await this.leased(lease, now).set({ status: exhausted ? "exhausted" : "backoff", error_code: code, failures: lease.failures + 1,
      retry_at: exhausted ? null : new Date(now.getTime() + Math.min(5 * 60 * 1000, 5000 * 2 ** Math.min(lease.failures, 6))),
      lease_token: null, lease_expires_at: null, updated_at: now }).returningAll().executeTakeFirst();
    if (!row) throw new IntegrationRefreshError("conflict");
    return project(row);
  }
  async restart(job: RefreshJob, now: Date): Promise<RefreshJob> {
    return this.db.transaction().execute(async trx => {
      const row = await trx.updateTable(table).set({ status: "pending", revision: sql`revision + 1`, cursor: null, calls: 0, pages: 0, bytes: 0, failures: 0,
        retry_at: null, lease_token: null, lease_expires_at: null, error_code: null, updated_at: now })
        .where("id", "=", job.id).where("owner_id", "=", job.ownerId).where("revision", "=", job.revision).where("status", "in", ["complete", "exhausted"])
        .returningAll().executeTakeFirst();
      if (!row) throw new IntegrationRefreshError("conflict");
      await trx.deleteFrom("integration_refresh_pages").where("source_id", "=", job.id).execute();
      return project(row);
    });
  }
}
