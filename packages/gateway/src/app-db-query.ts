import type { AppDb } from "./app-db.js";
import { parseSafeName, type FilterOp, type FilterValue } from "./app-db-types.js";

export type { FilterOp, FilterValue };

function qualifiedTable(schema: string, table: string): string {
  return `"${schema}"."${table}"`;
}

export interface FindOptions {
  filter?: Record<string, FilterValue>;
  orderBy?: Record<string, "asc" | "desc">;
  limit?: number;
  offset?: number;
}

export interface QueryEngine {
  find(schema: string, table: string, opts?: FindOptions): Promise<Record<string, unknown>[]>;
  findOne(schema: string, table: string, id: string): Promise<Record<string, unknown> | null>;
  insert(schema: string, table: string, data: Record<string, unknown>): Promise<{ id: string }>;
  update(schema: string, table: string, id: string, data: Record<string, unknown>): Promise<void>;
  delete(schema: string, table: string, id: string): Promise<void>;
  count(schema: string, table: string, filter?: Record<string, FilterValue>): Promise<number>;
}

interface WhereClause {
  sql: string;
  params: unknown[];
}

function buildWhere(filter: Record<string, FilterValue>, startIdx: number): WhereClause {
  const clauses: string[] = [];
  const params: unknown[] = [];
  let idx = startIdx;

  for (const [col, val] of Object.entries(filter)) {
    parseSafeName(col, "column");
    const quotedCol = `"${col}"`;

    if (val === null) {
      clauses.push(`${quotedCol} IS NULL`);
    } else if (typeof val !== "object") {
      clauses.push(`${quotedCol} = $${idx}`);
      params.push(val);
      idx++;
    } else {
      const ops = val as FilterOp;
      if ("$eq" in ops) { clauses.push(`${quotedCol} = $${idx}`); params.push(ops.$eq); idx++; }
      if ("$ne" in ops) { clauses.push(`${quotedCol} != $${idx}`); params.push(ops.$ne); idx++; }
      if ("$lt" in ops) { clauses.push(`${quotedCol} < $${idx}`); params.push(ops.$lt); idx++; }
      if ("$lte" in ops) { clauses.push(`${quotedCol} <= $${idx}`); params.push(ops.$lte); idx++; }
      if ("$gt" in ops) { clauses.push(`${quotedCol} > $${idx}`); params.push(ops.$gt); idx++; }
      if ("$gte" in ops) { clauses.push(`${quotedCol} >= $${idx}`); params.push(ops.$gte); idx++; }
      if ("$in" in ops && Array.isArray(ops.$in)) {
        if (ops.$in.length === 0) {
          clauses.push("FALSE");
        } else {
          const placeholders = ops.$in.map(() => `$${idx++}`).join(", ");
          clauses.push(`${quotedCol} IN (${placeholders})`);
          params.push(...ops.$in);
        }
      }
      if ("$like" in ops) { clauses.push(`${quotedCol} LIKE $${idx}`); params.push(ops.$like); idx++; }
      if ("$ilike" in ops) { clauses.push(`${quotedCol} ILIKE $${idx}`); params.push(ops.$ilike); idx++; }
    }
  }

  return { sql: clauses.join(" AND "), params };
}

export function createQueryEngine(db: AppDb): QueryEngine {
  return {
    async find(schema, table, opts) {
      parseSafeName(schema, "schema");
      parseSafeName(table, "table");
      const qt = qualifiedTable(schema, table);

      let q = `SELECT * FROM ${qt}`;
      let params: unknown[] = [];

      if (opts?.filter && Object.keys(opts.filter).length > 0) {
        const where = buildWhere(opts.filter, 1);
        q += ` WHERE ${where.sql}`;
        params = where.params;
      }

      if (opts?.orderBy) {
        const parts = Object.entries(opts.orderBy).map(([col, dir]) => {
          parseSafeName(col, "column");
          return `"${col}" ${dir === "desc" ? "DESC" : "ASC"}`;
        });
        q += ` ORDER BY ${parts.join(", ")}`;
      }

      if (opts?.limit != null) {
        const n = parseInt(String(opts.limit), 10);
        if (!isNaN(n)) q += ` LIMIT ${Math.max(1, Math.min(n, 10000))}`;
      }
      if (opts?.offset != null) {
        const n = parseInt(String(opts.offset), 10);
        if (!isNaN(n)) q += ` OFFSET ${Math.max(0, n)}`;
      }

      const result = await db.raw(q, params);
      return result.rows;
    },

    async findOne(schema, table, id) {
      parseSafeName(schema, "schema");
      parseSafeName(table, "table");
      const result = await db.raw(
        `SELECT * FROM ${qualifiedTable(schema, table)} WHERE id = $1`,
        [id],
      );
      return (result.rows[0] as Record<string, unknown>) ?? null;
    },

    async insert(schema, table, data) {
      parseSafeName(schema, "schema");
      parseSafeName(table, "table");
      const cols = Object.keys(data).filter((c) => {
        parseSafeName(c, "column");
        return true;
      });
      if (cols.length === 0) throw new Error("insert: data must have at least one column");
      const vals = cols.map((c) => data[c]);
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
      const colNames = cols.map((c) => `"${c}"`).join(", ");

      const result = await db.raw(
        `INSERT INTO ${qualifiedTable(schema, table)} (${colNames}) VALUES (${placeholders}) RETURNING id`,
        vals,
      );
      return { id: (result.rows[0] as any).id };
    },

    async update(schema, table, id, data) {
      parseSafeName(schema, "schema");
      parseSafeName(table, "table");
      const cols = Object.keys(data).filter((c) => {
        parseSafeName(c, "column");
        return true;
      });
      if (cols.length === 0) throw new Error("update: data must have at least one column");
      const sets = cols.map((c, i) => `"${c}" = $${i + 1}`).join(", ");
      const vals = [...cols.map((c) => data[c]), id];

      await db.raw(
        `UPDATE ${qualifiedTable(schema, table)} SET ${sets}, updated_at = now() WHERE id = $${vals.length}`,
        vals,
      );
    },

    async delete(schema, table, id) {
      parseSafeName(schema, "schema");
      parseSafeName(table, "table");
      await db.raw(`DELETE FROM ${qualifiedTable(schema, table)} WHERE id = $1`, [id]);
    },

    async count(schema, table, filter) {
      parseSafeName(schema, "schema");
      parseSafeName(table, "table");
      let q = `SELECT count(*)::int as count FROM ${qualifiedTable(schema, table)}`;
      let params: unknown[] = [];

      if (filter && Object.keys(filter).length > 0) {
        const where = buildWhere(filter, 1);
        q += ` WHERE ${where.sql}`;
        params = where.params;
      }

      const result = await db.raw(q, params);
      return (result.rows[0] as any).count;
    },
  };
}
