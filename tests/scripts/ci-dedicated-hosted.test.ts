import {expect,it,vi} from 'vitest';
import {verifyFullHostedCoverage,HOSTED_LANES} from '../../scripts/ci/dedicated-hosted.mjs';
const repo={owner:'HamedMP',repo:'matrix-os'},sha='a'.repeat(40);
function fixture(){
 const run={id:12,run_attempt:2,head_sha:sha,status:'completed',conclusion:'success'};
 const jobs=[...HOSTED_LANES,'CI Results'].map((name,i)=>({id:i+1,name,run_id:12,run_attempt:2,head_sha:sha,status:'completed',conclusion:'success',check_run_url:`https://api.github.com/repos/HamedMP/matrix-os/check-runs/${i+1}`}));
 const github={rest:{actions:{listJobsForWorkflowRun:vi.fn(async()=>({data:{total_count:jobs.length,jobs}}))},checks:{get:vi.fn(async({check_run_id}:any)=>({data:{id:check_run_id,name:'CI Results',app:{slug:'github-actions'},head_sha:sha,status:'completed',conclusion:'success',details_url:'https://github.com/HamedMP/matrix-os/actions/runs/12/job/1'}}))}}};
 return {run,jobs,github};
}
it('independently requires every full hosted lane and genuine aggregate at the same run/attempt',async()=>{
 const f=fixture();await expect(verifyFullHostedCoverage(f.github,repo,f.run)).resolves.toEqual({hostedLaneCount:HOSTED_LANES.length});
});
it.each(['missing','skipped','failed','duplicate','attempt','head','truncated','fake-app'])('rejects incomplete or substituted hosted recovery: %s',async kind=>{
 const f=fixture();if(kind==='missing')f.jobs.splice(0,1);if(kind==='duplicate')f.jobs.push({...f.jobs[0],id:100});if(kind==='skipped')f.jobs[0].conclusion='skipped';if(kind==='failed')f.jobs[0].conclusion='failure';if(kind==='attempt')f.jobs[0].run_attempt=1;if(kind==='head')f.jobs[0].head_sha='b'.repeat(40);
 if(kind==='truncated')f.github.rest.actions.listJobsForWorkflowRun.mockImplementation(async()=>({data:{total_count:101,jobs:f.jobs}}));
 if(kind==='fake-app')f.github.rest.checks.get.mockImplementation(async()=>({data:{id:f.jobs.at(-1)!.id,name:'CI Results',app:{slug:'other'},head_sha:sha,status:'completed',conclusion:'success',details_url:'https://github.com/HamedMP/matrix-os/actions/runs/12/job/1'}}));
 await expect(verifyFullHostedCoverage(f.github,repo,f.run)).rejects.toThrow();
});
