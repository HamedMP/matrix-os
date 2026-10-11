import {describe,expect,it,vi} from "vitest";
import {nativeStackFixture,nativePins} from './helpers/native-stack-fixture';
import {waitForDedicatedResult} from "../../scripts/ci/dedicated-result.mjs";
const headSha="a".repeat(40),baseSha="b".repeat(40),sourceSha="c".repeat(40),controllerSha="d".repeat(40);
const expected={requestingRunId:321,requestingRunAttempt:1,imageDigest:"sha256:"+"e".repeat(64),harnessDigest:"f".repeat(64),mode:"delegated",owner:"HamedMP",repo:"matrix-os",headSha,baseSha,sourceSha,prNumber:2440,baseRef:"main",headRef:"feature/source",serverUrl:"https://github.com"};
function fixture(change:Record<string,unknown>={}) {
  const summary={schemaVersion:3,requestingRunId:321,requestingRunAttempt:1,imageDigest:expected.imageDigest,harnessDigest:expected.harnessDigest,mode:expected.mode,receiptVerified:true,requestDigest:"9".repeat(64),leaseId:"8".repeat(32),baseRef:"main",controllerAttempt:1,suite:"qualification",headSha,baseSha,sourceSha,prNumber:2440,controllerSha,controllerRef:"refs/heads/main",controllerWorkflow:".github/workflows/ci-dedicated.yml",...change};
  const check={id:10,name:"Dedicated CI Results",head_sha:headSha,status:"completed",conclusion:"success",app:{slug:"github-actions"},details_url:"https://github.com/HamedMP/matrix-os/actions/runs/123",output:{summary:JSON.stringify(summary)}};
  const run={id:123,head_branch:"feature/source",display_title:`dedicated-ci-v2 pr=2440 head=${headSha} base=${baseSha} requested=true`,run_attempt:1,workflow_id:99,event:"pull_request_target",path:".github/workflows/ci-dedicated.yml@main",status:"completed",conclusion:"success",head_sha:headSha,repository:{full_name:"HamedMP/matrix-os"},head_repository:{full_name:"HamedMP/matrix-os"}};
  const github={rest:{repos:{getCommit:vi.fn(async()=>({data:{sha:sourceSha,parents:[{sha:baseSha},{sha:headSha}]}}))},git:{getRef:vi.fn(async()=>({data:{object:{sha:baseSha}}}))},pulls:{get:vi.fn(async()=>({data:{number:2440,state:"open",draft:false,labels:[{name:"ready-for-ci"},{name:"ci-linux"}],head:{sha:headSha,ref:"feature/source",repo:{full_name:"HamedMP/matrix-os"}},base:{sha:baseSha,ref:"main",repo:{full_name:"HamedMP/matrix-os"}},merge_commit_sha:sourceSha}}))},checks:{listForRef:vi.fn(async()=>({data:{check_runs:[check]}}))},actions:{getWorkflow:vi.fn(async()=>({data:{id:99,path:".github/workflows/ci-dedicated.yml"}})),getWorkflowRun:vi.fn(async(_args:{run_id:number})=>({data:run})),listWorkflowRuns:vi.fn(async()=>({data:{workflow_runs:[run]}})),listWorkflowRunArtifacts:vi.fn(async()=>({data:{artifacts:[{name:`dedicated-qualification-${headSha}-${sourceSha}-${baseSha}-pr2440-request321-1-attempt1`,expired:false,size_in_bytes:1024,workflow_run:{id:123}}]}})),listJobsForWorkflowRun:vi.fn(async()=>({data:{jobs:[{name:"benchmark",status:"completed",conclusion:"success"}]}}))}}};
  return {github,check,run};
}
const options={maxAttempts:2,delay:async()=>{}};
describe("exact merge revision dedicated qualification evidence",()=>{
  it('authenticates realistic same-repository PR API metadata separately from main controller context',async()=>{
    const {github,run}=fixture();
    expect(run).toMatchObject({event:'pull_request_target',head_branch:'feature/source',head_sha:headSha,head_repository:{full_name:'HamedMP/matrix-os'}});
    expect(run.head_sha).not.toBe(controllerSha);
    await expect(waitForDedicatedResult(github,expected,options)).resolves.toEqual({runId:123,sourceSha});
  });
  it("accepts only completed default-branch controller run and qualification provenance",async()=>{
    const {github}=fixture(); await expect(waitForDedicatedResult(github,expected,options)).resolves.toEqual({runId:123,sourceSha});
  });
  it.each([{sourceSha:"e".repeat(40)},{baseSha:"e".repeat(40)},{headSha:"e".repeat(40)},{prNumber:1},{suite:"unit"},{controllerRef:"refs/heads/untrusted"},{schemaVersion:1},{baseRef:"other-parent"}])("rejects mismatched scope/revision provenance %j",async change=>{
    const {github}=fixture(change); await expect(waitForDedicatedResult(github,expected,options)).rejects.toThrow("No verified");
  });
  it.each(["workflow_id","event","path","head_sha","repository","head_repository"])("rejects an unauthenticated controller property %s",async field=>{
    const {github,run}=fixture(); Object.assign(run,{[field]:field.endsWith("repository")?{full_name:"other/repo"}:"untrusted"});
    await expect(waitForDedicatedResult(github,expected,options)).rejects.toThrow("No verified");
  });
  it("rejects check substitution from a different app or remote details URL",async()=>{
    for(const patch of [{app:{slug:"other"}},{details_url:"https://other.invalid/actions/runs/123"},{head_sha:"e".repeat(40)}]) {
      const {github,check}=fixture(); Object.assign(check,patch); await expect(waitForDedicatedResult(github,expected,options)).rejects.toThrow("No verified");
    }
  });
  it("fails on authenticated controller, dispatch job or source-check failure",async()=>{
    for(const failure of ["check","run","job"]) {
      const {github,check,run}=fixture();
      if(failure==="check") check.conclusion="failure";
      if(failure==="run")run.conclusion="failure";
      if(failure==="job")github.rest.actions.listJobsForWorkflowRun.mockResolvedValue({data:{jobs:[{name:"benchmark",status:"completed",conclusion:"failure"}]}});
      await expect(waitForDedicatedResult(github,expected,options)).rejects.toThrow("failed");
    }
  });
  it("waits for controller settlement and fails closed on missing evidence",async()=>{
    const {github,run}=fixture(); run.status="in_progress"; await expect(waitForDedicatedResult(github,expected,options)).rejects.toThrow("No verified");
    expect(github.rest.checks.listForRef).toHaveBeenCalledTimes(2);
  });
});

