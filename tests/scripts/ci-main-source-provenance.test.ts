import {describe,expect,it} from 'vitest';
import {verifyCurrentDedicatedSource} from '../../scripts/ci/dedicated-admission.mjs';
import {admitRefreshController} from '../../scripts/ci/dedicated-refresh.mjs';
import {pins,repo,stableMainFixture} from './helpers/stable-main-fixture';

describe('historical main merge provenance',()=>{
 it('rejects an arbitrary merge tree with the right ordered parents advertised in a PR-owned title',async()=>{
  const f=stableMainFixture();f.ci.display_title=`CI coverage-v1 · ${pins.newSource}`;
  f.github.rest.repos.getCommit.mockImplementation(async({ref})=>({data:{sha:ref,parents:[{sha:pins.base},{sha:pins.head}],commit:{tree:{sha:'1'.repeat(40)}}}}));
  await expect(admitRefreshController(f.github,repo,{action:'requested',workflow_run:f.ci},{provenanceDelay:async()=>{}})).rejects.toThrow(/provenance|canonical|attestation/);
 });
 it('requires protected provenance when main advances, even with structurally valid merge parents',async()=>{
  const f=stableMainFixture();f.advance();
  f.github.rest.checks.listForRef.mockResolvedValue({data:{check_runs:[]}});
  await expect(verifyCurrentDedicatedSource(f.github,repo,f.snapshot)).rejects.toThrow(/provenance|canonical|attestation/);
 });
 it('accepts a source directly verified as the live GitHub merge without a historical journal',async()=>{
  const f=stableMainFixture();f.github.rest.checks.listForRef.mockResolvedValue({data:{check_runs:[]}});
  await expect(verifyCurrentDedicatedSource(f.github,repo,f.snapshot)).resolves.toMatchObject({mergeParents:[pins.base,pins.head]});
 });
});

it.each(['app','pr','head','ref','controller','unmarked'])('rejects historical provenance with wrong %s authority',async kind=>{
 const f=stableMainFixture();f.advance();
 if(kind==='app')f.provenance.app.id=1;
 const evidence=JSON.parse(f.provenance.output.summary);
 if(kind==='pr')evidence.prNumber=1;if(kind==='head')evidence.headSha=pins.advanced;if(kind==='ref')evidence.headRef='another-branch';if(kind==='unmarked')delete evidence.sourceBindings;
 f.provenance.output.summary=JSON.stringify(evidence);
 if(kind==='controller')f.github.rest.actions.getWorkflowRun.mockResolvedValue({data:{...f.run,id:123,event:'pull_request',path:'.github/workflows/ci.yml',workflow_id:98}});
 await expect(verifyCurrentDedicatedSource(f.github,repo,f.snapshot)).rejects.toThrow(/provenance/);
});

it('keeps historical bindings when augmenting the journal fails',async()=>{
 const {reconcileSourceQualification}=await import('../../scripts/ci/dedicated-source-gate.mjs');
 const f=stableMainFixture();f.advance();
 f.github.rest.repos.getCommit.mockRejectedValue(new Error('API temporarily denied'));
 await reconcileSourceQualification(f.github,repo,f.origin,{runId:123,runAttempt:1,prNumber:2454,gateAppId:5271502,gateGithub:f.gateGithub});
 const write=f.gateGithub.rest.checks.update.mock.calls.at(-1)![0];
 expect(write.conclusion).toBe('failure');
 expect(JSON.parse(write.output.summary).sourceBindings).toEqual([{baseSha:pins.base,sourceSha:pins.source}]);
});

it('retains active source provenance at the journal cap and rejects unrecorded history',async()=>{
 const {mainPrSourceBindings}=await import('../../scripts/ci/dedicated-main-pr.mjs');
 const f=stableMainFixture(),prior=JSON.parse(f.provenance.output.summary);
 prior.sourceBindings=Array.from({length:4},(_,index)=>({baseSha:String(index+1).repeat(40),sourceSha:String(index+5).repeat(40)}));
 expect(await mainPrSourceBindings(f.github,repo,f.pull,prior)).toEqual(prior.sourceBindings);
 expect(f.github.rest.repos.getCommit).not.toHaveBeenCalled();
});

it('waits for concurrent protected event publication before historical workflow-run admission',async()=>{
 const f=stableMainFixture();f.advance();let published=false;
 f.github.rest.checks.listForRef.mockImplementation(async({check_name})=>({data:{check_runs:check_name==='CI Source Qualification'&&published?[f.provenance]:[]}}));
 const delay=async()=>{published=true;};
 await expect(admitRefreshController(f.github,repo,{action:'requested',workflow_run:f.ci},{provenanceDelay:delay})).resolves.toMatchObject(f.snapshot);
 expect(published).toBe(true);
});

