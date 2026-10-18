import {describe,it,expect} from 'vitest';
import {submissionTransitions} from '../../../packages/gateway/src/app-store/submission-poller.js';
describe('submission changes',()=>{
 it('stays quiet for initial and unchanged status, emits only meaningful transitions',()=>{
  expect(submissionTransitions({},[{versionId:'one',status:'in_review'}])).toEqual([]);
  expect(submissionTransitions({one:'in_review'},[{versionId:'one',status:'in_review'}])).toEqual([]);
  expect(submissionTransitions({one:'in_review'},[{versionId:'one',status:'published'}])).toEqual([{versionId:'one',status:'published'}]);
 });
});

import {rememberSubmissionObservation} from '../../../packages/gateway/src/app-store/submission-poller.js';

it('notifies a terminal state even if it is the first poll after this owner submitted',()=>{expect(submissionTransitions({one:'submitting'},[{versionId:'one',status:'published'}])).toEqual([{versionId:'one',status:'published'}]);expect(submissionTransitions({},[{versionId:'historical',status:'published'}])).toEqual([]);});

import {mkdtemp,rm,mkdir,writeFile,readFile} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {vi} from 'vitest';import {createSubmissionPoller} from '../../../packages/gateway/src/app-store/submission-poller.js';
it.skipIf(process.platform!=='linux')('retains a newly submitted marker across an older in-flight page and notifies once',async()=>{
 const home=await mkdtemp(join(tmpdir(),'matrix-store-poll-'));const versionId='e53000b2-83ab-4c64-b8fc-ff176d733cb0';const notify=vi.fn();let complete!:(value:unknown)=>void;let requested!:()=>void;const requestStarted=new Promise<void>(resolve=>{requested=resolve;});
 try{const older=createSubmissionPoller({homePath:home,platform:{submissions:()=>new Promise(resolve=>{complete=resolve;requested();})} as never,notify});older.start();await requestStarted;await rememberSubmissionObservation(home,versionId);complete({submissions:[]});await older.close();
 const poll=()=>createSubmissionPoller({homePath:home,platform:{submissions:async()=>({submissions:[{versionId,status:'published'},{versionId:'historical',status:'published'}]})} as never,notify});
 const first=poll();first.start();await first.close();expect(notify).toHaveBeenCalledExactlyOnceWith({versionId,status:'published'});
 await rememberSubmissionObservation(home,versionId);const repeated=poll();repeated.start();await repeated.close();expect(notify).toHaveBeenCalledOnce();
 }finally{await rm(home,{recursive:true,force:true});}
});
it.skipIf(process.platform!=='linux')('reclaims deleted upload baselines at capacity without evicting reviews or losing transport-failed observations',async()=>{
 const home=await mkdtemp(join(tmpdir(),'matrix-store-orphan-poll-'));const id=(n:number)=>`00000000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`;const review=id(498),published=id(499),fresh=id(999);
 const file=join(home,'data/app-store/submission-observations.json');
 const previous={...Object.fromEntries(Array.from({length:498},(_,n)=>[id(n),'awaiting_upload'])),[review]:'in_review',[published]:'published'};
 const notify=vi.fn();const missing=vi.fn(async()=>null);
 try{
 await mkdir(join(home,'data/app-store'),{recursive:true,mode:0o700});await writeFile(file,JSON.stringify(previous));
 const failed=createSubmissionPoller({homePath:home,platform:{submissions:async()=>({submissions:[]}),submission:async()=>{throw new Error('offline');}} as never,notify});failed.start();await failed.close();expect(JSON.parse(await readFile(file,'utf8'))).toEqual(previous);
 const poll=createSubmissionPoller({homePath:home,platform:{submissions:async()=>({submissions:[]}),submission:missing} as never,notify});poll.start();await poll.close();expect(missing).toHaveBeenCalledTimes(4);
 await rememberSubmissionObservation(home,fresh);const saved=JSON.parse(await readFile(file,'utf8'));expect(Object.keys(saved)).toHaveLength(497);expect(saved[review]).toBe('in_review');expect(saved[published]).toBe('published');expect(saved[fresh]).toBe('submitting');expect(notify).not.toHaveBeenCalled();
 }finally{await rm(home,{recursive:true,force:true});}
});