it('rejects checksummary spoofing without immutable same-run revision provenance',async()=>{
  for(const artifact of [undefined,{name:'wrong',expired:false,size_in_bytes:1024,workflow_run:{id:123}},{name:`dedicated-qualification-${headSha}-${sourceSha}-${baseSha}-pr2440-request321-1-attempt1`,expired:true,size_in_bytes:1024,workflow_run:{id:123}},{name:`dedicated-qualification-${headSha}-${sourceSha}-${baseSha}-pr2440-request321-1-attempt1`,expired:false,size_in_bytes:1024,workflow_run:{id:999}}]) {
    const {github}=fixture(); github.rest.actions.listWorkflowRunArtifacts.mockResolvedValue({data:{artifacts:artifact?[artifact]:[]}});
    await expect(waitForDedicatedResult(github,expected,options)).rejects.toThrow('No verified');
  }
});


describe('stack lifecycle and retry evidence',()=>{
  it('accepts arbitrary same-repository parent refs while requiring the default controller',async()=>{
    const {github}=fixture({baseRef:'feature/arbitrary-parent'});const {data:pull}=await github.rest.pulls.get();
    pull.base.ref='feature/arbitrary-parent';github.rest.pulls.get.mockResolvedValue({data:pull});
    await expect(waitForDedicatedResult(github,{...expected,baseRef:pull.base.ref},options)).resolves.toEqual({runId:123,sourceSha});
  });
  it('waits for a current rerun rather than failing on the previous failed attempt',async()=>{
    const {github,check,run}=fixture();check.conclusion='failure';run.run_attempt=2;run.status='in_progress';
    const delay=vi.fn(async()=>{
      check.output.summary=JSON.stringify({...JSON.parse(check.output.summary),controllerAttempt:2});
      check.conclusion='success';run.status='completed';
      github.rest.actions.listWorkflowRunArtifacts.mockResolvedValue({data:{artifacts:[{name:`dedicated-qualification-${headSha}-${sourceSha}-${baseSha}-pr2440-request321-1-attempt2`,expired:false,size_in_bytes:1024,workflow_run:{id:123}}]}});
    });
    await expect(waitForDedicatedResult(github,expected,{maxAttempts:2,delay})).resolves.toEqual({runId:123,sourceSha});
    expect(delay).toHaveBeenCalledOnce();
  });
  it('rejects a changed live candidate branch even when its commit is unchanged',async()=>{
    const {github}=fixture();const {data:pull}=await github.rest.pulls.get();pull.head.ref='other-candidate';
    github.rest.pulls.get.mockResolvedValue({data:pull});
    await expect(waitForDedicatedResult(github,expected,options)).rejects.toThrow(/stale/);
  });
  it('rejects a live parent move even when old authenticated evidence passed',async()=>{
    const {github}=fixture();const {data:pull}=await github.rest.pulls.get();pull.base.sha='e'.repeat(40);
    github.rest.pulls.get.mockResolvedValue({data:pull});
    await expect(waitForDedicatedResult(github,expected,options)).rejects.toThrow(/stale/);
  });
  it('revalidates the live tuple immediately before accepting success',async()=>{
    const {github}=fixture();const {data:pull}=await github.rest.pulls.get();
    github.rest.pulls.get.mockResolvedValueOnce({data:pull}).mockResolvedValue({data:{...pull,base:{...pull.base,ref:'retargeted'}}});
    await expect(waitForDedicatedResult(github,expected,options)).rejects.toThrow(/stale/);
  });
  it('ignores an older failed result while the newest authenticated controller is pending',async()=>{
    const {github,check,run}=fixture();const pending={...check,id:11,status:'in_progress',details_url:'https://github.com/HamedMP/matrix-os/actions/runs/124'};
    github.rest.checks.listForRef.mockResolvedValue({data:{check_runs:[{...check,conclusion:'failure'},pending]}});
    github.rest.actions.listWorkflowRuns.mockImplementation(async()=>({data:{workflow_runs:[run,{...run,id:124,status:pending.status==='completed'?'completed':'in_progress'}]}}));
    github.rest.actions.getWorkflowRun.mockImplementation(async ({run_id}: {run_id:number})=>({data:run_id===123?{...run,conclusion:'failure'}:{...run,id:124,status:pending.status==='completed'?'completed':'in_progress'}}));
    github.rest.actions.listWorkflowRunArtifacts.mockResolvedValue({data:{artifacts:[{name:`dedicated-qualification-${headSha}-${sourceSha}-${baseSha}-pr2440-request321-1-attempt1`,expired:false,size_in_bytes:1024,workflow_run:{id:124}}]}});
    const delay=vi.fn(async()=>{pending.status='completed';});
    await expect(waitForDedicatedResult(github,expected,{maxAttempts:2,delay})).resolves.toEqual({runId:124,sourceSha});
    expect(delay).toHaveBeenCalledOnce();
  });
  it('does not let an older successful controller hide the newest failure',async()=>{
    const {github,check,run}=fixture();const latest={...check,id:11,conclusion:'failure',details_url:'https://github.com/HamedMP/matrix-os/actions/runs/124'};
    github.rest.checks.listForRef.mockResolvedValue({data:{check_runs:[check,latest]}});
    github.rest.actions.listWorkflowRuns.mockResolvedValue({data:{workflow_runs:[run,{...run,id:124,conclusion:'failure'}]}});
    github.rest.actions.getWorkflowRun.mockImplementation(async ({run_id}: {run_id:number})=>({data:{...run,id:run_id,conclusion:run_id===124?'failure':'success'}}));
    await expect(waitForDedicatedResult(github,expected,options)).rejects.toThrow(/failed/);
  });
  it('accepts only the current rerun attempt and its immutable artifact',async()=>{
    const {github,check,run}=fixture({controllerAttempt:2});run.run_attempt=2;
    github.rest.actions.listWorkflowRunArtifacts.mockResolvedValue({data:{artifacts:[{name:`dedicated-qualification-${headSha}-${sourceSha}-${baseSha}-pr2440-request321-1-attempt2`,expired:false,size_in_bytes:1024,workflow_run:{id:123}}]}});
    await expect(waitForDedicatedResult(github,expected,options)).resolves.toEqual({runId:123,sourceSha});
    run.run_attempt=3;
    await expect(waitForDedicatedResult(github,expected,options)).rejects.toThrow('No verified');
    expect(check.status).toBe('completed');
  });
  it.each(['skipped','cancelled','failure'])('fails closed on latest dispatcher %s',async conclusion=>{
    const {github}=fixture();github.rest.actions.listJobsForWorkflowRun.mockResolvedValue({data:{jobs:[{name:'benchmark',status:'completed',conclusion}]}});
    await expect(waitForDedicatedResult(github,expected,options)).rejects.toThrow(/failed/);
  });
});

