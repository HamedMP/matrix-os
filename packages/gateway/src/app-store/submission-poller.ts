import {withStoreDirectory,atomicPrivateFile} from './private-state.js';import {isFsError,type PinnedDirectory} from '../app-gallery/pinned-directory.js';import type {AppStorePlatformClient} from './platform-client.js';
import {withOwnerFileMutation} from '../owner-file-mutations.js';import {AppStoreIdSchema} from '@matrix-os/contracts/app-store';
interface Observation{versionId:string;status:string}
export function submissionTransitions(previous:Readonly<Record<string,string>>,current:readonly Observation[]):Observation[]{return current.filter(row=>previous[row.versionId]!==undefined&&previous[row.versionId]!==row.status&&['published','changes_requested','rejected','scan_failed','withdrawn'].includes(row.status));}
async function readObservations(directory:PinnedDirectory):Promise<Record<string,string>>{
 const previous:Record<string,string>={};try{const raw:unknown=JSON.parse((await directory.readFile('submission-observations.json',32_768)).toString('utf8'));if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).length>100)throw new Error('Invalid observation');for(const[key,value]of Object.entries(raw))if(typeof value==='string'&&value.length<=32)previous[key]=value;}
 catch(error:unknown){if(!isFsError(error,'ENOENT'))throw error;}return previous;
}
function capped(value:Record<string,string>):Record<string,string>{return Object.fromEntries(Object.entries(value).slice(-100));}
/** Mark owner intent before upload/finalize so a fast terminal review cannot race the first poll. */
export async function rememberSubmissionObservation(homePath:string,versionId:string):Promise<void>{
 AppStoreIdSchema.parse(versionId);return withOwnerFileMutation(homePath,()=>withStoreDirectory(homePath,[],async directory=>{
 const previous=await readObservations(directory);if(previous[versionId]!==undefined)return;previous[versionId]='submitting';await atomicPrivateFile(directory,'submission-observations.json',Buffer.from(JSON.stringify(capped(previous))));
 }));
}
export function createSubmissionPoller(options:{homePath:string;platform:AppStorePlatformClient;notify:(change:Observation)=>Promise<void>}){
 let active:Promise<void>|undefined,closed=false;
 async function poll(){
  const page=await options.platform.submissions();const rows=page.submissions.slice(0,100);
  await withOwnerFileMutation(options.homePath,()=>withStoreDirectory(options.homePath,[],async directory=>{
   const previous=await readObservations(directory);
   for(const change of submissionTransitions(previous,rows))await options.notify(change);
   // Retain just-recorded submissions absent from an earlier in-flight page response.
   const next={...previous,...Object.fromEntries(rows.map(row=>[row.versionId,row.status]))};
   await atomicPrivateFile(directory,'submission-observations.json',Buffer.from(JSON.stringify(capped(next))));
  }));
 }
 const run=()=>{if(closed||active)return;active=poll().catch((error:unknown)=>console.warn('[app-store] Submission poll unavailable',error instanceof Error?error.name:'UnknownError')).finally(()=>{active=undefined;});};
 const timer=setInterval(run,60_000);timer.unref();
 return {start:run,async close(){closed=true;clearInterval(timer);await active;}};
}
