import {strToU8} from "fflate";
import {describe,expect,it,vi} from "vitest";
import * as controller from "../../packages/platform/src/preview-pair/controller.js";
const sha="c".repeat(40),sourceSha="a".repeat(40),pairId="11111111-1111-4111-8111-111111111111";
function setup(fault?:string){
 const request={runId:42,pairId,pr:3022,generation:1,sourceSha,requesterId:"user_requester"};
 const run={id:42,status:"in_progress",conclusion:null,head_sha:sha,path:".github/workflows/preview-collaboration-pair.yml",actor:{id:123},triggering_actor:{id:123}};
 const github={reviewedRun:vi.fn(async()=>run),api:vi.fn(async()=>({total_count:1,artifacts:[{id:100,name:"preview-pair-controller-request",expired:false,workflow_run:{id:42}}]})),smallArtifact:vi.fn(async()=>({"request.json":strToU8(JSON.stringify(fault==="receipt"?{...request,pairId:"22222222-2222-4222-8222-222222222222"}:request))}))};
 const fetchImpl=vi.fn(async()=>Response.json({id:"user_requester",external_accounts:[{provider:"oauth_github",provider_user_id:fault==="actor"?"999":"123",verification:{status:fault==="unverified"?"unverified":"verified"}}]}));
 if(fault==="failed")Object.assign(run,{status:"completed",conclusion:"failure"});
 if(fault==="rerun")run.triggering_actor.id=999;
 return {request,github,fetchImpl,resolve:(controller as any).createPreviewPairControllerResolver({github,clerkSecret:"control-clerk-secret",reviewedControllerSha:sha,fetchImpl})};
}
describe("reviewed request receipt resolves its real human requester",()=>{
 it("uses GitHub verified trigger identity linked to the Clerk requester",async()=>{
  const {request,resolve}=setup();expect(await resolve(request,new AbortController().signal)).toEqual({...request,controllerSha:sha});
 });
 it.each(["receipt","actor","unverified","failed","rerun"])("refuses %s proof before admission",async fault=>{
  const {request,resolve}=setup(fault);await expect(resolve(request,new AbortController().signal)).rejects.toThrow("unavailable");
 });
});