describe('pre-admission default-controller retry coordination',()=>{
  it('does not settle an older failure while a newer queued request has no check yet',async()=>{
    const {github,check,run}=fixture();check.conclusion='failure';run.conclusion='failure';
    const queued={...run,id:124,status:'queued',conclusion:'success'};
    github.rest.actions.listWorkflowRuns.mockResolvedValue({data:{workflow_runs:[run,queued]}});
    github.rest.actions.getWorkflowRun.mockImplementation(async({run_id})=>({data:run_id===124?queued:run}));
    const delay=vi.fn(async()=>{
      queued.status='completed';
      github.rest.checks.listForRef.mockResolvedValue({data:{check_runs:[check,{...check,id:11,conclusion:'success',details_url:'https://github.com/HamedMP/matrix-os/actions/runs/124'}]}});
      github.rest.actions.listWorkflowRunArtifacts.mockResolvedValue({data:{artifacts:[{name:`dedicated-qualification-${headSha}-${sourceSha}-${baseSha}-pr2440-request321-1-attempt1`,expired:false,size_in_bytes:1024,workflow_run:{id:124}}]}});
    });
    await expect(waitForDedicatedResult(github,expected,{maxAttempts:2,delay})).resolves.toEqual({runId:124,sourceSha});
    expect(delay).toHaveBeenCalledOnce();
  });
  it('never accepts older success while a newer queued request has not admitted',async()=>{
    const {github,run}=fixture();github.rest.actions.listWorkflowRuns.mockResolvedValue({data:{workflow_runs:[run,{...run,id:124,status:'queued'}]}});
    await expect(waitForDedicatedResult(github,expected,options)).rejects.toThrow('No verified');
  });
  it('fails closed on a newer failed controller before it created any check',async()=>{
    const {github,run}=fixture();github.rest.actions.listWorkflowRuns.mockResolvedValue({data:{workflow_runs:[run,{...run,id:124,conclusion:'failure'}]}});
    await expect(waitForDedicatedResult(github,expected,options)).rejects.toThrow(/failed/);
  });
  it.each(['workflow_id','event','path','head_branch','head_sha','repository','head_repository','display_title'])('rejects pre-admission metadata substitution for %s',async field=>{
    const {github,run}=fixture();const malicious={...run,id:124,[field]:field.endsWith('repository')?{full_name:'other/repo'}:'untrusted'};
    github.rest.actions.listWorkflowRuns.mockResolvedValue({data:{workflow_runs:[run,malicious]}});
    await expect(waitForDedicatedResult(github,expected,options)).resolves.toEqual({runId:123,sourceSha});
  });
  it.each([
    `dedicated-ci-v2 pr=1 head=${headSha} base=${baseSha} requested=true`,
    `dedicated-ci-v2 pr=2440 head=${'e'.repeat(40)} base=${baseSha} requested=true`,
    `dedicated-ci-v2 pr=2440 head=${headSha} base=${'e'.repeat(40)} requested=true`,
    `dedicated-ci-v2 pr=2440 head=${headSha} base=${baseSha} requested=false`,
  ])('does not let a different tuple or irrelevant event block this PR (%s)',async display_title=>{
    const {github,run}=fixture();github.rest.actions.listWorkflowRuns.mockResolvedValue({data:{workflow_runs:[run,{...run,id:124,status:'queued',display_title}]}});
    await expect(waitForDedicatedResult(github,expected,options)).resolves.toEqual({runId:123,sourceSha});
  });
  it('scans bounded metadata pages before selecting the newest matching request',async()=>{
    const {github,run}=fixture();let calls=0;
    github.rest.actions.listWorkflowRuns.mockImplementation(async()=>({data:{workflow_runs:++calls%2===1?Array.from({length:100},(_,index)=>({...run,id:200+index,display_title:'different request'})):[run]}}));
    await expect(waitForDedicatedResult(github,expected,options)).resolves.toEqual({runId:123,sourceSha});
    expect(github.rest.actions.listWorkflowRuns.mock.calls.every(([args]:any[])=>args.page<=3&&['workflow_run','pull_request_target'].includes(args.event))).toBe(true);
  });
  it('rechecks newest request identity immediately before accepting old success',async()=>{
    const {github,run}=fixture();github.rest.actions.listWorkflowRuns.mockResolvedValueOnce({data:{workflow_runs:[run]}})
      .mockResolvedValue({data:{workflow_runs:[run,{...run,id:124,status:'queued'}]}});
    await expect(waitForDedicatedResult(github,expected,options)).rejects.toThrow('No verified');
  });
  it('caps source request discovery at three pages per poll',async()=>{
    const {github,run}=fixture();github.rest.actions.listWorkflowRuns.mockResolvedValue({data:{workflow_runs:Array.from({length:100},(_,index)=>({...run,id:200+index,display_title:'other source request'}))}});
    await expect(waitForDedicatedResult(github,expected,{maxAttempts:1,delay:async()=>{}})).rejects.toThrow('history exceeds bounded coverage');
    expect(Math.max(...github.rest.actions.listWorkflowRuns.mock.calls.map(([args]:any[])=>args.page))).toBe(3);expect(github.rest.actions.listWorkflowRuns.mock.calls.length).toBeLessThanOrEqual(9);
  });
  it('does not let an arbitrary workflow check impersonate the default controller',async()=>{
    const {github,check}=fixture();check.details_url='https://github.com/HamedMP/matrix-os/actions/runs/999';
    // Copying the marker, app slug and trusted-looking summary cannot transfer
    // artifact/job ownership from run 999 to the registered controller run 123.
    await expect(waitForDedicatedResult(github,expected,options)).rejects.toThrow('No verified');
    expect(github.rest.actions.getWorkflowRun).not.toHaveBeenCalled();
    expect(github.rest.actions.listWorkflowRunArtifacts).not.toHaveBeenCalled();
  });
  it('fails closed on workflow-run API denial rather than settling older evidence',async()=>{
    const {github}=fixture();github.rest.actions.listWorkflowRuns.mockRejectedValue(new Error('Workflow API denied'));
    await expect(waitForDedicatedResult(github,expected,options)).rejects.toThrow('Workflow API denied');
  });
});
it('bounds the whole waiter even if an API promise never settles',async()=>{
 vi.useFakeTimers();try{const {github}=fixture();github.rest.actions.getWorkflow.mockImplementation(()=>new Promise(()=>{}));const pending=waitForDedicatedResult(github,expected,{maxAttempts:2,maxMilliseconds:10});pending.catch(()=>{});await vi.advanceTimersByTimeAsync(11);await expect(pending).rejects.toThrow(/bounded wait/);}finally{vi.useRealTimers();}
});
it('accepts established newest provenance without rejecting total retained history',async()=>{
 const {github,run}=fixture();github.rest.actions.listWorkflowRuns.mockResolvedValue({data:{workflow_runs:[run,...Array.from({length:99},(_,index)=>({...run,id:200+index,display_title:'other request'}))]}});
 await expect(waitForDedicatedResult(github,expected,{maxAttempts:1})).resolves.toEqual({runId:123,sourceSha});
});

