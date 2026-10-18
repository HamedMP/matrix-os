import {collectSubmissionPages,retainSubmissionObservations} from './submission-pages.js';
import {withStoreDirectory,atomicPrivateFile} from './private-state.js';import {isFsError,type PinnedDirectory} from '../app-gallery/pinned-directory.js';import type {AppStorePlatformClient} from './platform-client.js';
import {withOwnerFileMutation} from '../owner-file-mutations.js';import {AppStoreCatalogQuerySchema,AppStoreIdSchema} from '@matrix-os/contracts/app-store';
interface Observation{versionId:string;status:string}
export function submissionTransitions(previous:Readonly<Record<string,string>>,current:readonly Observation[]):Observation[]{return current.filter(row=>previous[row.versionId]!==undefined&&previous[row.versionId]!==row.status&&['published','changes_requested','rejected','scan_failed','withdrawn'].includes(row.status));}
async function readObservations(directory:PinnedDirectory):Promise<Record<string,string>>{
 const previous:Record<string,string>={};try{const raw:unknown=JSON.parse((await directory.readFile('submission-observations.json',65_536)).toString('utf8'));if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).length>500)throw new Error('Invalid observation');for(const[key,value]of Object.entries(raw))if(typeof value==='string'&&value.length<=32)previous[key]=value;}
 catch(error:unknown){if(!isFsError(error,'ENOENT'))throw error;}return previous;
}
async function readScanCursor(directory:PinnedDirectory):Promise<string|undefined>{try{const raw:unknown=JSON.parse((await directory.readFile('submission-poll-cursor.json',512)).toString('utf8'));if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Invalid poll cursor');if('cursor'in raw){return AppStoreCatalogQuerySchema.shape.cursor.unwrap().parse(raw.cursor);}return undefined;}catch(error:unknown){if(isFsError(error,'ENOENT'))return undefined;throw error;}}
/** Mark owner intent before upload/finalize so a fast terminal review cannot race the first poll. */
export async function rememberSubmissionObservation(homePath:string,versionId:string):Promise<void>{
 AppStoreIdSchema.parse(versionId);return withOwnerFileMutation(homePath,()=>withStoreDirectory(homePath,[],async directory=>{
 const previous=await readObservations(directory);if(previous[versionId]!==undefined)return;await atomicPrivateFile(directory,'submission-observations.json',Buffer.from(JSON.stringify(retainSubmissionObservations(previous,[{versionId,status:'submitting'}]))));
 }));
}
export function createSubmissionPoller(options:{homePath:string;platform:AppStorePlatformClient;notify:(change:Observation)=>Promise<void>}){
 let active:Promise<void>|undefined,closed=false;
 async function poll(){
  const resume=await withStoreDirectory(options.homePath,[],readScanCursor);
  const {rows,cursor}=await collectSubmissionPages(value=>options.platform.submissions(value),resume);
  await withOwnerFileMutation(options.homePath,()=>withStoreDirectory(options.homePath,[],async directory=>{
   const previous=await readObservations(directory);
   for(const change of submissionTransitions(previous,rows))await options.notify(change);
   // Retain just-recorded submissions absent from an earlier in-flight page response.
   const next=retainSubmissionObservations(previous,rows);
   await atomicPrivateFile(directory,'submission-observations.json',Buffer.from(JSON.stringify(next)));
   await atomicPrivateFile(directory,'submission-poll-cursor.json',Buffer.from(JSON.stringify(cursor?{cursor}:{})));
  }));
 }
 const run=()=>{if(closed||active)return;active=poll().catch((error:unknown)=>console.warn('[app-store] Submission poll unavailable',error instanceof Error?error.name:'UnknownError')).finally(()=>{active=undefined;});};
 const timer=setInterval(run,60_000);timer.unref();
 return {start:run,async close(){closed=true;clearInterval(timer);await active;}};
}
