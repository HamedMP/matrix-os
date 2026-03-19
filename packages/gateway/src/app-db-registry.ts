import { sql } from "kysely";
import type { AppDb } from "./app-db.js";

interface TableDef {
  columns: Record<string, string>;
  indexes?: string[];
}

interface RegisterOpts {
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

export function createAppRegistry(db: AppDb): AppRegistry {
  const { kysely } = db;

  return {
    async register(opts: RegisterOpts): Promise<void> {
      await db.createAppSchema(opts.slug);

      for (const [tableName, tableDef] of Object.entries(opts.tables)) {
        await db.createTable(opts.slug, tableName, tableDef.columns, tableDef.indexes);
      }

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
      `.execute(kysely);
    },

    async unregister(slug: string): Promise<void> {
      await db.dropAppSchema(slug);
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