it('settles current result without rejecting unrelated retained run history',async()=>{
 const f=fixture();f.github.rest.actions.listWorkflowRuns.mockResolvedValue({data:{workflow_runs:[f.run,...Array.from({length:99},(_,i)=>({...f.run,id:i+1,display_title:'unrelated retained schedule',event:'schedule'}))]}});
 await expect(waitForDedicatedResult(f.github,expected,{maxAttempts:1})).resolves.toEqual({runId:123,sourceSha});
});

it('authenticates the native current public cumulative source through final waiter settlement',async()=>{
 const f=fixture(),native=nativeStackFixture();
 Object.assign(f.github.rest,{repos:native.github.rest.repos,git:native.github.rest.git,pulls:native.github.rest.pulls});
 const github={...f.github,request:native.github.request};
 const scope={...expected,...native.snapshot};
 Object.assign(f.run,{head_sha:nativePins.head,head_branch:native.pull.head.ref,display_title:`dedicated-ci-v2 pr=2491 head=${nativePins.head} base=${nativePins.base} requested=true`});
 f.check.head_sha=nativePins.head;
 f.check.output.summary=JSON.stringify({...JSON.parse(f.check.output.summary),...native.snapshot});
 f.github.rest.actions.listWorkflowRunArtifacts.mockResolvedValue({data:{artifacts:[{name:`dedicated-qualification-${nativePins.head}-${nativePins.merge}-${nativePins.base}-pr2491-request321-1-attempt1`,expired:false,size_in_bytes:1024,workflow_run:{id:123}}]}});
 await expect(waitForDedicatedResult(github,scope,options)).resolves.toEqual({runId:123,sourceSha:nativePins.merge});
 expect(native.github.request).toHaveBeenCalledTimes(4); // initial and final independent native proofs
});

it.each(['completed','in_progress'])('ignores newer reconciliation-only %s controller during accepted ordinary settlement',async status=>{
 const f=fixture();const extra={...f.run,id:124,event:'workflow_run',head_branch:'main',head_sha:controllerSha,status,display_title:`dedicated-refresh-v2 execution=false request=321 title=CI coverage-v1 · ${sourceSha}`};
 f.github.rest.actions.listWorkflowRuns.mockResolvedValue({data:{workflow_runs:[extra,f.run]}});
 await expect(waitForDedicatedResult(f.github,expected,options)).resolves.toEqual({runId:123,sourceSha});
});
