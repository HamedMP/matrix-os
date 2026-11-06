import {randomBytes,randomUUID} from "node:crypto";
import {Pool} from "pg";
import {sql} from "kysely";
import {setTimeout as delay} from "node:timers/promises";
import {createPreviewPairPostgresFixture} from "./preview-pair-postgres-support.js";
/** Separate database and non-superuser role; all names are owned test-only resources. */
export async function createIsolatedPreviewPairDatabase(){
 const base=process.env.MATRIX_TEST_POSTGRES_URL;
 if(!base||!new URL(base).pathname.toLowerCase().includes("test"))throw new Error("Dedicated test Postgres is required");
 const suffix=randomUUID().replaceAll("-",""),database=`eng418_test_${suffix}`,role=`eng418_test_${suffix}`,password=randomBytes(24).toString("hex");
 const admin=new Pool({connectionString:base,max:1,connectionTimeoutMillis:10_000,statement_timeout:10_000});
 let roleCreated=false,databaseCreated=false,fixture:Awaited<ReturnType<typeof createPreviewPairPostgresFixture>>|undefined;
 let destroying:Promise<void>|undefined;
 function destroy(){return destroying??=cleanup();}
 async function cleanup(){
  let failure:unknown;
  try{await fixture?.destroy();}catch(error:unknown){failure=error;}
  try{if(databaseCreated){
   // pg.Pool.end() can settle before the server observes socket termination.
   // Confirm the owned backends drained instead of FORCE-killing closing clients.
   const deadline=Date.now()+5_000;
   for(;;){
    const active=await admin.query<{count:number}>("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = $1",[database]);
    if(active.rows[0].count===0)break;
    if(Date.now()>=deadline)throw new Error("Owned test database connections did not drain");
    await delay(25);
   }
   await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
  }}catch(error:unknown){failure??=error;}
  try{if(roleCreated)await admin.query(`DROP ROLE IF EXISTS "${role}"`);}catch(error:unknown){failure??=error;}
  await admin.end();if(failure)throw failure;
 }
 try{
  // CREATE DATABASE cannot be transactional. Setup compensates every owned resource on failure.
  await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);roleCreated=true;
  await admin.query(`CREATE DATABASE "${database}" OWNER "${role}"`);databaseCreated=true;
  const url=new URL(base);url.username=role;url.password=password;url.pathname=`/${database}`;
  fixture=await createPreviewPairPostgresFixture(url.toString());
  async function simulateAlternateAddress(){
   // Fixture only: mimic a different connection address in this owned database's
   // catalog, without depending on Docker/CI exposing a Unix-domain socket.
   const adminUrl=new URL(base!);adminUrl.pathname=`/${database}`;
   const probe=new Pool({connectionString:adminUrl.toString(),max:1,connectionTimeoutMillis:10_000,statement_timeout:10_000});
   try{await probe.query("CREATE OR REPLACE FUNCTION pg_catalog.inet_server_addr() RETURNS inet LANGUAGE sql AS $$ SELECT '10.99.0.1'::inet $$");}
   finally{await probe.end();}
  }
  const schema=await sql<{schema:string}>`SELECT current_schema() AS schema`.execute(fixture.db.executor);
  url.searchParams.set("options", `-c search_path=${schema.rows[0].schema}`);
  return {db:fixture.db,databaseUrl:url.toString(),destroy,simulateAlternateAddress};
 }catch(error:unknown){await destroy();throw error;}
}
