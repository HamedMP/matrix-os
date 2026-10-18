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

import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {vi} from 'vitest';import {createSubmissionPoller} from '../../../packages/gateway/src/app-store/submission-poller.js';
it.skipIf(process.platform!=='linux')('retains a newly submitted marker across an older in-flight page and notifies once',async()=>{
 const home=await mkdtemp(join(tmpdir(),'matrix-store-poll-'));const versionId='e53000b2-83ab-4c64-b8fc-ff176d733cb0';const notify=vi.fn();let complete!:(value:unknown)=>void;
 try{const older=createSubmissionPoller({homePath:home,platform:{submissions:()=>new Promise(resolve=>{complete=resolve;})} as never,notify});older.start();await rememberSubmissionObservation(home,versionId);complete({submissions:[]});await older.close();
 const poll=()=>createSubmissionPoller({homePath:home,platform:{submissions:async()=>({submissions:[{versionId,status:'published'},{versionId:'historical',status:'published'}]})} as never,notify});
 const first=poll();first.start();await first.close();expect(notify).toHaveBeenCalledExactlyOnceWith({versionId,status:'published'});
 await rememberSubmissionObservation(home,versionId);const repeated=poll();repeated.start();await repeated.close();expect(notify).toHaveBeenCalledOnce();
 }finally{await rm(home,{recursive:true,force:true});}
});
