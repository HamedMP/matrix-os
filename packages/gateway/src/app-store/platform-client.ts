import {MAX_APP_STORE_BRIDGE_REPLY_BYTES} from '@matrix-os/contracts/app-store-bridge-policy';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { z } from 'zod/v4';
import * as C from '@matrix-os/contracts/app-store';
import { isPrivateIp } from '@matrix-os/kernel/security/ssrf-guard';
import { readBoundedResponse } from './dependency-broker.js';
export class StoreError extends Error {constructor(readonly code:z.infer<typeof C.AppStoreErrorCodeSchema> = 'unavailable',readonly httpStatus?:number){super('App Store is unavailable');this.name='StoreError';}}
export async function validateTransferUrl(value:string):Promise<void>{
 const url=new URL(value);
 if(url.protocol!=='https:'||url.username||url.password||url.hash||url.port&&url.port!=='443'||!url.hostname.includes('.'))throw new StoreError();
 const hostname=url.hostname.replace(/^\[|\]$/g,'');
 const addresses=isIP(hostname)?[{address:hostname}]:await Promise.race([lookup(hostname,{all:true}),new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(new StoreError()),5000);timer.unref();})]);
 if(!addresses.length||addresses.some(item=>isPrivateIp(item.address)))throw new StoreError();
 // DNS is checked before fetch; TLS authenticates the configured object-store hostname.
 // A dispatcher is not pinned here: DNS rebinding remains a documented residual risk.
}
export function createAppStorePlatformClient(options:{platformUrl:string;handle:string;token:string;fetcher?:typeof fetch}){
 const base=new URL(options.platformUrl);
 if(!['https:','http:'].includes(base.protocol)||base.username||base.password||base.search||base.hash||!options.token||!(/^[a-z0-9][a-z0-9-]{0,62}$/).test(options.handle))throw new StoreError();
 const endpoint=new URL(`/internal/containers/${options.handle}/app-store/`,base);const fetcher=options.fetcher??fetch;
 async function request<T>(path:string,schema:z.ZodType<T>,init:{method?:string;body?:unknown;query?:Record<string,unknown>}={}):Promise<T>{
  const target=new URL(path,endpoint);if(target.origin!==endpoint.origin||!target.pathname.startsWith(endpoint.pathname))throw new StoreError('invalid');
  for(const[key,value]of Object.entries(init.query??{}))if(value!==undefined)target.searchParams.set(key,String(value));
  try{
   const response=await fetcher(target.toString(),{method:init.method??'GET',headers:{authorization:`Bearer ${options.token}`,...(init.body!==undefined?{'content-type':'application/json'}:{})},...(init.body!==undefined?{body:JSON.stringify(init.body)}:{}),redirect:'error',signal:AbortSignal.timeout(10_000)});
   const payload:unknown=JSON.parse((await readBoundedResponse(response,/^review\/versions\/[0-9a-f-]{36}\/file$/.test(path)?MAX_APP_STORE_BRIDGE_REPLY_BYTES:2*1024*1024)).toString('utf8'));
   if(!response.ok){const error=C.AppStoreErrorSchema.safeParse(payload);throw new StoreError(error.success?error.data.error:'unavailable',response.status);}
   const parsed=schema.safeParse(payload);if(!parsed.success)throw new StoreError();return parsed.data;
  }catch(error:unknown){if(error instanceof StoreError)throw error;console.warn('[app-store] Platform request failed',error instanceof Error?error.name:'UnknownError');throw new StoreError();}
 }
 const slug=(value:string)=>C.AppStoreSlugSchema.parse(value);const id=(value:string)=>C.AppStoreIdSchema.parse(value);
 return {
  request,
  status:()=>request('status',C.AppStoreStatusSchema),
  catalog:(query:C.AppStoreCatalogQuery)=>request('listings',C.AppStoreCatalogPageSchema,{query:C.AppStoreCatalogQuerySchema.parse(query)}),
  detail:(value:string)=>request(`listings/${slug(value)}`,C.AppStoreListingDetailSchema),
  download:(value:string,versionId:string)=>request(`listings/${slug(value)}/download`,C.AppStoreDownloadGrantSchema,{method:'POST',body:{versionId:id(versionId)}}),
  recordInstall:(value:string,versionId:string)=>request(`listings/${slug(value)}/install`,C.AppStoreInstallStateSchema,{method:'PUT',body:{versionId:id(versionId)}}),
  async removeInstall(value:string):Promise<void>{await request(`listings/${slug(value)}/install`,C.AppStoreInstallStateSchema,{method:'DELETE'});},
  rate:(value:string,stars:number|null)=>request(`listings/${slug(value)}/rating`,C.AppStoreRatingStateSchema,{method:stars===null?'DELETE':'PUT',...(stars===null?{}:{body:C.AppStoreRatingInputSchema.parse({stars})})}),
  createSubmission:(input:C.AppStoreCreateSubmission)=>request('submissions',C.AppStoreCreateSubmissionResultSchema,{method:'POST',body:C.AppStoreCreateSubmissionSchema.parse(input)}),
  finalize:(value:string)=>request(`submissions/${id(value)}/finalize`,C.AppStoreSubmissionSummarySchema,{method:'POST',body:{}}),
  submissions:(cursor?:string)=>request('submissions',C.AppStoreSubmissionsPageSchema,{query:{cursor:C.AppStoreCatalogQuerySchema.shape.cursor.parse(cursor)}}),
  async submission(value:string):Promise<C.AppStoreSubmissionSummary|null>{
   const versionId=id(value);
   try{const result=await request(`submissions/${versionId}`,C.AppStoreSubmissionSummarySchema);if(result.versionId!==versionId)throw new StoreError();return result;}
   catch(error:unknown){if(error instanceof StoreError&&error.code==='not_found'&&error.httpStatus===404)return null;throw error;}
  },
  withdraw:(value:string)=>request(`submissions/${id(value)}/withdraw`,C.AppStoreSubmissionSummarySchema,{method:'POST',body:{}}),
  reviewQueue:(query:Record<string,unknown>)=>request('review/queue',C.AppStoreReviewQueuePageSchema,{query:C.AppStoreReviewQueueQuerySchema.parse(query)}),
  reviewDetail:(value:string)=>request(`review/versions/${id(value)}`,C.AppStoreReviewDetailSchema),
  reviewFile:(value:string,query:Record<string,unknown>)=>request(`review/versions/${id(value)}/file`,C.AppStoreReviewFileSchema,{query:C.AppStoreReviewFileQuerySchema.parse(query)}),
  reviewDecision:(value:string,body:C.AppStoreReviewDecision)=>request(`review/versions/${id(value)}/decision`,C.AppStoreReviewQueueItemSchema,{method:'POST',body:C.AppStoreReviewDecisionSchema.parse(body)}),
  listingAction:(value:string,body:z.infer<typeof C.AppStoreListingActionSchema>)=>request(`review/listings/${id(value)}/action`,C.AppStoreListingSummarySchema,{method:'POST',body:C.AppStoreListingActionSchema.parse(body)}),
  async transfer(url:string,method:'GET'|'PUT',bytes?:Buffer):Promise<Buffer>{
   await validateTransferUrl(url);
   const response=await fetcher(url,{method,redirect:'error',signal:AbortSignal.timeout(60_000),...(bytes?{body:new Uint8Array(bytes),headers:{'content-type':'application/octet-stream'}}:{})});
   if(!response.ok)throw new StoreError();
   return method==='GET'?readBoundedResponse(response,C.APP_STORE_MAX_SOURCE_BUNDLE_BYTES):Buffer.alloc(0);
  },
  async icon(value:string):Promise<{bytes:Buffer;type:string}>{
   const response=await fetcher(new URL(`listings/${slug(value)}/icon`,endpoint).toString(),{headers:{authorization:`Bearer ${options.token}`},redirect:'error',signal:AbortSignal.timeout(10_000)});
   const type=response.headers.get('content-type')?.split(';')[0]??'';
   if(!response.ok||!['image/png','image/svg+xml'].includes(type))throw new StoreError();return {bytes:await readBoundedResponse(response,256*1024),type};
  },
 };
}
export type AppStorePlatformClient=ReturnType<typeof createAppStorePlatformClient>;
