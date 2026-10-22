import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe,expect,it} from 'vitest';
import {parse} from 'yaml';

const ci=parse(readFileSync('.github/workflows/ci.yml','utf8'));
const dedicated=parse(readFileSync('.github/workflows/ci-dedicated.yml','utf8'));
const pin='a'.repeat(40),ref=`refs/heads/ci-execution/${pin}`;
function evaluates(value:string,{event='workflow_dispatch',actualRef=ref,flag='true',cancelled=false,mode='qualification',aggregate='success',changes='success',shouldRun='true'}={}){
 const expression=value.replace(/^\$\{\{\s*|\s*\}\}$/g,'').replaceAll('github.event.pull_request.labels.*.name','(github.event.pull_request.labels??[]).map(label=>label.name)');
 const inputs={pr_number:'2454',execution_mode:'linux',controller_mode:mode};
 const github={ref:actualRef,event_name:event,event:{inputs,pull_request:{draft:false},workflow_run:{pull_requests:[]}},sha:'e'.repeat(40)};
 const vars={MATRIX_CI_CONTROLLER_SHA:pin,MATRIX_CI_ISOLATED_EXECUTION:flag,MATRIX_CI_DEDICATED_ENABLED:'true',MATRIX_CI_DEDICATED_SHADOW:'false',MATRIX_CI_DEDICATED_MAIN:'true'};
 return Boolean(Function('github','inputs','vars','needs','always','cancelled','success','startsWith','contains','format',`return (${expression});`)(
  github,inputs,vars,{'ci-results':{result:aggregate},changes:{result:changes,outputs:{should_run:shouldRun}}},()=>true,()=>cancelled,()=>!cancelled,
  (text:string,prefix:string)=>text.startsWith(prefix),(values:string[]|string,item:string)=>values.includes(item),
  (text:string,...values:unknown[])=>text.replace(/\{(\d+)\}/g,(_match:string,index:string)=>String(values[Number(index)]))));
}
const script=(step:any)=>String(step.with?.script??'');
function helperStep(job:any,name:string){
 const found=job.steps.filter((step:any)=>script(step).includes(name));
 expect(found.length,`one actual workflow step must call ${name}`).toBe(1);return found[0];
}
function completion(){
 const found=Object.entries(ci.jobs).filter(([,job]:any)=>job.steps?.some((step:any)=>script(step).includes('requestIsolatedCiCompletion')));
 expect(found.length,'one late completion job must explicitly dispatch the handoff').toBe(1);
 return{id:found[0][0],job:found[0][1] as any};
}

