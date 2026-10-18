import {z} from 'zod/v4';
import {AppStoreManifestSchema,AppStoreCreateSubmissionSchema} from '@matrix-os/contracts/app-store';
import {AppStoreDraftSummarySchema,AppStoreListingDraftPatchSchema,type AppStoreDraftDetail,AppStoreSubmitDraftSchema,type AppStoreDraftDiff} from '@matrix-os/contracts/app-store-gateway';
import {encodeAppBundle,bundleDigest} from '@matrix-os/contracts/app-store-bundle';
import {redactSecrets} from '@matrix-os/contracts/app-store-scan';
import {listApps} from '../apps.js';
import {withOwnerFileMutation} from '../owner-file-mutations.js';
import {snapshotOwnerApp} from './snapshot.js';import {createDraftStore} from './draft-store.js';
import {createStoreGeneralizer,type StoreGeneralizer} from './generalizer.js';import {preparePublishDraft} from './prepare-draft.js';
import {StoreError,type AppStorePlatformClient} from './platform-client.js';import type {LocalStoreBuilder} from './local-builder.js';
export function createStorePublishService(options:{homePath:string;platform:AppStorePlatformClient;builder:LocalStoreBuilder;generalizer?:StoreGeneralizer;ownerTerms?:readonly string[]}){
 const store=createDraftStore(options.homePath);const generalizer=options.generalizer??createStoreGeneralizer(options.homePath);
 const jobs=new Map<string,Promise<void>>(); // Cap2, removed on settlement; drafts separately cap16/TTL7days.
 const stop=new AbortController();
 async function run(draft:AppStoreDraftDetail,aiConsent?:{accessSourceId:string},instructions?:string){
  try{
   const original=await store.files(draft.id,'original');
   const files=instructions?await store.files(draft.id,'prepared'):original;
   const result=await preparePublishDraft({files,ownerTerms:options.ownerTerms??[],aiConsent,instructions,generalizer,builder:options.builder,signal:stop.signal});
   await store.writeFiles(draft.id,'prepared',result.files);
   const changedFiles:AppStoreDraftDetail['changedFiles']=[];
   for(const path of new Set([...original.keys(),...result.files.keys()])){const before=original.get(path),after=result.files.get(path);if(before&&after&&before.equals(after))continue;changedFiles.push({path,change:before?after?'modified':'removed':'added'});}
   const {files:preparedFiles,...detail}=result;void preparedFiles;
   await store.write({...draft,...detail,changedFiles,stage:'verify',updatedAt:new Date().toISOString()});
  }catch(error:unknown){console.warn('[app-store] Draft preparation failed',error instanceof Error?error.name:'UnknownError');await store.write({...draft,status:'needs_attention',failureCode:'snapshot_failed',updatedAt:new Date().toISOString()});}
 }
 function start(draft:AppStoreDraftDetail,consent?:{accessSourceId:string},instructions?:string){
  if(stop.signal.aborted||jobs.size>=2)throw new StoreError('limit');
  const task=run(draft,consent,instructions);jobs.set(draft.id,task);
  void task.catch((error:unknown)=>console.warn('[app-store] Draft job failed',error instanceof Error?error.name:'UnknownError')).finally(()=>jobs.delete(draft.id));
 }
 return {
  generalizerStatus:generalizer.status,
  async recover(){for(const draft of await store.list())if(['preparing','submitting'].includes(draft.status))await store.write({...draft,status:'needs_attention',failureCode:'interrupted',updatedAt:new Date().toISOString()});},
  async publishableApps(){return (await listApps(options.homePath)).map(app=>({slug:app.slug??app.name,name:app.name,description:app.description,eligible:app.runtime==='vite',...(app.runtime==='vite'?{}:{reason:'unsupported_runtime' as const})}));},
  async list(){return (await store.list()).map(d=>AppStoreDraftSummarySchema.strip().parse(d));},
  detail:store.read,
  async create(input:{app:string;aiConsent?:{accessSourceId:string}}){
   return withOwnerFileMutation(options.homePath,async()=>{
    if(jobs.size>=2||(await store.list()).length>=16)throw new StoreError('limit');
    const files=await snapshotOwnerApp(options.homePath,input.app);const manifest=JSON.parse(files.get('matrix.json')?.toString('utf8')??'null');
    if(!manifest||manifest.runtime!=='vite'||manifest.listingTrust==='community')throw new StoreError('invalid');
    const now=new Date().toISOString();const draft:AppStoreDraftDetail={id:store.id(),sourceSlug:input.app,sourceName:String(manifest.name??input.app).slice(0,120),status:'preparing',stage:'snapshot',ai:null,blockingFindings:0,createdAt:now,updatedAt:now,expiresAt:new Date(Date.now()+7*86400_000).toISOString(),findingsBefore:null,findingsAfter:null,report:null,listing:null,capabilities:null,changedFiles:[]};
    await store.writeFiles(draft.id,'original',files);await store.writeFiles(draft.id,'prepared',files);await store.write(draft);start(draft,input.aiConsent);return AppStoreDraftSummarySchema.strip().parse(draft);
   });
  },
  async revise(id:string,input:{instructions:string;aiConsent?:{accessSourceId:string}}){
   if(jobs.has(id))throw new StoreError('conflict');const current=await store.read(id);if(current.status==='submitted')throw new StoreError('conflict');
   const draft={...current,status:'preparing' as const,stage:'generalize' as const,updatedAt:new Date().toISOString()};await store.write(draft);start(draft,input.aiConsent,input.instructions);return AppStoreDraftSummarySchema.strip().parse(draft);
  },
  async listing(id:string,patch:unknown){if(jobs.has(id))throw new StoreError('conflict');const draft=await store.read(id);if(draft.status==='submitted'||!draft.listing)throw new StoreError('conflict');const result={...draft,listing:{...draft.listing,...AppStoreListingDraftPatchSchema.parse(patch)},updatedAt:new Date().toISOString()};await store.write(result);return result;},
  async diff(id:string,path:string):Promise<AppStoreDraftDiff>{
   const [beforeFiles,afterFiles]=await Promise.all([store.files(id,'original'),store.files(id,'prepared')]);const before=beforeFiles.get(path),after=afterFiles.get(path);if(!before&&!after)throw new StoreError('not_found');
   const binary=Boolean(before?.includes(0)||after?.includes(0));const limit=256*1024;
   return {path,change:before?after?before.equals(after)?'unchanged':'modified':'removed':'added',binary,truncated:Boolean((before?.length??0)>limit||(after?.length??0)>limit),...(!binary&&before?{before:before.subarray(0,limit).toString('utf8')}:{}),...(!binary&&after?{after:after.subarray(0,limit).toString('utf8')}:{})};
  },
  async submit(id:string,input:z.infer<typeof AppStoreSubmitDraftSchema>){
   if(jobs.has(id))throw new StoreError('conflict');const draft=await store.read(id);if(draft.status==='submitted')return AppStoreDraftSummarySchema.strip().parse(draft);
   if(!input.consent||draft.status!=='ready'||!draft.listing||!draft.report||draft.findingsAfter?.blocking)throw new StoreError('invalid');
   const files=await store.files(id,'prepared');const source=encodeAppBundle('source',files);const manifest=AppStoreManifestSchema.parse(JSON.parse(files.get('matrix.json')!.toString('utf8')));
   const {version,changelog,...listing}=draft.listing;
   const payload=AppStoreCreateSubmissionSchema.parse({submissionKey:`draft:${id}`,listing,version,changelog,license:input.license,manifest,source:{sha256:bundleDigest(source),size:source.length},generalizationReport:JSON.parse(redactSecrets(JSON.stringify(draft.report)).text)});
   await store.write({...draft,status:'submitting',stage:'upload',updatedAt:new Date().toISOString()});
   try{
    const created=await options.platform.createSubmission(payload);if(created.upload)await options.platform.transfer(created.upload.url,'PUT',source);
    const finalized=await options.platform.finalize(created.versionId);
    const result={...draft,status:'submitted' as const,stage:'upload' as const,submission:{listingSlug:listing.slug,version,versionId:created.versionId,status:finalized.status},updatedAt:new Date().toISOString()};await store.write(result);return AppStoreDraftSummarySchema.strip().parse(result);
   }catch(error:unknown){await store.write({...draft,status:'ready',failureCode:'upload_failed',updatedAt:new Date().toISOString()});throw error;}
  },
  async delete(id:string){if(jobs.has(id))throw new StoreError('conflict');await store.delete(id);return {deleted:true as const};},
  async close(){stop.abort();await Promise.allSettled([...jobs.values()]);},
 };
}
export type StorePublishService=ReturnType<typeof createStorePublishService>;
