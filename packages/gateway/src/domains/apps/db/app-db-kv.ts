import { type Kysely, sql } from "kysely";

export interface KvStore {
  read(app: string, key: string): Promise<string | null>;
  write(app: string, key: string, value: string): Promise<void>;
  delete(app: string, key: string): Promise<boolean>;
  list(app: string): Promise<string[]>;
}

export function createKvStore(kysely: Kysely<any>): KvStore {
  return {
    async read(app, key) {
      const result = await sql<{ value: string }>`
        SELECT value FROM public._kv WHERE app = ${app} AND key = ${key}
      `.execute(kysely);
      return (result.rows[0] as { value: string } | undefined)?.value ?? null;
    },

    async write(app, key, value) {
      await sql`
        INSERT INTO public._kv (app, key, value, updated_at)
        VALUES (${app}, ${key}, ${value}, now())
        ON CONFLICT (app, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
      `.execute(kysely);
    },

    async delete(app, key) {
      const result = await sql`
        DELETE FROM public._kv WHERE app = ${app} AND key = ${key}
      `.execute(kysely);
      return (result.numAffectedRows ?? 0n) > 0n;
    },

    async list(app) {
      const result = await sql<{ key: string }>`
        SELECT key FROM public._kv WHERE app = ${app} ORDER BY key
      `.execute(kysely);
      return result.rows.map((r: any) => r.key);
    },
  };
}
