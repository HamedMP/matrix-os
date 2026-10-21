import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {parse} from 'yaml';
const ci=()=>parse(readFileSync('.github/workflows/ci.yml','utf8'));
it('waits for an authenticated backend before every delegated hosted lane',()=>{
 const w=ci();expect(w.jobs['ci-backend']).toBeDefined();
 for(const name of ['typecheck','shell-production-build','agent-sdk-compatibility','unit','docs-contract','os-view-parity','e2e']){
  const job=w.jobs[name];expect(job.needs).toContain('ci-backend');expect(job.if).toContain('always()');expect(job.if).toContain("needs.ci-backend.outputs.provider == 'hosted'");
 }
 expect(w.jobs.patterns.needs).toBe('changes');expect(w.jobs['funded-postgres'].needs).toBe('changes');
});
it('does not accept a Linux infrastructure result without complete hosted aggregate coverage',()=>{
 const w=ci(),job=w.jobs['ci-results'];expect(job.needs).toContain('ci-backend');
 const step=job.steps.find((step:any)=>step.name==='Summarize required CI jobs');expect(step.env.CI_BACKEND_RESULT).toContain('needs.ci-backend.result');expect(step.env.CI_BACKEND_PROVIDER).toContain('needs.ci-backend.outputs.provider');
 expect(step.run).toContain('CI_BACKEND_PROVIDER');expect(step.run).toContain('INFRASTRUCTURE_FALLBACK');
});
it('keeps fixed main-only privileged helpers and exposes complete signed source shape',()=>{
 const w=parse(readFileSync('.github/workflows/ci-dedicated.yml','utf8')),job=w.jobs.benchmark;
 expect(job.concurrency).toBeUndefined();expect(job.steps.find((s:any)=>s.id==='admit').with.script).toContain('source_kind');
 expect(job.steps.find((s:any)=>s.id==='dispatch').with.script).toContain('sourceKind');expect(job.steps.find((s:any)=>s.id==='dispatch').with.script).toContain('infrastructure_proof');
});
it('forces every step in docs/parity lanes to run for authenticated infrastructure fallback',()=>{
 const w=ci();for(const name of ['docs-contract','os-view-parity'])for(const step of w.jobs[name].steps){if(step.if)expect(step.if).toContain('infrastructure_fallback');}
});
