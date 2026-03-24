import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { parseAppSlug, isSafeName, type AppSlug } from "./app-db-types.js";

export type { AppSlug };

export interface AppDb {
  bootstrap(): Promise<void>;
  createAppSchema(slug: string): Promise<void>;
  dropAppSchema(slug: string): Promise<void>;
  createTable(
    schema: string,
    table: string,
    columns: Record<string, string>,
    indexes?: string[],
  ): Promise<void>;
  raw(query: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  destroy(): Promise<void>;
}

const TYPE_MAP: Record<string, string> = {
  text: "text",
  string: "text",
  boolean: "boolean",
  bool: "boolean",
  integer: "integer",
  int: "integer",
  float: "double precision",
  number: "double precision",
  date: "date",
  timestamptz: "timestamptz",
  timestamp: "timestamptz",
  json: "jsonb",
  jsonb: "jsonb",
  uuid: "uuid",
};

function pgType(t: string): string {
  return TYPE_MAP[t.toLowerCase()] ?? "text";
}

export interface AppDbWithKysely {
  db: AppDb;
  kysely: Kysely<any>;
}

export function createAppDb(opts: string | { dialect: any }): AppDbWithKysely {
  let kysely: Kysely<any>;
  let pool: pg.Pool | null = null;

  if (typeof opts === "string") {
    pool = new pg.Pool({ connectionString: opts, max: 10 });
    pool.on("error", (err) => {
      console.error("[app-db] Idle pool client error:", err.message);
    });
    kysely = new Kysely<any>({ dialect: new PostgresDialect({ pool }) });
  } else {
    kysely = new Kysely<any>({ dialect: opts.dialect });
  }

  const db: AppDb = {
    async bootstrap(): Promise<void> {
      await sql`
        CREATE TABLE IF NOT EXISTS public._apps (
          slug        text PRIMARY KEY,
          name        text NOT NULL,
          description text,
          version     text DEFAULT '1.0.0',
          author      text,
          category    text,
          tables      jsonb NOT NULL DEFAULT '{}',
          created_at  timestamptz DEFAULT now(),
          updated_at  timestamptz DEFAULT now()
        )
      `.execute(kysely);

      await sql`
        CREATE TABLE IF NOT EXISTS public._kv (
          app         text NOT NULL,
          key         text NOT NULL,
          value       text,
          updated_at  timestamptz DEFAULT now(),
          PRIMARY KEY (app, key)
        )
      `.execute(kysely);
    },

    async createAppSchema(slug: string): Promise<void> {
      parseAppSlug(slug);
      await sql.raw(`CREATE SCHEMA IF NOT EXISTS "${slug}"`).execute(kysely);
    },

    async dropAppSchema(slug: string): Promise<void> {
      parseAppSlug(slug);
      await sql.raw(`DROP SCHEMA IF EXISTS "${slug}" CASCADE`).execute(kysely);
    },

    async createTable(
      schema: string,
      table: string,
      columns: Record<string, string>,
      indexes?: string[],
    ): Promise<void> {
      parseAppSlug(schema);
      if (!isSafeName(table)) throw new Error(`Invalid table name: ${table}`);

      const colDefs = Object.entries(columns)
        .map(([name, type]) => {
          if (!isSafeName(name)) throw new Error(`Invalid column name: ${name}`);
          return `"${name}" ${pgType(type)}`;
        })
        .join(", ");

      const fullTable = `"${schema}"."${table}"`;
      await sql
        .raw(
          `CREATE TABLE IF NOT EXISTS ${fullTable} (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            ${colDefs},
            created_at timestamptz DEFAULT now(),
            updated_at timestamptz DEFAULT now()
          )`,
        )
        .execute(kysely);

      if (indexes) {
        for (const col of indexes) {
          if (!isSafeName(col)) continue;
          const idxName = `idx_${schema}_${table}_${col}`.replace(/-/g, "_");
          await sql
            .raw(
              `CREATE INDEX IF NOT EXISTS "${idxName}" ON ${fullTable} ("${col}")`,
            )
            .execute(kysely);
        }
      }
    },

    async raw(
      query: string,
      params?: unknown[],
    ): Promise<{ rows: Record<string, unknown>[] }> {
      if (pool) {
        const result = await pool.query(query, params);
        return { rows: result.rows };
      }
      // For pglite/non-pg-pool: build a parameterized sql tagged template
      if (params && params.length > 0) {
        const parts = query.split(/\$\d+/);
        // Kysely's sql() expects TemplateStringsArray which has a .raw property
        const strings = Object.assign([...parts], { raw: [...parts] }) as unknown as TemplateStringsArray;
        const compiled = sql(strings, ...params);
        const result = await compiled.execute(kysely);
        return { rows: (result.rows ?? []) as Record<string, unknown>[] };
      }
      const result = await sql.raw(query).execute(kysely);
      return { rows: (result.rows ?? []) as Record<string, unknown>[] };
    },

    async destroy(): Promise<void> {
      await kysely.destroy();
    },
  };

  return { db, kysely };
}

export { parseAppSlug } from "./app-db-types.js";