describe('actual isolated CI handoff workflow graph',()=>{
 it('keeps redirect Main-only so successful routing cannot hide a failed-only P retry',()=>{
  const job=ci.jobs.redirect;
  expect(job.permissions).toEqual({actions:'write',contents:'read','pull-requests':'read'});
  expect(evaluates(job.if)).toBe(false);
  expect(evaluates(job.if,{actualRef:'refs/heads/main'})).toBe(true);
  expect(evaluates(job.if,{flag:'false',actualRef:'refs/heads/main'})).toBe(false);
  expect(evaluates(job.if,{event:'push',actualRef:'refs/heads/main'})).toBe(false);
  expect(JSON.stringify(job)).not.toContain('requestIsolatedCiQualification');
  expect(ci.jobs.changes.needs).toBe('redirect');
  expect(ci.jobs.changes.outputs.should_run).toContain("needs.redirect.outputs.routed == 'true'");
 });
 it('admits a write-capable backend only for exact protected P after successful change detection',()=>{
  const job=ci.jobs['isolated-ci-backend'];expect(job).toBeDefined();
  expect(job.needs).toBe('changes');expect(job.if).toContain('always()');expect(job.if).toContain('!cancelled()');
  expect(evaluates(job.if)).toBe(true);
  for(const inputs of [{actualRef:'refs/heads/main'},{actualRef:`refs/heads/ci-execution/${'b'.repeat(40)}`},{actualRef:`${ref}/extra`},{event:'pull_request'},{flag:'false'},{cancelled:true},{changes:'failure'},{shouldRun:'false'}])expect(evaluates(job.if,inputs)).toBe(false);
  expect(job.permissions).toEqual({actions:'write',checks:'read',contents:'read','pull-requests':'read'});
  expect(job['timeout-minutes']).toBeLessThanOrEqual(70);
  const checkout=job.steps.findIndex((step:any)=>step.uses?.startsWith('actions/checkout@'));
  expect(checkout).toBeGreaterThan(0);
  expect(job.steps[checkout].with.ref).toBe('${{ steps.origin.outputs.helper_sha }}');
  const proof=job.steps.slice(0,checkout).find((step:any)=>step.id==='origin');
  expect(proof).toBeDefined();
  expect(script(proof)).toContain('child.parents[0].sha!==pin');expect(script(proof)).toContain('child.tree.sha!==source.tree?.sha');
  expect(script(proof)).toContain('EXECUTION_WORKFLOW_SHA');expect(script(proof)).toContain('ISOLATED_EXECUTION');
  expect(JSON.stringify(job)).not.toContain('secrets.');
  expect(Object.keys(job.outputs).sort()).toEqual(['attempt','infrastructure_fallback','provider']);
  expect(job.name).toBe('Isolated CI Backend Decision');
  const handoff=helperStep(job,'requestIsolatedCiQualification'),body=script(handoff);
  expect(body).toContain('context.runId');expect(body).toContain('runAttempt');
  expect(body.indexOf('await requestIsolatedCiQualification')).toBeGreaterThanOrEqual(0);
  expect(body.indexOf('await decideRequestingBackend')).toBeGreaterThan(body.indexOf('await requestIsolatedCiQualification'));
  expect(body.search(/setOutput\(\s*['"]attempt['"]/)).toBeGreaterThan(body.indexOf('await decideRequestingBackend'));

 });
 it('retains the stable read-only logical backend with explicit status admission after skipped P helper',()=>{
  const job=ci.jobs['ci-backend'];
  expect(job.name).toBe('CI Backend Decision');expect(job.needs).toEqual(['changes','isolated-ci-backend']);
  expect(job.if).toContain('always()');expect(job.if).toContain('!cancelled()');expect(job.if).toContain("needs.changes.result == 'success'");
  expect(job.permissions).toEqual({actions:'read',checks:'read',contents:'read','pull-requests':'read'});
  expect(Object.keys(job.outputs).sort()).toEqual(['infrastructure_fallback','provider']);
  const ordinary=helperStep(job,'decideRequestingBackend');
  expect(evaluates(ordinary.if)).toBe(false);expect(evaluates(ordinary.if,{event:'push',actualRef:'refs/heads/main'})).toBe(true);
  const adopt=job.steps.find((step:any)=>step.env?.ISOLATED_BACKEND_RESULT);
  expect(adopt,'actual logical backend must validate result and outputs before passing them on').toBeDefined();
  expect(evaluates(adopt.if)).toBe(true);expect(evaluates(adopt.if,{event:'push',actualRef:'refs/heads/main'})).toBe(false);
  expect(adopt.env.ISOLATED_BACKEND_RESULT).toContain('needs.isolated-ci-backend.result');
  expect(adopt.env.ISOLATED_BACKEND_ATTEMPT).toContain('needs.isolated-ci-backend.outputs.attempt');
  expect(adopt.env.REQUESTING_ATTEMPT).toContain('github.run_attempt');
 });
 it('keeps Main manual routing separate from the actual P workload path',()=>{
  const step=helperStep(ci.jobs.redirect,'routeManualCi');
  expect(evaluates(step.if,{actualRef:'refs/heads/main'})).toBe(true);
  expect(evaluates(step.if)).toBe(false);
  expect(script(step)).toMatch(/setOutput\(\s*['"]routed['"]\s*,\s*['"]true['"]/);
 });
 it('dispatches completion after workloads and before the required aggregate without a dependency cycle',()=>{
  const {id,job}=completion(),needs=Array.isArray(job.needs)?job.needs:[job.needs];
  const aggregateNeeds=ci.jobs['ci-results'].needs;
  expect(aggregateNeeds).toContain(id);
  expect([...needs].sort()).toEqual(aggregateNeeds.filter((name:string)=>name!==id).sort());
  expect(needs).not.toContain('ci-results');expect(needs).not.toContain(id);
  expect(job.if).toContain('always()');expect(job.if).toContain('!cancelled()');
  expect(evaluates(job.if)).toBe(true);
  expect(evaluates(job.if,{aggregate:'failure'})).toBe(true);
  expect(evaluates(job.if,{cancelled:true})).toBe(false);
  expect(evaluates(job.if,{event:'push',actualRef:'refs/heads/main'})).toBe(false);
  expect(evaluates(job.if,{actualRef:'refs/heads/main'})).toBe(false);
  expect(evaluates(job.if,{flag:'false'})).toBe(false);
  expect(evaluates(job.if,{actualRef:`refs/heads/ci-execution/${'b'.repeat(40)}`})).toBe(false);
  expect(evaluates(job.if,{actualRef:`${ref}/extra`})).toBe(false);
  expect(job.permissions).toEqual({actions:'write',checks:'read',contents:'read','pull-requests':'read'});
  expect(job['timeout-minutes']).toBeLessThanOrEqual(70);
  expect(needs).toContain('isolated-ci-backend');
  expect(ci.jobs['ci-backend'].needs).toContain('isolated-ci-backend');
  expect(job.outputs.attempt).toBeDefined();
  const step=helperStep(job,'requestIsolatedCiCompletion');
  expect(script(step)).toContain('context.runId');expect(script(step)).toContain('runAttempt');
  for(const field of ['imageDigest','harnessDigest','linuxRequired'])expect(script(step)).toContain(field);
  expect(JSON.stringify(job)).not.toContain('secrets.');expect(JSON.stringify(job)).not.toContain('awaitTerminalIsolatedRequester');
  expect(ci.jobs['ci-results'].if).toContain('always()');
 });
 it('passes protected retained backend output attempt into the authenticated completion helper',()=>{
  const {job}=completion(),step=helperStep(job,'requestIsolatedCiCompletion');
  // GitHub may clone retained successes into current-attempt job rows with new IDs.
  // This protected output is written only after the backend's real verifier succeeds.
  expect(step.env.BACKEND_ATTEMPT).toBe('${{ needs.isolated-ci-backend.outputs.attempt }}');
  expect(step.env.BACKEND_PROVIDER).toBe('${{ needs.isolated-ci-backend.outputs.provider }}');
  expect(step.env.BACKEND_FALLBACK).toBe('${{ needs.isolated-ci-backend.outputs.infrastructure_fallback }}');
  expect(script(step)).toMatch(/backendAttempt:\s*Number\(process\.env\.BACKEND_ATTEMPT\)/);
  expect(script(step)).not.toMatch(/backendAttempt:[^,}]*\|\|/);
  expect(script(step)).toMatch(/backendProvider:\s*process\.env\.BACKEND_PROVIDER/);
  expect(script(step)).toMatch(/backendInfrastructureFallback:\s*process\.env\.BACKEND_FALLBACK\s*===\s*['"]true['"]/);
 });
 it.each(['handoff','redirect'].flatMap(kind=>['success','skipped','failure','cancelled'].map(result=>({kind,result}))))('the actual aggregate handles $kind $result truthfully',({kind,result})=>{
  const {id}=completion();
  const step=ci.jobs['ci-results'].steps.find((value:any)=>value.name==='Summarize required CI jobs');
  expect(step.env.CI_HANDOFF_RESULT).toContain(`needs.${id}.result`);
  expect(step.env.CI_REDIRECT_RESULT).toContain('needs.redirect.result');
  const directory=mkdtempSync(join(tmpdir(),'matrix-handoff-aggregate-'));
  try{
   const env:NodeJS.ProcessEnv={PATH:process.env.PATH,GITHUB_STEP_SUMMARY:join(directory,'summary.md'),CI_TRIGGER_REQUESTED:'true',SHOULD_RUN:'false',CHANGES_RESULT:'success',DEDICATED_ELIGIBLE:'false',DEDICATED_REQUIRED:'false',DEDICATED_MODE:'shadow',CI_HANDOFF_RESULT:'skipped',CI_REDIRECT_RESULT:'skipped'};
   env[kind==='handoff'?'CI_HANDOFF_RESULT':'CI_REDIRECT_RESULT']=result;
   for(const name of ['CI_BACKEND','DEDICATED_LINUX','TYPECHECK','SHELL_PRODUCTION_BUILD','PATTERNS','REACT_DOCTOR','SYNC_CLIENT','AGENT_SDK_COMPATIBILITY','UNIT','FUNDED_POSTGRES','COLLABORATION_POSTGRES','FUNDED_HOST_ROOT','DOCS_CONTRACT','OS_VIEW_PARITY','E2E'])env[`${name}_RESULT`]='skipped';
   const execute=()=>execFileSync('bash',['-c',step.run],{env,timeout:5000,maxBuffer:65536,stdio:'pipe'});
   if(['failure','cancelled'].includes(result))expect(execute).toThrow();else expect(execute).not.toThrow();
  }finally{rmSync(directory,{recursive:true,force:true});}
 });
 it('authenticates and waits for actual terminal requester before either reconciliation App token step',()=>{
  const job=dedicated.jobs.reconcile,steps=job.steps;
  const wait=helperStep(job,'awaitTerminalIsolatedRequester'),index=steps.indexOf(wait);
  const origin=steps.findIndex((step:any)=>step.name==='Authenticate default-main reconciliation source');
  const checkout=steps.findIndex((step:any)=>step.uses?.startsWith('actions/checkout@'));
  const config=steps.findIndex((step:any)=>step.name==='Create repository-scoped configuration read token');
  const checks=steps.findIndex((step:any)=>step.name==='Create repository-scoped checks-only gate token');
  expect(origin).toBeGreaterThanOrEqual(0);expect(checkout).toBeGreaterThan(origin);
  expect(index).toBeGreaterThan(checkout);expect(index).toBeLessThan(config);expect(index).toBeLessThan(checks);
  expect(JSON.stringify(wait)).not.toContain('secrets.');
  expect(script(wait)).toContain('context.payload.inputs');
 });
 it('never makes the qualification controller wait for its requesting CI to finish',()=>{
  const job=dedicated.jobs.benchmark;
  expect(JSON.stringify(job)).not.toContain('awaitTerminalIsolatedRequester');
  expect(evaluates(job.if,{mode:'qualification'})).toBe(true);
  expect(evaluates(job.if,{mode:'reconcile'})).toBe(false);
  expect(evaluates(dedicated.jobs.reconcile.if,{mode:'qualification'})).toBe(false);
  expect(evaluates(dedicated.jobs.reconcile.if,{mode:'reconcile'})).toBe(true);
 });
});

// A retained provider decision may schedule work; only current completion can award coverage.
it.each([
 {result:'success',provider:'linux',fallback:'false',attempt:'2',accepted:true},
 {result:'success',provider:'hosted',fallback:'false',attempt:'2',accepted:true},
 {result:'success',provider:'hosted',fallback:'true',attempt:'2',accepted:true},
 {result:'failure',provider:'linux',fallback:'false',attempt:'2',accepted:false},
 {result:'skipped',provider:'linux',fallback:'false',attempt:'2',accepted:false},
 {result:'cancelled',provider:'linux',fallback:'false',attempt:'2',accepted:false},
 {result:'success',provider:'linux',fallback:'false',attempt:'1',accepted:true},
 {result:'success',provider:'hosted',fallback:'false',attempt:'1',accepted:true},
 {result:'success',provider:'hosted',fallback:'true',attempt:'1',accepted:true},
 {result:'failure',provider:'linux',fallback:'false',attempt:'1',accepted:false},
 {result:'success',provider:'linux',fallback:'false',attempt:'0',accepted:false},
 {result:'success',provider:'linux',fallback:'false',attempt:'01',accepted:false},
 {result:'success',provider:'linux',fallback:'false',attempt:' 1',accepted:false},
 {result:'success',provider:'linux',fallback:'false',attempt:'1e0',accepted:false},
 {result:'success',provider:'linux',fallback:'false',attempt:'+1',accepted:false},
 {result:'success',provider:'linux',fallback:'false',attempt:'1.0',accepted:false},
 {result:'success',provider:'linux',fallback:'false',attempt:'3',accepted:false},
 {result:'success',provider:'linux',fallback:'false',attempt:'',accepted:false},
 {result:'success',provider:'untrusted',fallback:'false',attempt:'2',accepted:false},
 {result:'success',provider:'linux',fallback:'maybe',attempt:'2',accepted:false},
 {result:'success',provider:'linux',fallback:'true',attempt:'2',accepted:false},
])('the actual read-only backend validates only the P scheduling tuple $result/$provider/$fallback/$attempt',async({result,provider,fallback,attempt,accepted})=>{
 const step=ci.jobs['ci-backend'].steps.find((value:any)=>value.env?.ISOLATED_BACKEND_RESULT);
 expect(step,'P proof pass-through cannot run the ordinary candidate backend under write authority').toBeDefined();
 const outputs:Record<string,string>={},core={setOutput:(name:string,value:string)=>{outputs[name]=value;}};
 const env={ISOLATED_BACKEND_RESULT:result,ISOLATED_BACKEND_PROVIDER:provider,ISOLATED_BACKEND_FALLBACK:fallback,ISOLATED_BACKEND_ATTEMPT:attempt,REQUESTING_ATTEMPT:'2'};
 const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
 const run=()=>new AsyncFunction('core','process',script(step))(core,{env});
 if(accepted){await expect(run()).resolves.toBeUndefined();expect(outputs).toEqual({provider,infrastructure_fallback:fallback});}
 else{await expect(run()).rejects.toThrow();expect(outputs).toEqual({});}
});

it.each([
 {attempt:'2',result:'success',accepted:true},
 {attempt:'1',result:'success',accepted:false},
 {attempt:'3',result:'success',accepted:false},
 {attempt:'',result:'success',accepted:false},
 {attempt:'two',result:'success',accepted:false},
 {attempt:'2',result:'failure',accepted:false},
 {attempt:'2',result:'cancelled',accepted:false},
 {attempt:'2',result:'skipped',accepted:false},
])('the actual P aggregate rejects retained/wrong-attempt completion $attempt/$result',({attempt,result,accepted})=>{
 const step=ci.jobs['ci-results'].steps.find((value:any)=>value.name==='Summarize required CI jobs');
 expect(step.env.CI_ISOLATED_REQUEST).toContain("format('refs/heads/ci-execution/{0}', vars.MATRIX_CI_CONTROLLER_SHA)");
 expect(step.env.CI_REQUESTING_ATTEMPT).toContain('github.run_attempt');
 expect(step.env.CI_HANDOFF_ATTEMPT).toContain('needs.completion-handoff.outputs.attempt');
 const directory=mkdtempSync(join(tmpdir(),'matrix-current-handoff-'));
 try{
  const env:NodeJS.ProcessEnv={PATH:process.env.PATH,GITHUB_STEP_SUMMARY:join(directory,'summary.md'),CI_TRIGGER_REQUESTED:'true',SHOULD_RUN:'false',CHANGES_RESULT:'success',DEDICATED_ELIGIBLE:'false',DEDICATED_REQUIRED:'false',DEDICATED_MODE:'shadow',CI_ISOLATED_REQUEST:'true',CI_REQUESTING_ATTEMPT:'2',CI_HANDOFF_ATTEMPT:attempt,CI_HANDOFF_RESULT:result,CI_REDIRECT_RESULT:'skipped'};
  for(const name of ['CI_BACKEND','DEDICATED_LINUX','TYPECHECK','SHELL_PRODUCTION_BUILD','PATTERNS','REACT_DOCTOR','SYNC_CLIENT','AGENT_SDK_COMPATIBILITY','UNIT','FUNDED_POSTGRES','COLLABORATION_POSTGRES','FUNDED_HOST_ROOT','DOCS_CONTRACT','OS_VIEW_PARITY','E2E'])env[`${name}_RESULT`]='skipped';
  const run=()=>execFileSync('bash',['-c',step.run],{env,timeout:5000,maxBuffer:65536,stdio:'pipe'});
  if(accepted)expect(run).not.toThrow();else expect(run).toThrow();
 }finally{rmSync(directory,{recursive:true,force:true});}
});

it.each([
 {kind:'hosted backend failed',backend:'failure',source:true,accepted:false},
 {kind:'hosted backend cancelled',backend:'cancelled',source:true,accepted:false},
 {kind:'hosted backend passed',backend:'success',source:true,accepted:true},
 {kind:'non-P docs backend skipped',backend:'skipped',source:false,accepted:true},
 {kind:'historical non-P docs backend omitted',backend:undefined,source:false,accepted:true},
])('the actual aggregate preserves backend outcome: $kind',({backend,source,accepted})=>{
 const step=ci.jobs['ci-results'].steps.find((value:any)=>value.name==='Summarize required CI jobs');
 const directory=mkdtempSync(join(tmpdir(),'matrix-hosted-backend-outcome-'));
 try{
  const env:NodeJS.ProcessEnv={PATH:process.env.PATH,GITHUB_STEP_SUMMARY:join(directory,'summary.md'),CI_TRIGGER_REQUESTED:'true',SHOULD_RUN:String(source),CHANGES_RESULT:'success',DEDICATED_ELIGIBLE:'false',DEDICATED_REQUIRED:'false',DEDICATED_MODE:'shadow',CI_BACKEND_PROVIDER:'hosted',INFRASTRUCTURE_FALLBACK:'false',CI_ISOLATED_REQUEST:String(source),CI_REQUESTING_ATTEMPT:'2',CI_HANDOFF_ATTEMPT:'2',CI_HANDOFF_RESULT:source?'success':'skipped',CI_REDIRECT_RESULT:'skipped'};
  for(const name of ['DEDICATED_LINUX','TYPECHECK','SHELL_PRODUCTION_BUILD','PATTERNS','REACT_DOCTOR','SYNC_CLIENT','AGENT_SDK_COMPATIBILITY','UNIT','FUNDED_POSTGRES','COLLABORATION_POSTGRES','FUNDED_HOST_ROOT','DOCS_CONTRACT','OS_VIEW_PARITY','E2E'])env[`${name}_RESULT`]=source?'success':'skipped';
  if(backend!==undefined)env.CI_BACKEND_RESULT=backend;
  const run=()=>execFileSync('bash',['-c',step.run],{env,timeout:5000,maxBuffer:65536,stdio:'pipe'});
  if(accepted)expect(run).not.toThrow();else expect(run).toThrow();
 }finally{rmSync(directory,{recursive:true,force:true});}
});

it('binds the routing-only aggregate to actual redirect and detector job outcomes',()=>{
 const step=ci.jobs['ci-results'].steps.find((value:any)=>value.name==='Summarize isolated CI routing');
 expect(step.if).toContain("needs.redirect.outputs.routed == 'true'");
 expect(step.env?.CI_REDIRECT_RESULT).toBe('${{ needs.redirect.result }}');
 expect(step.env?.CHANGES_RESULT).toBe('${{ needs.changes.result }}');
});

it.each([
 {redirect:'success',changes:'success',accepted:true},
 {redirect:'failure',changes:'success',accepted:false},
 {redirect:'cancelled',changes:'success',accepted:false},
 {redirect:'success',changes:'failure',accepted:false},
])('the actual routing summary preserves failure after routed output: $redirect/$changes',({redirect,changes,accepted})=>{
 const step=ci.jobs['ci-results'].steps.find((value:any)=>value.name==='Summarize isolated CI routing');
 const directory=mkdtempSync(join(tmpdir(),'matrix-routing-outcome-'));
 try{
  // routed=true may already have been written before a later summary operation fails.
  const env={PATH:process.env.PATH,GITHUB_STEP_SUMMARY:join(directory,'summary.md'),CI_REDIRECT_RESULT:redirect,CHANGES_RESULT:changes};
  const run=()=>execFileSync('bash',['-c',step.run],{env,timeout:5000,maxBuffer:65536,stdio:'pipe'});
  if(accepted)expect(run).not.toThrow();else expect(run).toThrow();
 }finally{rmSync(directory,{recursive:true,force:true});}
});
