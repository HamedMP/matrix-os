import pg from "pg";
import { describe,expect,it,vi } from 'vitest';
import { sql } from 'kysely';
import { createTestPlatformDb,destroyTestPlatformDb } from './native-platform-db-test-helper.js';
import { createGoogleDataRepository } from '../../packages/gateway/src/google-data/repository.js';
import { eraseOwnerPlatformData } from '../../packages/platform/src/account-deletion/cleanup-data.js';
import { profileInput,consentInput,now } from '../gateway/google-data/fixtures.js';
describe('confirmed runtime deletion and Google metadata erasure',()=>{
 it('erases owned Google registry and pending delivery metadata only after existing runtime cleanup gates',async()=>{
  const {db}=await createTestPlatformDb();try{
   const repo=createGoogleDataRepository(db.executor,{now:()=>now});await repo.migrate();
   const owned=await repo.reviewProfile(profileInput(),0);await repo.recordConsent(consentInput(owned.id),0);await repo.revokeAccount('owner-one',consentInput(owned.id).googleAccountId);
   const other=await repo.reviewProfile({...profileInput(),ownerId:'other-owner'},0);
   await eraseOwnerPlatformData(db,'owner-one');
   expect((await sql`SELECT id FROM google_data_profiles WHERE owner_id='owner-one'`.execute(db.executor)).rows).toEqual([]);
   expect((await sql`SELECT id FROM google_data_purge_commands WHERE owner_id='owner-one'`.execute(db.executor)).rows).toEqual([]);
   expect((await sql`SELECT id FROM google_data_profiles WHERE id=${other.id}`.execute(db.executor)).rows).toHaveLength(1);
  }finally{await destroyTestPlatformDb(db);}
 });
});

it.runIf(Boolean(process.env.MATRIX_PLATFORM_FIXTURE_POSTGRES_URL))("serializes Google erasure with the real expiry sweep lock", async () => {
 const {db} = await createTestPlatformDb();
 let blocker: pg.Client | undefined;
 try {
  const repo = createGoogleDataRepository(db.executor, {now: () => now}); await repo.migrate();
  const owned = await repo.reviewProfile(profileInput(), 0); await repo.recordConsent(consentInput(owned.id), 0);
  const name = (await sql<{name: string}>`SELECT current_database() AS name`.execute(db.executor)).rows[0]!.name;
  const url = new URL(process.env.MATRIX_PLATFORM_FIXTURE_POSTGRES_URL!); url.pathname = `/${name}`;
  blocker = new pg.Client({connectionString: url.href, connectionTimeoutMillis: 2000, query_timeout: 5000});
  await blocker.connect(); await blocker.query("BEGIN"); await blocker.query("SELECT pg_advisory_xact_lock(5510356)");
  let attempted = false;
  const original = db.transaction.bind(db);
  const spy = vi.spyOn(db, "transaction").mockImplementation(work => original(trx => work({...trx, executor: trx.executor.withPlugin({transformQuery(args) { if (JSON.stringify(args.node).includes("pg_advisory_xact_lock(5510356)")) attempted = true; return args.node; }, async transformResult(args) {return args.result;}})})));
  let finished = false;
  const erasing = eraseOwnerPlatformData(db, "owner-one").finally(() => { finished = true; });
  try {
   await vi.waitFor(() => expect(attempted).toBe(true));
   expect(finished).toBe(false);
   expect((await blocker.query("SELECT id FROM google_data_profiles WHERE owner_id='owner-one'")).rows).toHaveLength(1);
  } finally { await blocker.query("ROLLBACK"); await erasing; spy.mockRestore(); }
  expect((await sql`SELECT id FROM google_data_purge_commands WHERE owner_id='owner-one'`.execute(db.executor)).rows).toEqual([]);
 } finally { await blocker?.end(); await destroyTestPlatformDb(db); }
});
