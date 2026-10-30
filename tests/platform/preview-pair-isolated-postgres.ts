import {randomBytes,randomUUID} from "node:crypto";
import {Pool} from "pg";
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
  try{if(databaseCreated)await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);}catch(error:unknown){failure??=error;}
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
  return {db:fixture.db,destroy,simulateAlternateAddress};
 }catch(error:unknown){await destroy();throw error;}
}
