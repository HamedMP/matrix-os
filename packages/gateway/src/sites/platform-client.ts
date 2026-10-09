import { SiteRecordSchema, type SiteRecord } from '@matrix-os/contracts';
export class SitePlatformError extends Error{constructor(readonly status:400|404|409|503){super('Publishing request failed');}}
export interface SitePlatformClient {request(slug:string,method:string,body?:unknown,child?:string):Promise<SiteRecord|null>}
export function createSitePlatformClient(options:{url:string;token:string;handle:string;runtimeSlot?:string}):SitePlatformClient{
 const base=new URL(options.url);if(!['https:','http:'].includes(base.protocol)||base.username||base.password)throw new Error('Invalid site platform configuration');
 return {async request(slug,method,body,child=''){
  const target=new URL('/internal/containers/'+encodeURIComponent(options.handle)+'/sites/'+encodeURIComponent(slug)+child,base);if(options.runtimeSlot)target.searchParams.set('runtimeSlot',options.runtimeSlot);
  try{
   const response=await fetch(target,{method,headers:{authorization:'Bearer '+options.token,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(method==='POST'?30000:10000),redirect:'error'});
   if(response.status===404&&method==='GET'){await response.body?.cancel();return null;}
   if(!response.ok){await response.body?.cancel();throw new SitePlatformError(response.status===409?409:response.status===400?400:response.status===404?404:503);}
   // Bound streamed upstream response; Content-Length alone is not sufficient.
   const reader=response.body?.getReader();if(!reader)throw new SitePlatformError(503);const chunks:Uint8Array[]=[];let size=0;
   try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>512*1024){await reader.cancel();throw new SitePlatformError(503);}chunks.push(part.value);}}finally{reader.releaseLock();}
   return SiteRecordSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  }catch(error){if(error instanceof SitePlatformError)throw error;console.warn('[sites] Platform request failed',error instanceof Error?error.name:'UnknownError');throw new SitePlatformError(503);}
 }};
}
