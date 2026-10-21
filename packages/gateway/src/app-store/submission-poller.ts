import {withStoreDirectory,atomicPrivateFile} from './private-state.js';import {isFsError} from '../app-gallery/pinned-directory.js';import type {AppStorePlatformClient} from './platform-client.js';
interface Observation{versionId:string;status:string}
export function submissionTransitions(previous:Readonly<Record<string,string>>,current:readonly Observation[]):Observation[]{return current.filter(row=>previous[row.versionId]!==undefined&&previous[row.versionId]!==row.status&&['published','changes_requested','rejected','scan_failed','withdrawn'].includes(row.status));}
export function createSubmissionPoller(options:{homePath:string;platform:AppStorePlatformClient;notify:(change:Observation)=>Promise<void>}){
 let active:Promise<void>|undefined,closed=false;
 async function poll(){
  const page=await options.platform.submissions();const rows=page.submissions.slice(0,100);let previous:Record<string,string>={};
  await withStoreDirectory(options.homePath,[],async directory=>{
   try{const raw:unknown=JSON.parse((await directory.readFile('submission-observations.json',32_768)).toString('utf8'));if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).length>100)throw new Error('Invalid observation');for(const[key,value]of Object.entries(raw))if(typeof value==='string'&&value.length<=32)previous[key]=value;}
   catch(error:unknown){if(!isFsError(error,'ENOENT'))throw error;}
   for(const change of submissionTransitions(previous,rows))await options.notify(change);
   await atomicPrivateFile(directory,'submission-observations.json',Buffer.from(JSON.stringify(Object.fromEntries(rows.map(row=>[row.versionId,row.status])))));
  });
 }
 const run=()=>{if(closed||active)return;active=poll().catch((error:unknown)=>console.warn('[app-store] Submission poll unavailable',error instanceof Error?error.name:'UnknownError')).finally(()=>{active=undefined;});};
 const timer=setInterval(run,60_000);timer.unref();
 return {start:run,async close(){closed=true;clearInterval(timer);await active;}};
}
