import pg from 'pg';
import { Kysely, PostgresDialect, type PostgresPoolClient } from 'kysely';
import { SiteSubmissionRepository } from './submission-repository.js';

/** Setup owns this short-lived connection; runtime repositories keep the shared owner DB. */
export async function bootstrapSiteSubmissionDatabase(connectionString: string): Promise<void> {
 const pool = new pg.Pool({
  connectionString, max: 1, connectionTimeoutMillis: 5000,
  lock_timeout: 2000, statement_timeout: 5000, query_timeout: 7500,
 });
 pool.on('error', error => console.warn('[sites] Setup connection failed', error.name));
 const db = new Kysely<any>({ dialect: new PostgresDialect({ pool: {
  async connect() {
   const client = await pool.connect();
   let released = false;
   let failure: unknown;
   // pg's query_timeout rejects the read without cancelling PostgreSQL. Discarding
   // this owned socket ends its transaction and prevents a hanging rollback/read.
   const guarded = {
    async query(statement: string, parameters: readonly unknown[]) {
     if (released) throw failure ?? new Error('Site setup connection unavailable');
     try { return await client.query(statement, [...parameters]); }
     catch (error) { failure = error; released = true; client.release(true); throw error; }
    },
    release() { if (!released) { released = true; client.release(); } },
   };
   // The setup repository only executes ordinary SQL, never streaming cursors.
   return guarded as unknown as PostgresPoolClient;
  },
  async end() { await pool.end(); },
 } }) });
 try { await new SiteSubmissionRepository(db).bootstrap(); }
 finally { await db.destroy(); }
}
