import { SITE_PUBLISH_TIMEOUT_MS, SiteAccessLinkCreateResponseSchema, SiteAccessLinksQuerySchema, SiteAccessLinksResponseSchema, SiteRecordSchema, type SiteAccessLinkCreateResponse, type SiteAccessLinksResponse, type SiteRecord } from '@matrix-os/contracts';
import { z } from 'zod/v4';
export class SitePlatformError extends Error{constructor(readonly status:400|404|409|503){super('Publishing request failed');}}
export interface SitePlatformClient {
 request(slug:string,method:string,body?:unknown,child?:string,signal?:AbortSignal,deadlineAt?:number):Promise<SiteRecord|null>;
 accessLinks(slug:string,query?:{limit?:number;cursor?:string}):Promise<SiteAccessLinksResponse>;
 createAccessLink(slug:string,body:{baseRevision:number}):Promise<SiteAccessLinkCreateResponse>;
 revokeAccessLink(slug:string,linkId:string):Promise<void>;
}
export function createSitePlatformClient(options:{url:string;token:string;handle:string;runtimeSlot?:string}):SitePlatformClient{
 const base=new URL(options.url);if(!['https:','http:'].includes(base.protocol)||base.username||base.password)throw new Error('Invalid site platform configuration');
 async function request<T>(slug:string,method:string,body:unknown,child:string,signal:AbortSignal|undefined,deadlineAt:number|undefined,schema:z.ZodType<T>,missingIsNull=false):Promise<T|null>{
  const target=new URL('/internal/containers/'+encodeURIComponent(options.handle)+'/sites/'+encodeURIComponent(slug)+child,base);if(options.runtimeSlot)target.searchParams.set('runtimeSlot',options.runtimeSlot);
  try{
   if(signal?.aborted)throw new SitePlatformError(503);
   let timeoutMs=method==='POST'?30000:10000;
   if(deadlineAt!==undefined){
    const remaining=deadlineAt-Date.now();
    if(method!=='POST'||child!==''||!Number.isSafeInteger(deadlineAt)||remaining<=0||remaining>SITE_PUBLISH_TIMEOUT_MS)throw new SitePlatformError(503);
    timeoutMs=remaining;
   }
   const timeout=AbortSignal.timeout(timeoutMs);
   const response=await fetch(target,{method,headers:{authorization:'Bearer '+options.token,'content-type':'application/json',...(deadlineAt===undefined?{}:{'x-matrix-site-deadline':String(deadlineAt)})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:signal?AbortSignal.any([signal,timeout]):timeout,redirect:'error'});
   if(response.status===404&&method==='GET'&&missingIsNull){await response.body?.cancel();return null;}
   if(!response.ok){await response.body?.cancel();throw new SitePlatformError(response.status===409?409:response.status===400?400:response.status===404?404:503);}
   // Bound streamed upstream response; Content-Length alone is not sufficient.
   const reader=response.body?.getReader();if(!reader)throw new SitePlatformError(503);const chunks:Uint8Array[]=[];let size=0;
   try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>512*1024){await reader.cancel();throw new SitePlatformError(503);}chunks.push(part.value);}}finally{reader.releaseLock();}
   return schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  }catch(error){if(error instanceof SitePlatformError)throw error;console.warn('[sites] Platform request failed',error instanceof Error?error.name:'UnknownError');throw new SitePlatformError(503);}
 }
 return {
  request:(slug,method,body,child='',signal,deadlineAt)=>request(slug,method,body,child,signal,deadlineAt,SiteRecordSchema,true),
  accessLinks:async(slug,query={})=>{const parsed=SiteAccessLinksQuerySchema.parse(query);const params=new URLSearchParams({limit:String(parsed.limit)});if(parsed.cursor)params.set('cursor',parsed.cursor);return request(slug,'GET',undefined,`/access-links?${params}`,undefined,undefined,SiteAccessLinksResponseSchema) as Promise<SiteAccessLinksResponse>;},
  createAccessLink:async(slug,body)=>request(slug,'POST',body,'/access-links',undefined,undefined,SiteAccessLinkCreateResponseSchema) as Promise<SiteAccessLinkCreateResponse>,
  revokeAccessLink:async(slug,linkId)=>{await request(slug,'DELETE',undefined,'/access-links/'+encodeURIComponent(linkId),undefined,undefined,z.object({ok:z.literal(true)}).strict());},
 };
}
