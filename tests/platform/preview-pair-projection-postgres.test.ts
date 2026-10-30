import {sql} from "kysely";
import {afterEach,beforeEach,describe,expect,it} from "vitest";
import {createSeededPreviewPair} from "./preview-pair-seeded-postgres.js";
import {createIsolatedPreviewPairDatabase} from "./preview-pair-isolated-postgres.js";
import {PAIR_NOW} from "./preview-pair-test-support.js";
import {claimPreviewPair,requestPreviewPairStop} from "../../packages/platform/src/preview-pair/lifecycle.js";
import {insertUserMachine} from "../../packages/platform/src/db.js";
import {createCustomerVpsService} from "../../packages/platform/src/customer-vps.js";
import {createTestConfig} from "./customer-vps-service-test-helper.js";
import {createMockCustomerVpsSystemStore} from "./customer-vps-fixtures.js";
import {openProvisioningPayload} from "../../packages/platform/src/customer-vps-provisioning-jobs.js";
import * as projection from "../../packages/platform/src/preview-pair/projection.js";

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("real registration across isolated pair databases",()=>{
 let f:Awaited<ReturnType<typeof createSeededPreviewPair>>,target:Awaited<ReturnType<typeof createIsolatedPreviewPairDatabase>>;
 beforeEach(async()=>{f=await createSeededPreviewPair();try{target=await createIsolatedPreviewPairDatabase();}catch(error:unknown){await f.destroy();throw error;}},30_000);
 afterEach(async()=>{await target?.destroy();await f?.destroy();});
 async function snapshot(){
  const members=await f.db.executor.selectFrom("preview_pair_members").selectAll().orderBy("role").execute();
  for(let i=0;i<members.length;i++)await f.db.executor.updateTable("user_machines").set({hetzner_server_id:1000+i,public_ipv4:`203.0.113.${10+i}`}).where("machine_id","=",members[i].machine_id).execute();
  const claim=await claimPreviewPair(f.db,f.pair.pair_id,1,1,PAIR_NOW);
  const data=await projection.readPreviewPairProjection(f.db,claim,()=>PAIR_NOW);
  return {claim,data,members};
 }
 it("preserves real machine registration and never copies customer machines or jobs",async()=>{
  await insertUserMachine(f.db,{machineId:"unrelated-customer",clerkUserId:"user_customer",handle:"customer",runtimeSlot:"primary",provisioningClass:"customer",status:"running",provisionedAt:new Date(PAIR_NOW).toISOString()});
  const {claim,data,members}=await snapshot();
  await projection.writePreviewPairProjection(target.db,data);
  expect(await target.db.executor.selectFrom("user_machines").selectAll().execute()).toHaveLength(2);
  expect(await target.db.executor.selectFrom("provisioning_jobs").selectAll().execute()).toHaveLength(0);
  const service=createCustomerVpsService({db:target.db,config:createTestConfig({platformSecret:"isolated-preview-"+"p".repeat(40)}),hetzner:f.hetzner,systemStore:createMockCustomerVpsSystemStore(),now:()=>new Date(PAIR_NOW)});
  for(const member of members){
   const job=await f.db.executor.selectFrom("provisioning_jobs").selectAll().where("job_id","=",member.job_id).executeTakeFirstOrThrow();
   const token=openProvisioningPayload(job.encrypted_payload!,"platform-secret").registrationToken;
   const machine=await target.db.executor.selectFrom("user_machines").selectAll().where("machine_id","=",member.machine_id).executeTakeFirstOrThrow();
   await expect(service.register("wrong-registration-token",{machineId:machine.machine_id,hetznerServerId:Number(machine.hetzner_server_id),publicIPv4:machine.public_ipv4!,imageVersion:f.candidate.hostBundleVersion,bundleSha256:f.candidate.hostBundleSha256,healthy:true})).rejects.toMatchObject({status:401});
   await service.register(token,{machineId:machine.machine_id,hetznerServerId:Number(machine.hetzner_server_id),publicIPv4:machine.public_ipv4!,imageVersion:f.candidate.hostBundleVersion,bundleSha256:f.candidate.hostBundleSha256,healthy:true});
  }
  await projection.reconcilePreviewPairProjection(f.db,target.db,claim,()=>PAIR_NOW);
  expect((await f.db.executor.selectFrom("user_machines").select("status").where("provisioning_class","=","preview").execute()).every(row=>row.status==="running")).toBe(true);
 });
 it("rolls back the first projection if the second machine collides with a customer",async()=>{
  const {data,members}=await snapshot();
  await insertUserMachine(target.db,{machineId:members[1].machine_id,clerkUserId:"user_customer",handle:"customer",runtimeSlot:"primary",provisioningClass:"customer",status:"running",provisionedAt:new Date(PAIR_NOW).toISOString()});
  await expect(projection.writePreviewPairProjection(target.db,data)).rejects.toThrow();
  const rows=await target.db.executor.selectFrom("user_machines").selectAll().execute();expect(rows).toHaveLength(1);expect(rows[0].clerk_user_id).toBe("user_customer");
 });
 it("rejects a projected machine whose access list has widened",async()=>{
  const {data,members}=await snapshot();await projection.writePreviewPairProjection(target.db,data);
  await target.db.executor.updateTable("user_machines").set({access_clerk_user_ids:["user_unrelated"]}).where("machine_id","=",members[0].machine_id).execute();
  await expect(projection.writePreviewPairProjection(target.db,data)).rejects.toThrow();
 });
 it("retirement tombstones machines that were never projected and rejects late writes",async()=>{
  const {claim,data,members}=await snapshot();
  const pending=await requestPreviewPairStop(f.db,f.pair.pair_id,1,claim.revision,PAIR_NOW);
  const cleanupClaim=await claimPreviewPair(f.db,pending.pair_id,1,pending.revision,PAIR_NOW);
  for(const member of members)await projection.retirePreviewPairProjection(f.db,target.db,{pairId:f.pair.pair_id,generation:1,machineId:member.machine_id,actorId:member.actor_id,handle:member.handle,jobId:member.job_id,providerServerId:null},cleanupClaim,()=>PAIR_NOW);
  await expect(projection.writePreviewPairProjection(target.db,data)).rejects.toThrow();
  expect((await target.db.executor.selectFrom("user_machines").selectAll().execute()).every(row=>row.status==="deleted"&&row.deleted_at&&row.registration_token_hash===null)).toBe(true);
 });
 it.each(["before stop","wrong job"])("does not retire a projection for %s",async fault=>{
  const {claim,members}=await snapshot();let active=claim;
  if(fault==="wrong job"){
   const pending=await requestPreviewPairStop(f.db,f.pair.pair_id,1,claim.revision,PAIR_NOW);
   active=await claimPreviewPair(f.db,pending.pair_id,1,pending.revision,PAIR_NOW);
  }
  const member=members[0];
  await expect(projection.retirePreviewPairProjection(f.db,target.db,{pairId:f.pair.pair_id,generation:1,machineId:member.machine_id,actorId:member.actor_id,handle:member.handle,jobId:fault==="wrong job"?"22222222-2222-4222-8222-222222222222":member.job_id,providerServerId:null},active,()=>PAIR_NOW)).rejects.toThrow();
  expect(await target.db.executor.selectFrom("user_machines").selectAll().execute()).toHaveLength(0);
 });
 it("refuses an otherwise restricted Preview role that can read the control ledger",async()=>{
  const {claim}=await snapshot();
  const role=(await sql<{name:string}>`SELECT current_user AS name`.execute(target.db.executor)).rows[0].name;
  const schema=(await sql<{name:string}>`SELECT current_schema() AS name`.execute(f.db.executor)).rows[0].name;
  await f.db.transaction(async trx=>{
   await sql`GRANT USAGE ON SCHEMA ${sql.id(schema)} TO ${sql.id(role)}`.execute(trx.executor);
   await sql`GRANT SELECT ON TABLE ${sql.id(schema,"user_machines")} TO ${sql.id(role)}`.execute(trx.executor);
  });
  try{
   await expect(projection.reconcilePreviewPairProjection(f.db,target.db,claim,()=>PAIR_NOW)).rejects.toThrow("unavailable");
   expect(await target.db.executor.selectFrom("user_machines").selectAll().execute()).toHaveLength(0);
  }finally{
   await f.db.transaction(async trx=>{
    await sql`REVOKE SELECT ON TABLE ${sql.id(schema,"user_machines")} FROM ${sql.id(role)}`.execute(trx.executor);
    await sql`REVOKE USAGE ON SCHEMA ${sql.id(schema)} FROM ${sql.id(role)}`.execute(trx.executor);
   });
  }
 });
 it("refuses a same-database target rather than treating another wrapper as isolation",async()=>{
  const {claim}=await snapshot();await expect(projection.reconcilePreviewPairProjection(f.db,f.db,claim,()=>PAIR_NOW)).rejects.toThrow("unavailable");
 });
});
