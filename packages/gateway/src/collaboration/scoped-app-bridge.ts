/** Transactional bridge from a verified shared app instance to its owner Postgres schema. */
import { createHash } from "node:crypto";
import { sql, type RawBuilder } from "kysely";
import { BridgeQueryBodySchema, type BridgeQueryBody } from "../app-db-contracts.js";
import { isSafeName } from "../app-db-types.js";
import { ProjectAppAdapterError, type ProjectAppBridge } from "./project-app-adapter.js";

type AppRecord = { storageSchema: string; tables: readonly string[] };
type Filter = NonNullable<Extract<BridgeQueryBody, { action: "find" }>["filter"]>;

function expectedNamespace(scopeId: string, appId: string, kind: "project" | "standalone"): string {
  return `${kind === "project" ? "p" : "s"}${createHash("sha256").update(scopeId).update("\0").update(appId).digest("hex").slice(0, 32)}`;
}
function validIdentifier(value: string): string {
  if (!isSafeName(value)) throw new ProjectAppAdapterError("forbidden");
  return value;
}
function valueSql(value: unknown): RawBuilder<unknown> {
  return sql`${value === null || typeof value !== "object" ? value : JSON.stringify(value)}`;
}
function whereClause(filter: Filter | undefined): RawBuilder<unknown> {
  if (!filter || Object.keys(filter).length === 0) return sql``;
  const clauses: RawBuilder<unknown>[] = [];
  for (const [column, value] of Object.entries(filter)) {
    const col = sql.id(validIdentifier(column));
    if (value === null) {
      clauses.push(sql`${col} IS NULL`);
    } else if (typeof value !== "object") {
      clauses.push(sql`${col} = ${value}`);
    } else {
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
function orderClause(order: Extract<BridgeQueryBody, { action: "find" }>["orderBy"]): RawBuilder<unknown> {
  if (!order || Object.keys(order).length === 0) return sql``;
  const parts = Object.entries(order).map(([column, direction]) =>
    sql`${sql.id(validIdentifier(column))} ${sql.raw(direction === "desc" ? "DESC" : "ASC")}`);
  return sql` ORDER BY ${sql.join(parts)}`;
}
function columnsAndValues(data: Record<string, unknown>) {
  const entries = Object.entries(data);
  if (entries.length === 0) throw new ProjectAppAdapterError("invalid_action");
  return {
    names: sql.join(entries.map(([column]) => sql.id(validIdentifier(column)))),
    values: sql.join(entries.map(([, value]) => valueSql(value))),
  };
}
function assignments(data: Record<string, unknown>) {
  const entries = Object.entries(data);
  if (entries.length === 0) throw new ProjectAppAdapterError("invalid_action");
  return sql.join(entries.map(([column, value]) => sql`${sql.id(validIdentifier(column))} = ${valueSql(value)}`));
}

/**
 * The adapter already locked the share scope, binding/catalog row and checked
 * the actor in `transaction`. The bridge rejects a forged namespace, verifies
 * the app registry projection, then executes every query in that transaction.
 */
export function createScopedAppBridge(options: {
  resolveApp(appId: string): Promise<AppRecord | null>;
}): ProjectAppBridge {
  return {
    async execute(input) {
      if (!input.transaction) throw new ProjectAppAdapterError("unavailable");
      if (input.namespace !== expectedNamespace(input.scopeId, input.appId, "project")
        && input.namespace !== expectedNamespace(input.scopeId, input.appId, "standalone")) {
        throw new ProjectAppAdapterError("forbidden");
      }
      const record = await options.resolveApp(input.appId);
      if (!record || record.storageSchema !== input.storageSchema || !isSafeName(record.storageSchema)) {
        throw new ProjectAppAdapterError("forbidden");
      }
      const action = BridgeQueryBodySchema.safeParse(input.action);
      if (!action.success || action.data.action === "listApps" || action.data.app !== input.namespace) {
        throw new ProjectAppAdapterError("invalid_action");
      }
      if (action.data.action === "appInfo") return { id: input.appId };
      if (action.data.action === "schema") return { tables: record.tables };
      if (!record.tables.includes(action.data.table) || !isSafeName(action.data.table)) {
        throw new ProjectAppAdapterError("forbidden");
      }
      const table = sql`${sql.id(record.storageSchema)}.${sql.id(action.data.table)}`;
      const trx = input.transaction;
      switch (action.data.action) {
        case "find": {
          const where = whereClause(action.data.filter);
          const order = orderClause(action.data.orderBy);
          const limit = Math.min(action.data.limit ?? 100, 100);
          const offset = action.data.offset ?? 0;
          const result = await sql<Record<string, unknown>>`SELECT * FROM ${table}${where}${order} LIMIT ${limit} OFFSET ${offset}`.execute(trx);
          return result.rows;
        }
        case "findOne": {
          const result = await sql<Record<string, unknown>>`SELECT * FROM ${table} WHERE id = ${action.data.id} LIMIT 1`.execute(trx);
          return result.rows[0] ?? null;
        }
        case "count": {
          const result = await sql<{ count: number }>`SELECT COUNT(*)::int AS count FROM ${table}${whereClause(action.data.filter)}`.execute(trx);
          return Number(result.rows[0]?.count ?? 0);
        }
        case "insert": {
          const data = columnsAndValues(action.data.data);
          const result = await sql<{ id: string }>`INSERT INTO ${table} (${data.names}) VALUES (${data.values}) RETURNING id`.execute(trx);
          return { id: result.rows[0]?.id };
        }
        case "bulkInsert": {
          const ids: string[] = [];
          for (const row of action.data.rows) {
            const data = columnsAndValues(row);
            const result = await sql<{ id: string }>`INSERT INTO ${table} (${data.names}) VALUES (${data.values}) RETURNING id`.execute(trx);
            if (result.rows[0]) ids.push(result.rows[0].id);
          }
          return { ids };
        }
        case "update": {
          await sql`UPDATE ${table} SET ${assignments(action.data.data)} WHERE id = ${action.data.id}`.execute(trx);
          return { ok: true };
        }
        case "bulkUpdate": {
          for (const item of action.data.updates) {
            await sql`UPDATE ${table} SET ${assignments(item.data)} WHERE id = ${item.id}`.execute(trx);
          }
          return { ok: true };
        }
        case "delete": {
          await sql`DELETE FROM ${table} WHERE id = ${action.data.id}`.execute(trx);
          return { ok: true };
        }
      }
    },
  };
}
