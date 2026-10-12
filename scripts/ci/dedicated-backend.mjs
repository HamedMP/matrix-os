// Read-only backend handoff; only authenticated cleanup-proved infrastructure selects hosted recovery.
import {resolveMainSource} from './dedicated-main.mjs';
import {waitForDedicatedResult} from './dedicated-result.mjs';
export async function requestingSnapshot(github,context,refresh){
 if(refresh)return refresh;
 if(context.eventName==='push'&&context.ref==='refs/heads/main')return resolveMainSource(github,context.repo,context.sha);
 const pull=context.payload?.pull_request;
 if(!pull)throw new Error('Unsupported dedicated requesting source');
 return {sourceSha:context.sha,headSha:pull.head.sha,headRef:pull.head.ref,baseSha:pull.base.sha,baseRef:pull.base.ref,prNumber:pull.number};
}
export async function decideCiBackend(github,expected,options={}){
 const result=await waitForDedicatedResult(github,expected,{...options,allowInfrastructureFallback:true});
 return result.infrastructure?{provider:'hosted',infrastructureFallback:true,controllerRunId:result.runId}:{provider:'linux',infrastructureFallback:false,controllerRunId:result.runId};
}
