import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { gallerySyncIntervalMs, type GallerySyncInput, type GallerySyncSnapshot } from "@matrix-os/contracts/app-gallery-sync";

const table = "gallery_sync";
const LEASE_MS = 10 * 60_000;
export class GallerySyncError extends Error {
  constructor(readonly code: "invalid" | "denied" | "conflict" | "unavailable") { super("App sync is unavailable"); }
}
export interface GallerySyncLease {
  ownerId: string; appId: string; selection: GallerySyncInput; snapshot: GallerySyncSnapshot; checkpoint: Record<string, string> | null;
}
function project(row: any): GallerySyncLease {
  return { ownerId: row.owner_id, appId: row.app_id, selection: row.selection, snapshot: row.snapshot, checkpoint: row.checkpoint };
}
function selectionKey(s: GallerySyncInput) { return JSON.stringify([s.start, s.end, s.scope, s.context, s.keepUpdated, s.accounts.map(a => [a.service, a.label, a.connectionId, a.expectedEmail])]); }
function queued(appId: string, selection: GallerySyncInput, previous: GallerySyncSnapshot | undefined, now: Date): GallerySyncSnapshot {
  return { appId, runId: randomUUID(), status: "queued", stage: "queued", sources: selection.accounts.map(a => ({ service: a.service, label: a.label, email: a.expectedEmail, status: "pending" })),
    steps: 0, added: 0, updated: 0, skipped: 0, keepUpdated: selection.keepUpdated, startedAt: null, updatedAt: now.toISOString(), lastCheckedAt: previous?.lastCheckedAt ?? null, nextCheckAt: null, error: null };
}
/** One bounded config per owner/app. All progress writes are fenced by run ID and lease. */
export class GallerySyncRepository {
  constructor(readonly db: Kysely<any>) {}
  async bootstrap() {
    await this.db.transaction().execute(async trx => {
      await sql`CREATE TABLE IF NOT EXISTS gallery_sync_owners (owner_id TEXT PRIMARY KEY)`.execute(trx);
      await sql`CREATE TABLE IF NOT EXISTS gallery_sync (
        owner_id TEXT NOT NULL, app_id TEXT NOT NULL, selection JSONB NOT NULL, snapshot JSONB NOT NULL,
        run_id UUID NOT NULL, lease_until TIMESTAMPTZ, next_run_at TIMESTAMPTZ, checkpoint JSONB,
        PRIMARY KEY (owner_id, app_id)
      )`.execute(trx);
    });
  }
  async get(ownerId: string, appId: string): Promise<GallerySyncLease | null> {
    const row = await this.db.selectFrom(table).selectAll().where("owner_id", "=", ownerId).where("app_id", "=", appId).executeTakeFirst();
    return row ? project(row) : null;
  }
  async configure(ownerId: string, appId: string, selection: GallerySyncInput, now: Date): Promise<GallerySyncSnapshot> {
    return this.db.transaction().execute(async trx => {
      await trx.insertInto("gallery_sync_owners").values({ owner_id: ownerId }).onConflict(oc => oc.column("owner_id").doNothing()).execute();
      await trx.selectFrom("gallery_sync_owners").selectAll().where("owner_id", "=", ownerId).forUpdate().executeTakeFirstOrThrow();
      const current = await trx.selectFrom(table).selectAll().where("owner_id", "=", ownerId).where("app_id", "=", appId).executeTakeFirst();
      if (current && current.selection.requestId === selection.requestId) {
        if (selectionKey(current.selection) !== selectionKey(selection)) throw new GallerySyncError("conflict");
        return current.snapshot;
      }
      if (current && ["queued", "running"].includes(current.snapshot.status)) throw new GallerySyncError("conflict");
      const count = await trx.selectFrom(table).select(trx.fn.countAll().as("n")).where("owner_id", "=", ownerId).executeTakeFirstOrThrow();
      if (!current && Number(count.n) >= 40) throw new GallerySyncError("unavailable");
      const snapshot = queued(appId, selection, current?.snapshot, now);
      // New account/range selections must receive a full first import.
      snapshot.lastCheckedAt = null;
      await trx.insertInto(table).values({ owner_id: ownerId, app_id: appId, selection: JSON.stringify(selection), snapshot: JSON.stringify(snapshot), run_id: snapshot.runId })
        .onConflict(oc => oc.columns(["owner_id", "app_id"]).doUpdateSet({ selection: JSON.stringify(selection), snapshot: JSON.stringify(snapshot), run_id: snapshot.runId, lease_until: null, next_run_at: null, checkpoint: null })).execute();
      return snapshot;
    });
  }
  async claim(now: Date): Promise<GallerySyncLease | null> {
    return this.db.transaction().execute(async trx => {
      // An uncertain interrupted AI run requires an explicit retry, never an automatic replay.
      await sql`UPDATE gallery_sync SET snapshot = snapshot || ${JSON.stringify({ status: "failed", stage: "finished", error: "interrupted", nextCheckAt: null, updatedAt: now.toISOString() })}::jsonb
        || jsonb_build_object('sources', (SELECT jsonb_agg(CASE WHEN source->>'status' = 'running' THEN source || '{"status":"failed"}'::jsonb ELSE source END)
          FROM jsonb_array_elements(snapshot->'sources') AS source)),
        lease_until = NULL, next_run_at = NULL WHERE snapshot->>'status' = 'running' AND lease_until <= ${now}`.execute(trx);
      const row = await trx.selectFrom(table).selectAll().where(eb => eb.or([
        sql<boolean>`snapshot->>'status' = 'queued'`,
        eb.and([sql<boolean>`snapshot->>'status' = 'complete'`, eb("next_run_at", "<=", now)]),
      ])).orderBy(sql`CASE WHEN snapshot->>'status' = 'queued' THEN 0 ELSE 1 END`).orderBy("next_run_at", "asc").forUpdate().skipLocked().executeTakeFirst();
      if (!row) return null;
      let snapshot: GallerySyncSnapshot = row.snapshot;
      if (snapshot.status === "complete") snapshot = queued(row.app_id, row.selection, snapshot, now);
      snapshot = { ...snapshot, status: "running", stage: "reading", startedAt: now.toISOString(), updatedAt: now.toISOString(), nextCheckAt: null };
      const claimed = await trx.updateTable(table).set({ snapshot: JSON.stringify(snapshot), run_id: snapshot.runId, lease_until: new Date(now.getTime() + LEASE_MS), next_run_at: null })
        .where("owner_id", "=", row.owner_id).where("app_id", "=", row.app_id).where("run_id", "=", row.run_id)
        .where(sql<boolean>`snapshot->>'status' IN ('queued','complete')`).returning("owner_id").executeTakeFirst();
      if (!claimed) return null;
      return { ownerId: row.owner_id, appId: row.app_id, selection: row.selection, snapshot, checkpoint: row.checkpoint };
    });
  }
  private active(lease: GallerySyncLease, now: Date) {
    return this.db.updateTable(table).where("owner_id", "=", lease.ownerId).where("app_id", "=", lease.appId)
      .where("run_id", "=", lease.snapshot.runId).where("lease_until", ">", now).where(sql<boolean>`snapshot->>'status' = 'running'`);
  }
  async progress(lease: GallerySyncLease, patch: Partial<GallerySyncSnapshot>, now: Date): Promise<boolean> {
    const snapshot = { ...lease.snapshot, ...patch, updatedAt: now.toISOString() };
    const result = await this.active(lease, now).set({ snapshot: JSON.stringify(snapshot) }).returning("owner_id").executeTakeFirst();
    if (!result) return false;
    lease.snapshot = snapshot;
    return true;
  }
  async finish(lease: GallerySyncLease, patch: Partial<GallerySyncSnapshot>, now: Date, checkpoint?: Record<string, string> | null): Promise<void> {
    const snapshot = { ...lease.snapshot, ...patch, updatedAt: now.toISOString() };
    if (snapshot.status === "complete") {
      snapshot.lastCheckedAt = now.toISOString();
      snapshot.nextCheckAt = snapshot.keepUpdated ? new Date(now.getTime() + gallerySyncIntervalMs(lease.selection.accounts)).toISOString() : null;
    } else snapshot.nextCheckAt = null;
    const result = await this.active(lease, now).set({ snapshot: JSON.stringify(snapshot), lease_until: null, next_run_at: snapshot.nextCheckAt ? new Date(snapshot.nextCheckAt) : null,
      ...(snapshot.status === "complete" && checkpoint !== undefined ? { checkpoint: checkpoint ? JSON.stringify(checkpoint) : null } : {}) }).returning("owner_id").executeTakeFirst();
    if (!result) throw new GallerySyncError("conflict");
  }
  async pause(ownerId: string, appId: string, now: Date): Promise<GallerySyncSnapshot> {
    return this.db.transaction().execute(async trx => {
      const row = await trx.selectFrom(table).selectAll().where("owner_id", "=", ownerId).where("app_id", "=", appId).forUpdate().executeTakeFirst();
      if (!row) throw new GallerySyncError("invalid");
      const snapshot: GallerySyncSnapshot = { ...row.snapshot, runId: randomUUID(), status: "paused", keepUpdated: false, nextCheckAt: null, updatedAt: now.toISOString(),
        sources: row.snapshot.sources.map((s: GallerySyncSnapshot["sources"][number]) => s.status === "running" ? { ...s, status: "pending" } : s) };
      await trx.updateTable(table).set({ selection: JSON.stringify({ ...row.selection, keepUpdated: false }), snapshot: JSON.stringify(snapshot), run_id: snapshot.runId, lease_until: null, next_run_at: null })
        .where("owner_id", "=", ownerId).where("app_id", "=", appId).execute();
      return snapshot;
    });
  }
  async retry(ownerId: string, appId: string, resume: boolean, now: Date): Promise<GallerySyncSnapshot> {
    return this.db.transaction().execute(async trx => {
      const row = await trx.selectFrom(table).selectAll().where("owner_id", "=", ownerId).where("app_id", "=", appId).forUpdate().executeTakeFirst();
      if (!row || ["running", "queued"].includes(row.snapshot.status)) throw new GallerySyncError("conflict");
      const selection = { ...row.selection, requestId: randomUUID(), keepUpdated: resume || row.selection.keepUpdated };
      const snapshot = queued(appId, selection, row.snapshot, now);
      await trx.updateTable(table).set({ selection: JSON.stringify(selection), snapshot: JSON.stringify(snapshot), run_id: snapshot.runId, lease_until: null, next_run_at: null })
        .where("owner_id", "=", ownerId).where("app_id", "=", appId).execute();
      return snapshot;
    });
  }
}
