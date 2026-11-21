/** 2694: public-site visitors use one app's owner data; every write is logged in its transaction. */
import { sql, type Kysely, type RawBuilder, type Transaction } from "kysely";
import { SITE_PUBLIC_DATA_MAX_ROWS, SITE_PUBLIC_DATA_RESPONSE_MAX_BYTES, type SitePublicDataCapability, type SitePublicDbAction } from "@matrix-os/contracts";
import { isSafeName, type TableDef } from "../app-db-types.js";

export type SitePublicDataErrorCode = "invalid" | "unavailable";
export class SitePublicDataError extends Error {
  constructor(readonly code: SitePublicDataErrorCode) {
    super(code === "invalid" ? "Invalid change" : "Shared data is unavailable");
    this.name = "SitePublicDataError";
  }
}

export interface SitePublicAppRecord { tables: Record<string, TableDef>; installed_version: string | null }
export interface SitePublicDataResult { result: unknown; changed: { app: string; key: string } | null }
type Row = Record<string, unknown>;
type Filter = NonNullable<Extract<SitePublicDbAction, { action: "find" }>["filter"]>;
type LogEntry = { table: string; rowId: string; op: "insert" | "update" | "delete" | "kv_write"; before: unknown; after: unknown };

const LOG_TABLE = sql`public._site_visitor_writes`;
const SNAPSHOT_MAX_BYTES = 64 * 1024;
const TRIM_BATCH = 100;
// Constraint, data and undefined-column failures come from the visitor's payload.
const INVALID_SQLSTATE = /^(?:22|23|42703|42804|42883)/;

function identifier(value: string): RawBuilder<unknown> {
  if (!isSafeName(value)) throw new SitePublicDataError("invalid");
  return sql.id(value);
}
function bound(value: unknown): RawBuilder<unknown> {
  return sql`${value === null || typeof value !== "object" ? value : JSON.stringify(value)}`;
}
function whereClause(filter: Filter | undefined): RawBuilder<unknown> {
  if (!filter || Object.keys(filter).length === 0) return sql``;
  const clauses: RawBuilder<unknown>[] = [];
  for (const [column, value] of Object.entries(filter)) {
    const col = identifier(column);
    if (value === null) clauses.push(sql`${col} IS NULL`);
    else if (typeof value !== "object") clauses.push(sql`${col} = ${value}`);
    else {
      if (value.$eq !== undefined) clauses.push(sql`${col} = ${value.$eq}`);
      if (value.$ne !== undefined) clauses.push(sql`${col} <> ${value.$ne}`);
      if (value.$lt !== undefined) clauses.push(sql`${col} < ${value.$lt}`);
      if (value.$lte !== undefined) clauses.push(sql`${col} <= ${value.$lte}`);
      if (value.$gt !== undefined) clauses.push(sql`${col} > ${value.$gt}`);
      if (value.$gte !== undefined) clauses.push(sql`${col} >= ${value.$gte}`);
      if (value.$in !== undefined) clauses.push(value.$in.length === 0 ? sql`FALSE` : sql`${col} IN (${sql.join(value.$in)})`);
      if (value.$like !== undefined) clauses.push(sql`${col} LIKE ${value.$like}`);
      if (value.$ilike !== undefined) clauses.push(sql`${col} ILIKE ${value.$ilike}`);
    }
  }
  return clauses.length === 0 ? sql`` : sql` WHERE ${sql.join(clauses, sql` AND `)}`;
}
function orderClause(order: Extract<SitePublicDbAction, { action: "find" }>["orderBy"]): RawBuilder<unknown> {
  if (!order || Object.keys(order).length === 0) return sql``;
  return sql` ORDER BY ${sql.join(Object.entries(order).map(([column, direction]) =>
    sql`${identifier(column)} ${sql.raw(direction === "desc" ? "DESC" : "ASC")}`))}`;
}
function columns(data: Row) {
  const entries = Object.entries(data);
  return {
    names: sql.join(entries.map(([column]) => identifier(column))),
    values: sql.join(entries.map(([, value]) => bound(value))),
    assignments: sql.join(entries.map(([column, value]) => sql`${identifier(column)} = ${bound(value)}`)),
    // Like the owner bridge, writes stamp updated_at unless the app sets it explicitly.
    touch: Object.hasOwn(data, "updated_at") ? sql`` : sql`, updated_at = now()`,
  };
}
function snapshot(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const json = JSON.stringify(value);
  return Buffer.byteLength(json) > SNAPSHOT_MAX_BYTES ? JSON.stringify({ omitted: "too_large" }) : json;
}
function sqlState(error: unknown): string | null {
  const code = error && typeof error === "object" && "code" in error ? (error as { code: unknown }).code : null;
  return typeof code === "string" ? code : null;
}

/** Wrapper never destroys the dependency-injected owner database. */
export class SitePublicDataRepository {
  constructor(private readonly db: Kysely<any>, private readonly options: {
    resolveApp(appSlug: string): Promise<SitePublicAppRecord | null>;
    retention?: { maxEntriesPerSite: number; maxAgeDays: number };
  }) {}

