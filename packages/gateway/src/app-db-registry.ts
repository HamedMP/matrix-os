import { type Kysely, sql } from "kysely";
import type { AppDb } from "./app-db.js";
import { parseAppSlug, type AppSlug, type TableDef } from "./app-db-types.js";

export type { TableDef };

export interface RegisterOpts {
  slug: string;
  name: string;
  description?: string;
  version?: string;
  author?: string;
  category?: string;
  tables: Record<string, TableDef>;
}

export interface AppRecord {
  slug: string;
  name: string;
  description: string | null;
  version: string;
  author: string | null;
  category: string | null;
  tables: Record<string, TableDef>;
  created_at: string;
  updated_at: string;
}

export interface AppRegistry {
  register(opts: RegisterOpts): Promise<void>;
  unregister(slug: string): Promise<void>;
  get(slug: string): Promise<AppRecord | null>;
  listApps(): Promise<AppRecord[]>;
  getSchema(slug: string): Promise<Record<string, TableDef>>;
}

export function createAppRegistry(db: AppDb, kysely: Kysely<any>): AppRegistry {
  return {
    async register(opts: RegisterOpts): Promise<void> {
      const slug: AppSlug = parseAppSlug(opts.slug);

      await kysely.transaction().execute(async (trx) => {
        // Create schema and tables via AppDb (outside trx -- DDL is auto-committed in PG)
        await db.createAppSchema(slug);
        for (const [tableName, tableDef] of Object.entries(opts.tables)) {
          await db.createTable(slug, tableName, tableDef.columns, tableDef.indexes);
        }

        // Upsert registry row inside transaction
        await sql`
          INSERT INTO public._apps (slug, name, description, version, author, category, tables, updated_at)
          VALUES (
            ${opts.slug}, ${opts.name}, ${opts.description ?? null},
            ${opts.version ?? "1.0.0"}, ${opts.author ?? null},
            ${opts.category ?? null}, ${JSON.stringify(opts.tables)}::jsonb,
            now()
          )
          ON CONFLICT (slug) DO UPDATE SET
            name = EXCLUDED.name,
            description = EXCLUDED.description,
            version = EXCLUDED.version,
            tables = EXCLUDED.tables,
            updated_at = now()
        `.execute(trx);
      });
    },

    async unregister(slug: string): Promise<void> {
      const validSlug = parseAppSlug(slug);
      await db.dropAppSchema(validSlug);
      await sql`DELETE FROM public._apps WHERE slug = ${slug}`.execute(kysely);
    },

    async get(slug: string): Promise<AppRecord | null> {
      const result = await sql<AppRecord>`
        SELECT * FROM public._apps WHERE slug = ${slug}
      `.execute(kysely);
      return (result.rows[0] as AppRecord | undefined) ?? null;
    },

    async listApps(): Promise<AppRecord[]> {
      const result = await sql<AppRecord>`
        SELECT * FROM public._apps ORDER BY name
      `.execute(kysely);
      return result.rows as AppRecord[];
    },

    async getSchema(slug: string): Promise<Record<string, TableDef>> {
      const app = await this.get(slug);
      if (!app) throw new Error(`App not found: ${slug}`);
      return app.tables;
    },
  };
}
