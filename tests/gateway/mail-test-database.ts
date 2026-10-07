import { randomUUID } from "node:crypto";
import { Kysely, PostgresDialect, sql, type Dialect } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import pg from "pg";

/** Production SQL qualification is opt-in with an isolated schema per test. */
export async function mailTestDatabase(): Promise<{ dialect: Dialect; cleanup(): Promise<void> }> {
  const url = process.env.MATRIX_MAIL_TEST_DATABASE_URL;
  if (!url) { const db = await KyselyPGlite.create(); return { dialect: db.dialect, cleanup: async () => {} }; }
  const schema = `mail_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url, max: 1 }) }) });
  await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
  const dialect = new PostgresDialect({ pool: new pg.Pool({ connectionString: url, max: 4, options: `-c search_path=${schema}` }) });
  return { dialect, cleanup: async () => { try { await sql`DROP SCHEMA ${sql.id(schema)} CASCADE`.execute(admin); } finally { await admin.destroy(); } } };
}
