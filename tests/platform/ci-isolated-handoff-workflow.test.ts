import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe,expect,it} from 'vitest';
import {parse} from 'yaml';

const ci=parse(readFileSync('.github/workflows/ci.yml','utf8'));
const dedicated=parse(readFileSync('.github/workflows/ci-dedicated.yml','utf8'));
const pin='a'.repeat(40),ref=`refs/heads/ci-execution/${pin}`;
function evaluates(value:string,{event='workflow_dispatch',actualRef=ref,flag='true',cancelled=false,mode='qualification',aggregate='success'}={}){
 const expression=value.replace(/^\$\{\{\s*|\s*\}\}$/g,'');
 const inputs={pr_number:'2454',execution_mode:'linux',controller_mode:mode};
 const github={ref:actualRef,event_name:event,event:{inputs,pull_request:{draft:false},workflow_run:{pull_requests:[]}},sha:'e'.repeat(40)};
 const vars={MATRIX_CI_CONTROLLER_SHA:pin,MATRIX_CI_ISOLATED_EXECUTION:flag,MATRIX_CI_DEDICATED_ENABLED:'true',MATRIX_CI_DEDICATED_SHADOW:'false',MATRIX_CI_DEDICATED_MAIN:'true'};
 return Boolean(Function('github','inputs','vars','needs','always','cancelled','success','startsWith','contains','format',`return (${expression});`)(
  github,inputs,vars,{'ci-results':{result:aggregate}},()=>true,()=>cancelled,()=>!cancelled,
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
 it('reuses the existing dispatch-capable router for P self qualification without suppressing P workloads',()=>{
  const job=ci.jobs.redirect;
  expect(job.permissions).toEqual({actions:'write',contents:'read','pull-requests':'read'});
  expect(evaluates(job.if)).toBe(true);
  expect(evaluates(job.if,{actualRef:'refs/heads/main'})).toBe(true);
  expect(evaluates(job.if,{flag:'false'})).toBe(false);
  expect(evaluates(job.if,{event:'push',actualRef:'refs/heads/main'})).toBe(false);
  const handoff=helperStep(job,'requestIsolatedCiQualification');
  expect(evaluates(handoff.if)).toBe(true);
  expect(evaluates(handoff.if,{actualRef:'refs/heads/main'})).toBe(false);
  expect(script(handoff)).toContain('context.runId');expect(script(handoff)).toContain('runAttempt');
  expect(script(handoff)).not.toMatch(/setOutput\(\s*['"]routed['"]/);
  expect(ci.jobs.changes.needs).toBe('redirect');
  expect(ci.jobs.changes.outputs.should_run).toContain("needs.redirect.outputs.routed == 'true'");
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
  expect(job.permissions).toEqual({actions:'write',contents:'read','pull-requests':'read'});
  expect(job['timeout-minutes']).toBeLessThanOrEqual(5);
  const step=helperStep(job,'requestIsolatedCiCompletion');
  expect(script(step)).toContain('context.runId');expect(script(step)).toContain('runAttempt');
  expect(JSON.stringify(job)).not.toContain('secrets.');expect(JSON.stringify(job)).not.toContain('awaitTerminalIsolatedRequester');
  expect(ci.jobs['ci-results'].if).toContain('always()');
 });
 it.each(['success','skipped','failure','cancelled'])('the actual aggregate handles completion handoff %s truthfully',result=>{
  const {id}=completion();
  const step=ci.jobs['ci-results'].steps.find((value:any)=>value.name==='Summarize required CI jobs');
  expect(step.env.CI_HANDOFF_RESULT).toContain(`needs.${id}.result`);
  const directory=mkdtempSync(join(tmpdir(),'matrix-handoff-aggregate-'));
  try{
   const env:NodeJS.ProcessEnv={PATH:process.env.PATH,GITHUB_STEP_SUMMARY:join(directory,'summary.md'),CI_TRIGGER_REQUESTED:'true',SHOULD_RUN:'false',CHANGES_RESULT:'success',DEDICATED_ELIGIBLE:'false',DEDICATED_REQUIRED:'false',DEDICATED_MODE:'shadow',CI_HANDOFF_RESULT:result};
   for(const name of ['CI_BACKEND','DEDICATED_LINUX','TYPECHECK','SHELL_PRODUCTION_BUILD','PATTERNS','REACT_DOCTOR','SYNC_CLIENT','AGENT_SDK_COMPATIBILITY','UNIT','FUNDED_POSTGRES','FUNDED_HOST_ROOT','DOCS_CONTRACT','OS_VIEW_PARITY','E2E'])env[`${name}_RESULT`]='skipped';
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