  /** Owner-only table; no route reads it in v1. Run on the owned setup connection. */
  static async bootstrap(db: Kysely<any>): Promise<void> {
    await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL lock_timeout = '2s'`.execute(trx);
      await sql`SET LOCAL statement_timeout = '5s'`.execute(trx);
      await sql`CREATE TABLE IF NOT EXISTS public._site_visitor_writes (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, site_id uuid NOT NULL, app_slug text NOT NULL,
 table_name text NOT NULL, row_id text NOT NULL, op text NOT NULL CHECK (op IN ('insert','update','delete','kv_write')),
 before jsonb, after jsonb, visitor_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`.execute(trx);
      await sql`CREATE INDEX IF NOT EXISTS site_visitor_writes_site ON public._site_visitor_writes(site_id, id)`.execute(trx);
    });
  }

  async execute(capability: SitePublicDataCapability): Promise<SitePublicDataResult> {
    let outcome: SitePublicDataResult;
    try {
      outcome = await this.run(capability);
    } catch (error: unknown) {
      if (error instanceof SitePublicDataError) throw error;
      const state = sqlState(error);
      if (state && INVALID_SQLSTATE.test(state)) throw new SitePublicDataError("invalid");
      console.warn("[sites] Public data request failed", error instanceof Error ? error.name : "UnknownError", state ?? "");
      throw new SitePublicDataError("unavailable");
    }
    if (Buffer.byteLength(JSON.stringify(outcome.result ?? null)) > SITE_PUBLIC_DATA_RESPONSE_MAX_BYTES) {
      throw new SitePublicDataError("unavailable");
    }
    return outcome;
  }

  private async run(capability: SitePublicDataCapability): Promise<SitePublicDataResult> {
    const { request, appSlug } = capability;
    if (request.kind === "kvRead" || request.kind === "kvWrite") {
      return this.transaction(capability, async (trx, log) => {
        if (request.kind === "kvRead") {
          const row = await sql<{ value: string | null }>`SELECT value FROM public._kv WHERE app = ${appSlug} AND key = ${request.key}`.execute(trx);
          return { result: { value: row.rows[0]?.value ?? null }, changed: null };
        }
        const before = await this.writeKv(trx, appSlug, request.key, request.value);
        log.push({ table: "_kv", rowId: request.key, op: "kv_write", before, after: { value: request.value } });
        return { result: { ok: true }, changed: { app: appSlug, key: request.key } };
      });
    }
    const action = request.action;
    // Same answer as the owner bridge, which refuses this app identity for db.* at request validation.
    if (!isSafeName(appSlug)) throw new SitePublicDataError("invalid");
    const app = await this.options.resolveApp(appSlug);
    if (!app) throw new SitePublicDataError("unavailable");
    if (action.action === "appInfo") return { result: { installedVersion: app.installed_version }, changed: null };
    if (action.action === "schema") return { result: app.tables, changed: null };
    if (!Object.hasOwn(app.tables, action.table)) throw new SitePublicDataError("invalid");
    const target = sql`${identifier(appSlug)}.${identifier(action.table)}`;
    const changed = { app: appSlug, key: action.table };
    return this.transaction(capability, async (trx, log) => {
      const record = (op: LogEntry["op"], before: Row | null, after: Row | null) => {
        log.push({ table: action.table, rowId: String((after ?? before)?.id ?? ""), op, before, after });
      };
      switch (action.action) {
        case "find": {
          const limit = Math.max(1, Math.min(action.limit ?? SITE_PUBLIC_DATA_MAX_ROWS, SITE_PUBLIC_DATA_MAX_ROWS));
          const rows = await sql<Row>`SELECT * FROM ${target}${whereClause(action.filter)}${orderClause(action.orderBy)} LIMIT ${limit} OFFSET ${action.offset ?? 0}`.execute(trx);
          return { result: rows.rows, changed: null };
        }
        case "findOne": {
          const rows = await sql<Row>`SELECT * FROM ${target} WHERE id = ${action.id} LIMIT 1`.execute(trx);
          return { result: rows.rows[0] ?? null, changed: null };
        }
        case "count": {
          const rows = await sql<{ count: number }>`SELECT COUNT(*)::int AS count FROM ${target}${whereClause(action.filter)}`.execute(trx);
          return { result: { count: Number(rows.rows[0]?.count ?? 0) }, changed: null };
        }
        case "insert": {
          const data = columns(action.data);
          const rows = await sql<Row>`INSERT INTO ${target} (${data.names}) VALUES (${data.values}) RETURNING *`.execute(trx);
          const after = rows.rows[0] ?? null;
          if (after) record("insert", null, after);
          return { result: { id: after?.id }, changed };
        }
        case "bulkInsert": {
          const ids: unknown[] = [];
          for (const row of action.rows) {
            const data = columns(row);
            const rows = await sql<Row>`INSERT INTO ${target} (${data.names}) VALUES (${data.values}) ON CONFLICT DO NOTHING RETURNING *`.execute(trx);
            const after = rows.rows[0];
            if (after) { ids.push(after.id); record("insert", null, after); }
          }
          return { result: { ids: ids.map(String) }, changed };
        }
        case "update":
        case "bulkUpdate": {
          const updates = action.action === "update" ? [{ id: action.id, data: action.data }] : action.updates;
          for (const update of updates) {
            const before = await sql<Row>`SELECT * FROM ${target} WHERE id = ${update.id} FOR UPDATE`.execute(trx);
            if (!before.rows[0]) continue;
            const data = columns(update.data);
            const rows = await sql<Row>`UPDATE ${target} SET ${data.assignments}${data.touch} WHERE id = ${update.id} RETURNING *`.execute(trx);
            record("update", before.rows[0], rows.rows[0] ?? null);
          }
          return { result: { ok: true }, changed };
        }
        case "compareAndSwap": {
          const before = await sql<Row>`SELECT * FROM ${target} WHERE id = ${action.id} FOR UPDATE`.execute(trx);
          // The snapshot predicate stays in the write statement, as on the owner bridge.
          const data = columns(action.data);
          const rows = await sql<Row>`UPDATE ${target} SET ${data.assignments}${data.touch}
 WHERE id = ${action.id} AND payload = ${JSON.stringify(action.expectedPayload)}::jsonb RETURNING *`.execute(trx);
          if (!rows.rows[0]) return { result: { ok: false }, changed: null };
          record("update", before.rows[0] ?? null, rows.rows[0]);
          return { result: { ok: true }, changed };
        }
        case "delete": {
          const rows = await sql<Row>`DELETE FROM ${target} WHERE id = ${action.id} RETURNING *`.execute(trx);
          if (rows.rows[0]) record("delete", rows.rows[0], null);
          return { result: { ok: true }, changed };
        }
      }
    });
  }

  /**
   * Captures the value a visitor write replaces. A missing key is created with ON CONFLICT DO NOTHING;
   * if another writer created it first, the row is then locked and read, so the log never records
   * `before: null` for a value that was overwritten.
   */
  private async writeKv(trx: Transaction<any>, app: string, key: string, value: string): Promise<{ value: string | null } | null> {
    const select = () => sql<{ value: string | null }>`SELECT value FROM public._kv WHERE app = ${app} AND key = ${key} FOR UPDATE`.execute(trx);
    let existing = (await select()).rows[0];
    if (!existing) {
      const created = await sql`INSERT INTO public._kv (app, key, value, updated_at) VALUES (${app}, ${key}, ${value}, now())
 ON CONFLICT (app, key) DO NOTHING RETURNING key`.execute(trx);
      if (created.rows.length > 0) return null;
      existing = (await select()).rows[0];
      if (!existing) throw new SitePublicDataError("unavailable");
    }
    await sql`UPDATE public._kv SET value = ${value}, updated_at = now() WHERE app = ${app} AND key = ${key}`.execute(trx);
    return { value: existing.value };
  }

  private async transaction(capability: SitePublicDataCapability, work: (trx: Transaction<any>, log: LogEntry[]) => Promise<SitePublicDataResult>): Promise<SitePublicDataResult> {
    return this.db.transaction().execute(async (trx) => {
      await sql`SET LOCAL statement_timeout = '5s'`.execute(trx);
      await sql`SET LOCAL lock_timeout = '2s'`.execute(trx);
      const log: LogEntry[] = [];
      const outcome = await work(trx, log);
      if (log.length > 0) {
        try { await this.writeLog(trx, capability, log); }
        catch (error: unknown) {
          // A log failure is a server fault, never the visitor's payload; the write rolls back with it.
          console.warn("[sites] Public data write log failed", error instanceof Error ? error.name : "UnknownError", sqlState(error) ?? "");
          throw new SitePublicDataError("unavailable");
        }
      }
      return outcome;
    });
  }

  private async writeLog(trx: Transaction<any>, capability: SitePublicDataCapability, entries: LogEntry[]): Promise<void> {
    await sql`INSERT INTO ${LOG_TABLE} (site_id, app_slug, table_name, row_id, op, before, after, visitor_hash) VALUES ${sql.join(entries.map((entry) =>
      sql`(${capability.siteId}, ${capability.appSlug}, ${entry.table}, ${entry.rowId}, ${entry.op}, ${snapshot(entry.before)}::jsonb, ${snapshot(entry.after)}::jsonb, ${capability.visitor})`))}`.execute(trx);
    const retention = this.options.retention ?? { maxEntriesPerSite: 10_000, maxAgeDays: 30 };
    await sql`DELETE FROM ${LOG_TABLE} WHERE id IN (SELECT id FROM ${LOG_TABLE} WHERE site_id = ${capability.siteId}
 AND created_at < now() - make_interval(days => ${retention.maxAgeDays}) ORDER BY id LIMIT ${TRIM_BATCH})`.execute(trx);
    await sql`DELETE FROM ${LOG_TABLE} WHERE id IN (SELECT id FROM ${LOG_TABLE} WHERE site_id = ${capability.siteId}
 ORDER BY id DESC OFFSET ${retention.maxEntriesPerSite} LIMIT ${TRIM_BATCH})`.execute(trx);
  }
}