it('publishes the actual trusted event source before discovering historical coverage',async()=>{
 const {reconcileSourceQualification}=await import('../../scripts/ci/dedicated-source-gate.mjs');
 const f=stableMainFixture(),event=structuredClone(f.pull);f.advance();f.complete();
 let stored:any;
 f.github.rest.checks.listForRef.mockImplementation(async({check_name})=>({data:{check_runs:check_name==='CI Source Qualification'?(stored?[stored]:[]):[f.check]}}));
 f.gateGithub.rest.checks.create.mockImplementation(async(args:any)=>({data:stored={id:13,...args,app:{id:5271502,slug:'matrix-ci-gate'}}}));
 f.gateGithub.rest.checks.update.mockImplementation(async(args:any)=>({data:stored={...stored,...args}}));
 await reconcileSourceQualification(f.github,repo,f.origin,{runId:123,runAttempt:1,prNumber:2454,gateAppId:5271502,gateGithub:f.gateGithub,eventPull:event});
 expect(stored.conclusion).toBe('success');
 const evidence=JSON.parse(stored.output.summary);
 expect(evidence).toMatchObject({baseSha:pins.base,sourceSha:pins.source,requestingRunId:321});
 expect(evidence.sourceBindings).toContainEqual({baseSha:pins.base,sourceSha:pins.source});
 expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
});

it('rejects a stalled transport at the publication deadline even if it ignores abort',async()=>{
 const {vi}=await import('vitest'),{waitForMainSourceProvenance}=await import('../../scripts/ci/dedicated-main-provenance.mjs');
 vi.useFakeTimers();try{
  const f=stableMainFixture();f.github.rest.actions.getWorkflow.mockImplementation(()=>new Promise(()=>{}));
  const pending=waitForMainSourceProvenance(f.github,repo,f.snapshot);pending.catch(()=>{});
  await vi.advanceTimersByTimeAsync(60_001);
  await expect(pending).rejects.toThrow(/before dispatch/);
 }finally{vi.useRealTimers();}
});

it('logs a bounded canonical-source read failure while retaining authenticated history',async()=>{
 const {vi}=await import('vitest'),{mainPrSourceBindings}=await import('../../scripts/ci/dedicated-main-pr.mjs');
 const f=stableMainFixture(),prior=JSON.parse(f.provenance.output.summary);f.advance();
 f.github.rest.repos.getCommit.mockRejectedValue(new Error('https://private.invalid/operator-detail'));
 const warning=vi.spyOn(console,'warn').mockImplementation(()=>{});
 try{
  expect(await mainPrSourceBindings(f.github,repo,f.pull,prior)).toEqual(prior.sourceBindings);
  expect(warning).toHaveBeenCalledWith(expect.stringMatching(/canonical-source: unexpected Error$/));
  expect(warning.mock.calls.flat().join(' ')).not.toContain('private.invalid');
 }finally{warning.mockRestore();}
});

it('authenticates the recorded controller attempt after a later rerun begins',async()=>{
 const f=stableMainFixture();f.advance();
 const get=f.github.rest.actions.getWorkflowRun.getMockImplementation()!;
 f.github.rest.actions.getWorkflowRun.mockImplementation(async(args:any)=>{const result=await get(args);return{data:{...result.data,run_attempt:2}};});
 Object.assign(f.github.rest.actions,{getWorkflowRunAttempt:async(args:any)=>({data:{...(await get({run_id:args.run_id})).data,run_attempt:args.attempt_number}})});
 await expect(verifyCurrentDedicatedSource(f.github,repo,f.snapshot)).resolves.toMatchObject({mergeParents:[pins.base,pins.head]});
});

it('preserves the earlier-attempt journal when a push controller rebuilds the gate',async()=>{
 const {reconcileSourceQualification}=await import('../../scripts/ci/dedicated-source-gate.mjs');
 const f=stableMainFixture();f.advance();f.complete();
 const get=f.github.rest.actions.getWorkflowRun.getMockImplementation()!;
 f.github.rest.actions.getWorkflowRun.mockImplementation(async(args:any)=>({data:{...(await get(args)).data,run_attempt:2}}));
 Object.assign(f.github.rest.actions,{getWorkflowRunAttempt:async(args:any)=>({data:{...(await get({run_id:args.run_id})).data,run_attempt:args.attempt_number}})});
 await reconcileSourceQualification(f.github,repo,f.origin,{runId:123,runAttempt:2,prNumber:2454,gateAppId:5271502,gateGithub:f.gateGithub});
 const write=f.gateGithub.rest.checks.update.mock.calls.at(-1)?.[0]??f.gateGithub.rest.checks.create.mock.calls.at(-1)![0];
 expect(JSON.parse(write.output.summary).sourceBindings).toContainEqual({baseSha:pins.base,sourceSha:pins.source});
});

it('rejects obsolete workflow-run admission before waiting for historical publication',async()=>{
 const f=stableMainFixture();f.advance();f.pull.head.sha=pins.advanced;let waited=false;
 f.github.rest.checks.listForRef.mockResolvedValue({data:{check_runs:[]}});
 await expect(admitRefreshController(f.github,repo,{action:'requested',workflow_run:f.ci},{provenanceDelay:async()=>{waited=true;}})).rejects.toThrow(/stale/);
 expect(waited).toBe(false);
});

it('stands down if the head changes while historical publication is pending',async()=>{
 const f=stableMainFixture();f.advance();let waits=0;
 f.github.rest.checks.listForRef.mockResolvedValue({data:{check_runs:[]}});
 await expect(admitRefreshController(f.github,repo,{action:'requested',workflow_run:f.ci},{provenanceDelay:async()=>{waits++;f.pull.head.sha=pins.advanced;}})).rejects.toThrow(/stale/);
 expect(waits).toBe(1);
});
