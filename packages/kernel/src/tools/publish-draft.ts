import {AppStoreDraftSummarySchema,OwnerAppSlugSchema} from '@matrix-os/contracts/app-store-gateway';
/** Dependencies and owner authority are captured before this IPC tool is registered. */
export function createPublishDraftToolHandler(options:{env?:NodeJS.ProcessEnv;fetcher?:typeof fetch}={}){
 const env=options.env??process.env;
 if(!env.MATRIX_AUTH_TOKEN||env.MATRIX_AGENT_INTEGRATIONS_TOKEN||env.MATRIX_AGENT_OWNER_ID||env.MATRIX_AGENT_OWNER_PROOF)return undefined;
 const base=new URL(env.GATEWAY_URL??'http://localhost:4000');if(!['http:','https:'].includes(base.protocol)||base.username||base.password)throw new Error('Publishing is unavailable');
 const token=env.MATRIX_AUTH_TOKEN;const fetcher=options.fetcher??fetch;
 return async(input:{app_name:string})=>{
  try{
   const app=OwnerAppSlugSchema.parse(input.app_name);
   const response=await fetcher(new URL('/api/app-store/drafts',base).toString(),{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({app}),redirect:'error',signal:AbortSignal.timeout(15_000)});
   if(!response.ok||!response.body)throw new Error('Publishing is unavailable');
   const reader=response.body.getReader();let text='';let bytes=0;
   try{while(true){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>8192)throw new Error('Publishing is unavailable');text+=new TextDecoder().decode(next.value);}}
   finally{await reader.cancel();reader.releaseLock();}
   const draft=AppStoreDraftSummarySchema.parse(JSON.parse(text));
   return {content:[{type:'text' as const,text:`Draft ${draft.id} is prepared privately. Open Gallery → Publish to review the draft, select AI-provider consent if needed, choose a license, and approve submission. Nothing has been submitted.`}]};
  }catch(error:unknown){console.warn('[publish-app] Draft preparation unavailable',error instanceof Error?error.name:'UnknownError');return {isError:true,content:[{type:'text' as const,text:'Publishing preparation is unavailable. Open Gallery → Publish to check the app and try again.'}]};}
 };
}
