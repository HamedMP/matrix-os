import {z} from "zod/v4";
import {PreviewPairActorSchema,PreviewPairIdSchema,PreviewPairPrSchema,PreviewPairGenerationSchema,PreviewPairShaSchema} from "@matrix-os/contracts/preview-pair";
import type {createPreviewPairGitHub} from "./github.js";
import {PreviewPairUpstreamError,readPreviewPairJson} from "./http.js";
const Id=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Request=z.strictObject({runId:Id,pairId:PreviewPairIdSchema,pr:PreviewPairPrSchema,generation:PreviewPairGenerationSchema,
 sourceSha:PreviewPairShaSchema,requesterId:PreviewPairActorSchema});
const Human=z.object({actor:z.object({id:Id}),triggering_actor:z.object({id:Id}),status:z.enum(["in_progress","completed"]),conclusion:z.string().nullable()});
/** A workflow cannot assign a stranger: GitHub OAuth link and current maintainer check stay separate. */
export function createPreviewPairControllerResolver(options:{github:ReturnType<typeof createPreviewPairGitHub>;
 clerkSecret:string;reviewedControllerSha:string;fetchImpl?:typeof fetch}){
 PreviewPairShaSchema.parse(options.reviewedControllerSha);if(!options.clerkSecret)throw new PreviewPairUpstreamError();
 return async (input:{runId:number;pairId:string;pr:number;generation:number;sourceSha:string},signal:AbortSignal)=>{
  try{
   signal.throwIfAborted();
   const run=await options.github.reviewedRun(Id.parse(input.runId),".github/workflows/preview-collaboration-pair.yml");
   const human=Human.parse(run);
   if(run.head_sha!==options.reviewedControllerSha||human.actor.id!==human.triggering_actor.id
     ||(human.status==="completed"&&human.conclusion!=="success"))throw new PreviewPairUpstreamError();
   const page=z.object({total_count:z.number().int().min(1).max(16),artifacts:z.array(z.object({id:Id,name:z.string().max(128),expired:z.boolean(),workflow_run:z.object({id:Id}).optional()})).max(16)})
     .parse(await options.github.api(`/actions/runs/${input.runId}/artifacts?per_page=17`));
   const matches=page.artifacts.filter(item=>item.name==="preview-pair-controller-request"&&!item.expired);
   if(page.total_count!==page.artifacts.length||matches.length!==1||(matches[0]!.workflow_run&&matches[0]!.workflow_run.id!==input.runId))throw new PreviewPairUpstreamError();
   const files=await options.github.smallArtifact(matches[0]!.id),bytes=files["request.json"];
   if(!bytes)throw new PreviewPairUpstreamError();
   const request=Request.parse(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)));
   if(request.runId!==input.runId||request.pairId!==input.pairId||request.pr!==input.pr||request.generation!==input.generation||request.sourceSha!==input.sourceSha)throw new PreviewPairUpstreamError();
   const response=await (options.fetchImpl??fetch)(`https://api.clerk.com/v1/users/${encodeURIComponent(request.requesterId)}`,{
     headers:{Authorization:`Bearer ${options.clerkSecret}`,"Clerk-API-Version":"2025-11-10"},redirect:"error",signal:AbortSignal.any([signal,AbortSignal.timeout(10_000)]),
   });
   const user=z.object({id:PreviewPairActorSchema,external_accounts:z.array(z.object({provider:z.string(),provider_user_id:z.string().max(64),verification:z.object({status:z.string()}).nullable()})).max(32)})
     .parse(await readPreviewPairJson(response,128*1024));
   if(user.id!==request.requesterId||!user.external_accounts.some(account=>account.provider==="oauth_github"
     &&account.provider_user_id===String(human.triggering_actor.id)&&account.verification?.status==="verified"))throw new PreviewPairUpstreamError();
   return {...request,controllerSha:options.reviewedControllerSha};
  }catch(error:unknown){console.warn("[preview-pair] controller proof unavailable",error instanceof Error?error.name:"UnknownError");throw new PreviewPairUpstreamError();}
 };
}
