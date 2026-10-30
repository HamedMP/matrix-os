import {sql,type Selectable} from "kysely";
import {previewPairHandle} from "@matrix-os/contracts/preview-pair";
import type {PlatformDB,HostBundleReleaseRecord,UserMachinesTable} from "../db.js";
import {getHostBundleRelease,upsertHostBundleRelease} from "../db.js";
import {toUserMachineRow} from "../database/user-machine-records.js";
import {withPreviewPairClaim,type PreviewPairClaim} from "./lifecycle.js";
import {PreviewPairCandidateSchema} from "./provenance.js";
import {PreviewPairConflictError} from "./repository.js";
import type {PreviewPairCleanupMember} from "./cleanup.js";

interface ProjectedMember {role:"owner"|"member";machine:Selectable<UserMachinesTable>}
export interface PreviewPairProjection {pairId:string;generation:number;pr:number;sourceSha:string;release:HostBundleReleaseRecord;members:ProjectedMember[]}
async function identity(db:PlatformDB){
 const result=await sql<{database:string;role:string;server:string|null;port:number|null;unsafe:boolean}>`SELECT pg_catalog.current_database() AS database,current_user AS role,
 pg_catalog.inet_server_addr()::pg_catalog.text AS server,pg_catalog.inet_server_port() AS port,EXISTS(SELECT 1 FROM pg_catalog.pg_roles r
 WHERE pg_catalog.pg_has_role(current_user,r.oid,'MEMBER') AND (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
 OR r.rolname IN ('pg_read_all_data','pg_write_all_data','pg_read_server_files','pg_write_server_files','pg_execute_server_program','pg_signal_backend','pg_monitor','pg_read_all_stats','pg_read_all_settings'))) AS unsafe`.execute(db.executor);
 if(!result.rows[0])throw new PreviewPairConflictError();return result.rows[0];
}
export async function assertPreviewPairDataIsolation(source:PlatformDB,target:PlatformDB){
 const [left,right]=await Promise.all([identity(source),identity(target)]);
 if(right.unsafe||(left.database===right.database&&left.server===right.server&&left.port===right.port))throw new PreviewPairConflictError();
 if(left.server===right.server&&left.port===right.port){
  // Also inspect SET ROLE membership: a NOINHERIT grant can still cross the boundary.
  const grants=await sql<{unsafe:boolean}>`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_roles preview
   JOIN pg_catalog.pg_roles reachable ON pg_catalog.pg_has_role(preview.oid,reachable.oid,'MEMBER')
   CROSS JOIN pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   WHERE preview.rolname=${right.role} AND c.relkind IN ('r','p','v','m','f')
   AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
   AND pg_catalog.has_table_privilege(reachable.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) AS unsafe`.execute(source.executor);
  if(!grants.rows[0]||grants.rows[0].unsafe)throw new PreviewPairConflictError();
 }
}
/** Only leased machine/release metadata and bootstrap hashes; no customer data, plaintext credentials or jobs. */
export async function readPreviewPairProjection(db:PlatformDB,claim:PreviewPairClaim,now:()=>number):Promise<PreviewPairProjection>{
 return withPreviewPairClaim(db,claim,now(),async trx=>{
  const pair=await trx.executor.selectFrom("preview_pairs").selectAll().where("pair_id","=",claim.pairId).executeTakeFirstOrThrow();
  if(!["preparing","ready"].includes(pair.state)||!pair.fixture_id)throw new PreviewPairConflictError();
  const generation=await trx.executor.selectFrom("preview_pair_generations").select("candidate").where("pair_id","=",pair.pair_id).where("generation","=",claim.generation).executeTakeFirstOrThrow();
  const candidate=PreviewPairCandidateSchema.parse(generation.candidate),release=await getHostBundleRelease(trx,candidate.hostBundleVersion);
  if(!release||release.gitCommit!==pair.source_sha||release.sha256!==candidate.hostBundleSha256||release.channel!==null||release.sourcePr!==pair.pr)throw new PreviewPairConflictError();
  const bindings=await trx.executor.selectFrom("preview_pair_members").selectAll().where("pair_id","=",claim.pairId).where("generation","=",claim.generation).orderBy("role").execute();
  if(bindings.length!==2)throw new PreviewPairConflictError();
  const members:ProjectedMember[]=[];
  for(const binding of bindings){
   const machine=await trx.executor.selectFrom("user_machines").selectAll().where("machine_id","=",binding.machine_id).executeTakeFirstOrThrow();
   if(binding.retired_at||machine.deleted_at||machine.provisioning_class!=="preview"||machine.runtime_slot!==binding.handle||machine.handle!==binding.handle
     ||machine.clerk_user_id!==binding.actor_id||machine.access_clerk_user_ids.length||machine.image_version!==release.version)throw new PreviewPairConflictError();
   members.push({role:binding.role,machine});
  }
  return {pairId:pair.pair_id,generation:pair.generation,pr:pair.pr,sourceSha:pair.source_sha,release,members};
 });
}
function row(member:ProjectedMember,snapshot:PreviewPairProjection){
 const source=member.machine,handle=previewPairHandle(snapshot.pr,snapshot.pairId,snapshot.generation,member.role);
 if(source.handle!==handle||source.runtime_slot!==handle||source.provisioning_class!=="preview"||source.access_clerk_user_ids.length)throw new PreviewPairConflictError();
 return toUserMachineRow({machineId:source.machine_id,clerkUserId:source.clerk_user_id,handle,runtimeSlot:handle,runtimeTokenEpoch:source.runtime_token_epoch,
  provisioningClass:"preview",accessClerkUserIds:[],developerTools:[],confirmedBundleVersion:snapshot.release.version,
  status:"provisioning",imageVersion:snapshot.release.version,
  hetznerServerId:source.hetzner_server_id===null?null:Number(source.hetzner_server_id),publicIPv4:source.public_ipv4,publicIPv6:source.public_ipv6,
  targetBundleVersion:snapshot.release.version,targetBundleSha256:snapshot.release.sha256,
  registrationTokenHash:source.registration_token_hash,registrationTokenExpiresAt:source.registration_token_expires_at,provisionedAt:source.provisioned_at});
}
type ObservedColumn="public_ipv4"|"public_ipv6"|"hetzner_server_id"|"image_version"|"confirmed_bundle_version"|"target_bundle_version"|"target_bundle_sha256";
/** Evaluate against the locked upsert row: registration can win after any pre-read. */
function preserveRegisteredField<T>(column:ObservedColumn,value:T){
 return sql<T>`CASE WHEN user_machines.status = 'running' THEN ${sql.ref(`user_machines.${column}`)} ELSE ${value} END`;
}
/** SQL consumer: a retired machine cannot be resurrected by an earlier canonical snapshot. */
export async function writePreviewPairProjection(target:PlatformDB,snapshot:PreviewPairProjection){
 if(snapshot.members.length!==2||new Set(snapshot.members.map(member=>member.role)).size!==2
  ||new Set(snapshot.members.map(member=>member.machine.machine_id)).size!==2||snapshot.release.gitCommit!==snapshot.sourceSha)throw new PreviewPairConflictError();
 await target.transaction(async trx=>{
  await upsertHostBundleRelease(trx,{...snapshot.release,channel:null});
  for(const member of snapshot.members){
   const value=row(member,snapshot);
   await trx.executor.insertInto("user_machines").values(value).onConflict(oc=>oc.column("machine_id").doUpdateSet({
    public_ipv4:preserveRegisteredField("public_ipv4",value.public_ipv4??null),public_ipv6:preserveRegisteredField("public_ipv6",value.public_ipv6??null),hetzner_server_id:preserveRegisteredField("hetzner_server_id",value.hetzner_server_id??null),
    image_version:preserveRegisteredField("image_version",value.image_version??null),confirmed_bundle_version:preserveRegisteredField("confirmed_bundle_version",value.confirmed_bundle_version??null),
    target_bundle_version:preserveRegisteredField("target_bundle_version",value.target_bundle_version??null),target_bundle_sha256:preserveRegisteredField("target_bundle_sha256",value.target_bundle_sha256??null),
    registration_token_hash:sql`CASE WHEN user_machines.status = 'running' THEN NULL ELSE ${value.registration_token_hash} END`,
    registration_token_expires_at:sql`CASE WHEN user_machines.status = 'running' THEN NULL ELSE ${value.registration_token_expires_at} END`,
   }).where("user_machines.clerk_user_id","=",value.clerk_user_id).where("user_machines.handle","=",value.handle)
    .where("user_machines.runtime_slot","=",value.runtime_slot).where("user_machines.provisioning_class","=","preview")
    .where("user_machines.runtime_token_epoch","=",member.machine.runtime_token_epoch).where("user_machines.deleted_at","is",null)
    .where(sql<boolean>`pg_catalog.cardinality(user_machines.access_clerk_user_ids) = 0`))
    .returning("machine_id").executeTakeFirstOrThrow();
  }
 });
}
export async function reconcilePreviewPairProjection(source:PlatformDB,target:PlatformDB,claim:PreviewPairClaim,now:()=>number){
 await assertPreviewPairDataIsolation(source,target);
 const snapshot=await readPreviewPairProjection(source,claim,now);await writePreviewPairProjection(target,snapshot);
 const observed=await target.executor.selectFrom("user_machines").selectAll().where("machine_id","in",snapshot.members.map(member=>member.machine.machine_id)).execute();
 await withPreviewPairClaim(source,claim,now(),async trx=>{
  for(const member of snapshot.members){
   const original=member.machine,remote=observed.find(machine=>machine.machine_id===original.machine_id);
   if(!remote||remote.deleted_at||remote.status!=="running")continue;
   if(remote.clerk_user_id!==original.clerk_user_id||remote.handle!==original.handle||remote.runtime_slot!==original.runtime_slot
    ||remote.provisioning_class!=="preview"||remote.access_clerk_user_ids.length||remote.runtime_token_epoch!==original.runtime_token_epoch
    ||Number(remote.hetzner_server_id)!==Number(original.hetzner_server_id)||remote.public_ipv4!==original.public_ipv4
    ||remote.image_version!==snapshot.release.version||remote.confirmed_bundle_version!==snapshot.release.version
    ||remote.target_bundle_version!==snapshot.release.version||remote.target_bundle_sha256!==snapshot.release.sha256||remote.registration_token_hash!==null)throw new PreviewPairConflictError();
   await trx.executor.updateTable("user_machines").set({status:"running",registration_token_hash:null,registration_token_expires_at:null,last_seen_at:remote.last_seen_at})
    .where("machine_id","=",original.machine_id).where("clerk_user_id","=",original.clerk_user_id).where("runtime_slot","=",original.runtime_slot)
    .where("provisioning_class","=","preview").where("runtime_token_epoch","=",original.runtime_token_epoch).where("deleted_at","is",null).execute();
  }
 });
}
export async function retirePreviewPairProjection(source:PlatformDB,target:PlatformDB,member:PreviewPairCleanupMember,claim:PreviewPairClaim,now:()=>number){
 await assertPreviewPairDataIsolation(source,target);
 const canonical=await withPreviewPairClaim(source,claim,now(),async trx=>{
  if(member.generation>claim.generation)throw new PreviewPairConflictError();
  const pair=await trx.executor.selectFrom("preview_pairs").select("state").where("pair_id","=",claim.pairId).executeTakeFirstOrThrow();
  if(pair.state!=="cleanup_pending"&&pair.state!=="updating")throw new PreviewPairConflictError();
  const binding=await trx.executor.selectFrom("preview_pair_members as member").innerJoin("user_machines as machine","machine.machine_id","member.machine_id")
   .selectAll("machine").select(["member.role"]).where("member.pair_id","=",claim.pairId).where("member.generation","=",member.generation)
   .where("member.machine_id","=",member.machineId).where("member.job_id","=",member.jobId).where("member.actor_id","=",member.actorId).where("member.handle","=",member.handle).executeTakeFirstOrThrow();
  if(member.pairId!==claim.pairId||binding.clerk_user_id!==member.actorId||binding.handle!==member.handle||binding.runtime_slot!==member.handle||binding.provisioning_class!=="preview")throw new PreviewPairConflictError();
  return binding;
 });
 const value=toUserMachineRow({machineId:member.machineId,clerkUserId:member.actorId,handle:member.handle,runtimeSlot:member.handle,
  provisioningClass:"preview",accessClerkUserIds:[],developerTools:[],status:"deleted",deletedAt:new Date(now()).toISOString(),provisionedAt:canonical.provisioned_at,
  runtimeTokenEpoch:canonical.runtime_token_epoch+1});
 await target.transaction(async trx=>{
  await trx.executor.insertInto("user_machines").values(value).onConflict(oc=>oc.column("machine_id").doUpdateSet({status:"deleted",deleted_at:sql`COALESCE(user_machines.deleted_at, ${value.deleted_at})`,
   registration_token_hash:null,registration_token_expires_at:null,runtime_token_epoch:sql`GREATEST(user_machines.runtime_token_epoch, ${canonical.runtime_token_epoch+1})`})
   .where("user_machines.clerk_user_id","=",member.actorId).where("user_machines.handle","=",member.handle)
   .where("user_machines.runtime_slot","=",member.handle).where("user_machines.provisioning_class","=","preview"))
   .returning("machine_id").executeTakeFirstOrThrow();
 });
}
