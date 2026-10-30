import {createCustomerVpsContext,type CustomerVpsContext} from "../customer-vps-context.js";
import {createCustomerVpsProvisioningDispatcher} from "../customer-vps-provisioning-dispatch.js";
import type {PlatformDB} from "../db.js";
import type {PreviewPairActivationContext} from "./reconciler.js";
import type {PreviewPairClaim} from "./lifecycle.js";
import {withPreviewPairClaim} from "./lifecycle.js";
import {PreviewPairConflictError} from "./repository.js";
import {PreviewPairCandidateSchema,type PreviewPairCandidate} from "./provenance.js";
/** Internal context resolver reads approved test secrets; it never accepts HTTP overrides. */
export function createPreviewPairProvisioning(options:{db:PlatformDB;controlSecret:string;
 context:(candidate:PreviewPairCandidate)=>Promise<CustomerVpsContext>;
 verifyAuthority:(candidate:PreviewPairCandidate,signal:AbortSignal)=>Promise<boolean>;
 mirror:(input:PreviewPairActivationContext,claim:PreviewPairClaim,signal:AbortSignal)=>Promise<void>;
 now:()=>number}){
 return async(input:PreviewPairActivationContext,claim:PreviewPairClaim,signal:AbortSignal)=>{
  async function canonical(machineId?:string,jobId?:string){
   signal.throwIfAborted();
   return withPreviewPairClaim(options.db,claim,options.now(),async trx=>{
    const pair=await trx.executor.selectFrom("preview_pairs").selectAll().where("pair_id","=",claim.pairId).executeTakeFirstOrThrow();
    const generation=await trx.executor.selectFrom("preview_pair_generations").selectAll().where("pair_id","=",claim.pairId).where("generation","=",claim.generation).executeTakeFirstOrThrow();
    const candidate=PreviewPairCandidateSchema.parse(generation.candidate);
    if(pair.state!=="preparing"||input.pairId!==pair.pair_id||input.generation!==pair.generation||candidate.sourceSha!==pair.source_sha
      ||JSON.stringify(candidate)!==JSON.stringify(PreviewPairCandidateSchema.parse(input.candidate)))throw new PreviewPairConflictError();
    const rows=await trx.executor.selectFrom("preview_pair_members as member").innerJoin("user_machines as machine","machine.machine_id","member.machine_id").innerJoin("provisioning_jobs as job","job.job_id","member.job_id")
      .select(["member.machine_id","member.job_id","member.role","member.actor_id","member.handle","member.retired_at","job.status as job_status","machine.provisioning_class","machine.clerk_user_id","machine.runtime_slot","machine.access_clerk_user_ids","machine.deleted_at","machine.status"])
      .where("member.pair_id","=",pair.pair_id).where("member.generation","=",pair.generation).execute();
    if(rows.length!==2||input.members.length!==2||rows.some(row=>row.retired_at||row.deleted_at||row.provisioning_class!=="preview"
      ||row.clerk_user_id!==row.actor_id||row.runtime_slot!==row.handle||row.access_clerk_user_ids.length
      ||!input.members.some(m=>m.role===row.role&&m.machineId===row.machine_id&&m.jobId===row.job_id&&m.actorId===row.actor_id&&m.handle===row.handle)))throw new PreviewPairConflictError();
    if(machineId&&!rows.some(row=>row.machine_id===machineId&&row.job_id===jobId))throw new PreviewPairConflictError();
    return rows;
   });
  }
  await canonical();
  if(!await options.verifyAuthority(input.candidate,signal))throw new PreviewPairConflictError();
  const context=await options.context(input.candidate),config=context.deps.config;
  if(context.deps.db!==options.db||new URL(config.platformRegisterUrl).origin!==input.candidate.apiOrigin
    ||new URL(config.fundedAiRelayUrl).origin!==input.candidate.apiOrigin||config.platformSecret.length<32
    ||config.platformSecret===options.controlSecret||!config.r2PrefixRoot.includes("preview")||config.goldenSnapshots.enabled)throw new PreviewPairConflictError();
  await canonical();await options.mirror(input,claim,signal);await canonical();
  if(!context.deps.hetzner.withSignal)throw new PreviewPairConflictError();
  const provider=context.deps.hetzner.withSignal(signal);
  const guarded=createCustomerVpsContext({...context.deps,hetzner:{...provider,createServer:async request=>{
   const rows=await canonical();
   if(!rows.some(row=>request.labels?.machine_id===row.machine_id&&request.labels?.clerk_user_id===row.actor_id&&request.labels?.runtime_slot===row.handle))throw new PreviewPairConflictError();
   return provider.createServer(request);
  }}});
  const worker=createCustomerVpsProvisioningDispatcher(guarded,{signal,authorizePair:async(machineId:string,jobId:string)=>{await canonical(machineId,jobId);return true;}});
  const rows=await canonical();
  if(rows.some(row=>row.job_status==="failed"))throw new PreviewPairConflictError();
  const pending=rows.find(row=>row.job_status!=="completed");
  if(pending){await canonical(pending.machine_id,pending.job_id);await worker.dispatchProvisioningJob(pending.job_id,true);}
  await options.mirror(input,claim,signal);
  return (await canonical()).every(row=>row.status==="running");
 };
}
