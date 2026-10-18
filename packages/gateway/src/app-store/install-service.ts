import {reconcileStoreReceipts} from './install-receipts.js';
import {installedMatches,recoverInstallPublications} from './install-recovery.js';
import {withOwnerFileMutation} from '../owner-file-mutations.js';
import {randomUUID} from 'node:crypto';
import {AppStoreInstallJobSchema,type AppStoreInstallJob,type AppStoreInstallRequest,type AppStoreLocalState} from '@matrix-os/contracts/app-store-gateway';
import type {AppStoreCatalogQuery} from '@matrix-os/contracts/app-store';
import {encodeAppBundle,bundleDigest} from '@matrix-os/contracts/app-store-bundle';
import {withStoreDirectory,atomicPrivateFile,sweepPrivateChildren} from './private-state.js';
import {readStoreProvenance,installedAppPresent} from './provenance.js';import {validateStoreGrant} from './install-validation.js';import {publishCommunityInstall} from './install-publication.js';
import {StoreBuildError,type LocalStoreBuilder} from './local-builder.js';import {StoreError,type AppStorePlatformClient} from './platform-client.js';
import {AppStoreIdSchema} from '@matrix-os/contracts/app-store';
interface PrivateJob {job:AppStoreInstallJob;listingSlug:string;versionId:string;consentDigest:string;updatedAt:number;receiptPending:boolean}
export function createStoreInstallService(options:{homePath:string;platform:AppStorePlatformClient;builder:LocalStoreBuilder}){
 const active=new Map<string,Promise<void>>(); // Cap2 and removed on settlement; durable jobs cap32 + TTL7days.
 const stop=new AbortController();let ready=false;let maintenance:Promise<void>|undefined;
 async function save(record:PrivateJob){await withStoreDirectory(options.homePath,['install-jobs',record.job.id],dir=>atomicPrivateFile(dir,'job.json',Buffer.from(JSON.stringify(record))));}
 async function records():Promise<PrivateJob[]>{return withStoreDirectory(options.homePath,['install-jobs'],async root=>{
  await sweepPrivateChildren(root,/^[0-9a-f-]{36}$/,7*86400_000,64);const rows:PrivateJob[]=[];
  for await(const entry of await root.entries()){
   if(!AppStoreIdSchema.safeParse(entry.name).success||!entry.isDirectory()||entry.isSymbolicLink())continue;
   if(rows.length>=32)throw new StoreError('limit');const dir=await root.child(entry.name);
   try{const raw:unknown=JSON.parse((await dir.readFile('job.json',8192)).toString('utf8'));if(!raw||typeof raw!=='object')throw new StoreError();
    const row=raw as PrivateJob;AppStoreInstallJobSchema.parse(row.job);if(typeof row.listingSlug!=='string'||typeof row.versionId!=='string'||typeof row.receiptPending!=='boolean')throw new StoreError();rows.push(row);
   }finally{await dir.close();}
  }return rows;
 });}
 async function receipt(row:PrivateJob){if(!row.receiptPending)return;return withOwnerFileMutation(options.homePath,async()=>{
   await reconcileStoreReceipts(options.homePath,options.platform,row.listingSlug);row.receiptPending=false;row.updatedAt=Date.now();await save(row);
  });}

 async function run(row:PrivateJob){
  try{
   row.job.status='building';await save(row);
   const status=await options.platform.status();if(!status.enabled)throw new StoreError();
   const grant=await options.platform.download(row.listingSlug,row.versionId);
   // Consent and signature are validated again with the exact downloaded source before build.
   const source=await options.platform.transfer(grant.source.url,'GET');
   const verified=await validateStoreGrant(grant,source,status.signingKeys,row.consentDigest);
   const built=await options.builder.build(verified.files,stop.signal);const dist=built.files;
   const installed=await publishCommunityInstall({homePath:options.homePath,jobId:row.job.id,listingSlug:row.listingSlug,grant,source:verified.files,dist,distSha256:bundleDigest(encodeAppBundle('dist',dist)),toolchain:built.toolchain});
   row.job={id:row.job.id,status:'installed',appSlug:installed.appSlug,launchPath:`apps/${installed.appSlug}`};row.receiptPending=true;row.updatedAt=Date.now();await save(row);
   try{await receipt(row);}catch(error:unknown){console.warn('[app-store] Install receipt will retry',error instanceof Error?error.name:'UnknownError');}
  }catch(error:unknown){
   console.warn('[app-store] Install failed',error instanceof Error?error.name:'UnknownError');
   row.job={id:row.job.id,status:'failed',error:error instanceof StoreBuildError?error.code:error instanceof StoreError&&error.code==='invalid'?'invalid':'unavailable'};row.updatedAt=Date.now();await save(row);
  }
 }
 async function local(record:Awaited<ReturnType<typeof readStoreProvenance>>['installs'][number]|undefined,currentVersion?:string):Promise<AppStoreLocalState>{
  if(!record)return {installed:false,updateAvailable:false};
  const present=await installedAppPresent(options.homePath,record.appSlug);
  return {installed:present,appSlug:record.appSlug,launchPath:`apps/${record.appSlug}`,versionId:record.versionId,version:record.version,updateAvailable:present&&Boolean(currentVersion&&currentVersion!==record.version)};
 }
 async function recover(){
  ready=false;await recoverInstallPublications(options.homePath);ready=true;try{await withOwnerFileMutation(options.homePath,()=>reconcileStoreReceipts(options.homePath,options.platform));}catch(error:unknown){console.warn('[app-store] Uninstall receipt will retry',error instanceof Error?error.name:'UnknownError');}const provenance=await readStoreProvenance(options.homePath);
  for(const row of await records()){
   if(active.has(row.job.id))continue;
   if(['queued','building'].includes(row.job.status)){
    const existing=provenance.installs.find(record=>record.listingSlug===row.listingSlug&&record.versionId===row.versionId);
    const valid=existing&&await installedMatches(options.homePath,existing);
    row.job=valid?{id:row.job.id,status:'installed',appSlug:existing!.appSlug,launchPath:`apps/${existing!.appSlug}`}:{id:row.job.id,status:'failed',error:'unavailable'};row.receiptPending=Boolean(valid);await save(row);
   }
   try{await receipt(row);}catch(error:unknown){console.warn('[app-store] Receipt reconciliation unavailable',error instanceof Error?error.name:'UnknownError');}
  }
 }
 const timer=setInterval(()=>{if(!maintenance&&!stop.signal.aborted){maintenance=recover().catch((error:unknown)=>console.warn('[app-store] Install reconciliation failed',error instanceof Error?error.name:'UnknownError')).finally(()=>{maintenance=undefined;});}},60_000);timer.unref();
 return {
  recover,
  async start(listingSlug:string,input:AppStoreInstallRequest):Promise<AppStoreInstallJob>{return withOwnerFileMutation(options.homePath,async()=>{
   if(stop.signal.aborted||!ready)throw new StoreError();const rows=await records();const duplicate=rows.find(row=>row.listingSlug===listingSlug&&row.versionId===input.versionId&&row.consentDigest===input.consent.capabilitiesDigest&&row.job.status!=='failed');
   if(duplicate){if(duplicate.job.status!=='installed')return duplicate.job;const existing=(await readStoreProvenance(options.homePath)).installs.find(row=>row.listingSlug===listingSlug&&row.versionId===input.versionId);if(existing&&await installedMatches(options.homePath,existing))return duplicate.job;duplicate.job={id:duplicate.job.id,status:'failed',error:'unavailable'};duplicate.receiptPending=false;await save(duplicate);}
   if(rows.some(row=>row.listingSlug===listingSlug&&['queued','building'].includes(row.job.status)))throw new StoreError('conflict');if(active.size>=2||rows.length>=32)throw new StoreError('limit');
   const row:PrivateJob={job:{id:randomUUID(),status:'queued'},listingSlug,versionId:input.versionId,consentDigest:input.consent.capabilitiesDigest,updatedAt:Date.now(),receiptPending:false};await save(row);
   const task=run(row);active.set(row.job.id,task);void task.catch((error:unknown)=>console.warn('[app-store] Install task failed',error instanceof Error?error.name:'UnknownError')).finally(()=>active.delete(row.job.id));return {...row.job,status:'queued'};
  });},
  async job(id:string):Promise<AppStoreInstallJob>{AppStoreIdSchema.parse(id);const row=(await records()).find(row=>row.job.id===id);if(!row)throw new StoreError('not_found');return row.job;},
  async catalog(query:AppStoreCatalogQuery){const page=await options.platform.catalog(query);const provenance=await readStoreProvenance(options.homePath);const listings=[];for(let offset=0;offset<page.listings.length;offset+=4){listings.push(...await Promise.all(page.listings.slice(offset,offset+4).map(async row=>({...row,local:await local(provenance.installs.find(record=>record.listingSlug===row.slug),row.version??undefined)}))));}return {...page,listings};},
  async detail(slug:string){
   const detail=await options.platform.detail(slug);
   const state=await local((await readStoreProvenance(options.homePath)).installs.find(row=>row.listingSlug===slug),detail.currentVersion?.version);
   // Private records are capped/TTL-swept; this read never downloads or rebuilds source.
   const matching=(await records()).filter(row=>row.listingSlug===slug&&row.versionId===detail.currentVersion?.id).sort((a,b)=>b.updatedAt-a.updatedAt);
   const latest=matching.find(row=>row.job.status==='queued'||row.job.status==='building')??matching[0];
   const installJob=latest&&(latest.job.status!=='installed'||state.installed&&state.versionId===latest.versionId)?latest.job:null;
   return {...detail,local:state,installJob};
  },
  async close(){clearInterval(timer);stop.abort();await Promise.allSettled([...active.values(),...(maintenance?[maintenance]:[])]);},
 };
}
export type StoreInstallService=ReturnType<typeof createStoreInstallService>;
