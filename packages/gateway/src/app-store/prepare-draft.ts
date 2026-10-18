import {AppStoreManifestSchema,deriveAppStoreCapabilities,type AppStoreGeneralizationReport} from '@matrix-os/contracts/app-store';
import type {AppStoreDraftDetail,AppStoreListingDraft} from '@matrix-os/contracts/app-store-gateway';
import {scanAppFiles} from '@matrix-os/contracts/app-store-scan';
import {scrubSource} from './scrub.js';
type Generalization={files:Map<string,Buffer>;report:AppStoreGeneralizationReport;listing:AppStoreListingDraft};
export async function preparePublishDraft(options:{files:ReadonlyMap<string,Buffer>;ownerTerms:readonly string[];aiConsent?:{accessSourceId:string};instructions?:string;signal:AbortSignal;generalizer:{generalize(files:ReadonlyMap<string,Buffer>,consent:{accessSourceId:string}|undefined,instructions:string,signal:AbortSignal):Promise<Generalization|null>};builder:{build(files:ReadonlyMap<string,Buffer>,signal?:AbortSignal):Promise<unknown>}}){
 const findingsBefore=scanAppFiles(options.files,{ownerTerms:[...options.ownerTerms]});
 const scrubbed=scrubSource(options.files,options.ownerTerms);let files=scrubbed.files;
 let report:AppStoreGeneralizationReport={ai:'unavailable',changes:scrubbed.changes};let listing:AppStoreListingDraft|null=null;
 let failureCode:AppStoreDraftDetail['failureCode'];
 const outgoingScan=scanAppFiles(files,{ownerTerms:[...options.ownerTerms]});
 if(options.aiConsent&&!outgoingScan.findings.some(f=>f.category==='secret')){
  try{
   const result=await options.generalizer.generalize(files,options.aiConsent,options.instructions??'',options.signal);
   if(result){files=result.files;report={...result.report,changes:[...scrubbed.changes,...result.report.changes].slice(0,200)};listing=result.listing;}
  }catch(error:unknown){console.warn('[app-store] Generalization failed',error instanceof Error?error.name:'UnknownError');report.ai='failed';failureCode='generalize_failed';}
 }
 const findingsAfter=scanAppFiles(files,{ownerTerms:[...options.ownerTerms]});
 let manifest=null;
 try{manifest=AppStoreManifestSchema.parse(JSON.parse(files.get('matrix.json')?.toString('utf8')??'null'));}catch(error:unknown){if(!(error instanceof Error))throw error;failureCode='verify_failed';}
 let ready=Boolean(manifest&&!findingsAfter.blocking&&report.ai==='completed');
 if(ready){try{await options.builder.build(files,options.signal);}catch(error:unknown){console.warn('[app-store] Draft build verification failed',error instanceof Error?error.name:'UnknownError');ready=false;failureCode='build_failed';}}
 const changedFiles:AppStoreDraftDetail['changedFiles']=[];
 for(const path of new Set([...options.files.keys(),...files.keys()])){
  const before=options.files.get(path),after=files.get(path);if(before&&after&&before.equals(after))continue;
  changedFiles.push({path,change:before?after?'modified':'removed':'added'});
 }
 return {files,status:ready?'ready' as const:'needs_attention' as const,failureCode,ai:report.ai,findingsBefore,findingsAfter,report,listing,capabilities:manifest?deriveAppStoreCapabilities(manifest):null,changedFiles,blockingFindings:findingsAfter.findings.filter(f=>f.severity==='high').length};
}
