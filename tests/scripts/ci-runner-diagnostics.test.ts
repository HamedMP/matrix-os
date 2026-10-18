import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function python(body: string) {
  const result = spawnSync("python3", ["-I", "-c", `import sys\nsys.dont_write_bytecode=True\nsys.path.insert(0,${JSON.stringify(resolve("scripts/ci/runner"))})\nsys.path.insert(0,${JSON.stringify(resolve("scripts/ci/qualification"))})\n${body}`], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 128 * 1024,
  });
  expect(result.status, result.stderr || result.stdout).toBe(0);
}

const fixture = `
import tempfile,json,subprocess,hashlib,os
from pathlib import Path
from lease_diagnostics import sample_memory,create_diagnostics
from contract import PHASES
limit=112*1024**3
lease='1'*32;digest='2'*64;name='matrix-ci-lease-'+lease
def identity():
 return dict(Id='3'*64,Config=dict(Labels={'matrix-ci.lease':lease,'matrix-ci.request':digest,'matrix-ci.disposable':'true'}),State=dict(Running=True,Pid=123))
def executor(args,**kwargs):
 assert args==['docker','inspect',name]
 assert kwargs['timeout']==5 and kwargs['cap']<=65536
 return subprocess.CompletedProcess(args,0,json.dumps([identity()]).encode(),b'')
def filesystem(root):
 proc=root/'proc';cg=root/'cgroup';(proc/'123').mkdir(parents=True);cg.mkdir()
 (proc/'123'/'cgroup').write_text('0::/system.slice/docker.scope\\n')
 group=cg/'system.slice'/'docker.scope';group.mkdir(parents=True)
 (group/'memory.peak').write_text('123456789\\n');(group/'memory.max').write_text(str(limit)+'\\n')
 (group/'memory.swap.peak').write_text('0\\n');(group/'memory.events').write_text('low 0\\nhigh 0\\nmax 0\\noom 1\\noom_kill 0\\noom_group_kill 0\\n')
 return proc,cg,group
receipt=dict(schemaVersion=1,leaseId=lease,requestDigest=digest,sourceSha='a'*40,imageDigest='sha256:'+'b'*64,harnessDigest='c'*64,queueSeconds=9,wallSeconds=100,startedUtc='2026-10-18T12:00:00Z',finishedUtc='2026-10-18T12:01:40Z')
phases={label:1 for labels in PHASES.values() for label in labels}
proof=dict(phasesSeconds=phases)
`;

describe("root-owned qualification diagnostics", () => {
  it("reads the exact owned container's cgroup peak, limit and OOM counters without candidate commands", () => python(`${fixture}
with tempfile.TemporaryDirectory() as td:
 proc,cg,group=filesystem(Path(td))
 value=sample_memory(executor,name,lease,digest,limit,proc_root=proc,cgroup_root=cg)
 assert value==dict(status='available',measurement='cgroup-v2',peakBytes=123456789,limitBytes=limit,swapPeakBytes=0,events=dict(oom=1,oomKill=0)),value
 (group/'memory.swap.peak').unlink()
 assert sample_memory(executor,name,lease,digest,limit,proc_root=proc,cgroup_root=cg)['swapPeakBytes'] is None
`));

  it.each(["lease", "request", "pid", "running", "reused-pid"])("refuses %s container identity before reporting memory", kind => python(`${fixture}
with tempfile.TemporaryDirectory() as td:
 proc,cg,group=filesystem(Path(td));calls=[]
 def bad(args,**kwargs):
  row=identity();calls.append(args)
  if ${JSON.stringify(kind)}=='lease':row['Config']['Labels']['matrix-ci.lease']='9'*32
  if ${JSON.stringify(kind)}=='request':row['Config']['Labels']['matrix-ci.request']='9'*64
  if ${JSON.stringify(kind)}=='pid':row['State']['Pid']=0
  if ${JSON.stringify(kind)}=='reused-pid' and len(calls)>1:row['State']['Pid']=999
  if ${JSON.stringify(kind)}=='running':row['State']['Running']=False
  return subprocess.CompletedProcess(args,0,json.dumps([row]).encode(),b'')
 value=sample_memory(bad,name,lease,digest,limit,proc_root=proc,cgroup_root=cg)
 assert value==dict(status='unavailable',reason='container_identity_mismatch'),value
`));

  it.each(["traversal", "symlink", "oversize", "negative", "wrong-limit", "v1", "duplicate-counter"])("bounds and sanitizes %s memory evidence", kind => python(`${fixture}
with tempfile.TemporaryDirectory() as td:
 root=Path(td);proc,cg,group=filesystem(root)
 if ${JSON.stringify(kind)}=='traversal':(proc/'123'/'cgroup').write_text('0::/../outside\\n')
 if ${JSON.stringify(kind)}=='symlink':
  outside=root/'outside';group.rename(outside);group.symlink_to(outside,target_is_directory=True)
 if ${JSON.stringify(kind)}=='oversize':(group/'memory.peak').write_text('9'*8192)
 if ${JSON.stringify(kind)}=='negative':(group/'memory.peak').write_text('-1')
 if ${JSON.stringify(kind)}=='wrong-limit':(group/'memory.max').write_text('4096')
 if ${JSON.stringify(kind)}=='v1':(proc/'123'/'cgroup').write_text('7:memory:/docker/abc\\n')
 if ${JSON.stringify(kind)}=='duplicate-counter':(group/'memory.events').write_text('oom 0\\noom 1\\noom_kill 0\\n')
 value=sample_memory(executor,name,lease,digest,limit,proc_root=proc,cgroup_root=cg)
 assert value['status']=='unavailable' and set(value)=={'status','reason'},value
 assert '/' not in json.dumps(value) and 'outside' not in json.dumps(value)
`));

  it("exports all validated phases and binds diagnostics to the original unchanged receipt", () => python(`${fixture}
with tempfile.TemporaryDirectory() as td:
 root=Path(td);before=json.dumps(receipt,sort_keys=True,separators=(',',':'))
 value=create_diagnostics(receipt,proof,root)
 assert value['schemaVersion']==1 and value['kind']=='qualification-diagnostics'
 assert value['phaseSeconds']==phases and len(value['phaseSeconds'])==55
 assert value['phaseTimeline'] is None and value['memory']['status']=='unavailable'
 assert value['receiptSha256']==hashlib.sha256(before.encode()).hexdigest()
 assert value['requestDigest']==digest and value['leaseId']==lease and value['sourceSha']==receipt['sourceSha']
 assert json.dumps(receipt,sort_keys=True,separators=(',',':'))==before
 assert len(json.dumps(value).encode())<16384
`));

  it("retains complete bounded phase intervals for identifying lane overlap", () => python(`${fixture}
with tempfile.TemporaryDirectory() as td:
 root=Path(td);start=1792324800000
 for lane,labels in PHASES.items():
  (root/('timeline-'+lane+'.tsv')).write_text(''.join(f'{label}\\t{start}\\t{start+1000}\\n' for label in labels))
 value=create_diagnostics(receipt,proof,root)
 assert len(value['phaseTimeline'])==55,value
 assert all(v==dict(startedUnixMs=start,finishedUnixMs=start+1000) for v in value['phaseTimeline'].values())
 # Timeline corruption is unavailable diagnostic data, never repaired into coverage.
 (root/'timeline-unit.tsv').write_text('unit\\t-1\\t0\\n')
 assert create_diagnostics(receipt,proof,root)['phaseTimeline'] is None
`));

  it("rejects an incomplete or nonfinite phase map instead of inventing successful timings", () => python(`${fixture}
with tempfile.TemporaryDirectory() as td:
 for invalid in ({},dict(phases,unit=-1),dict(phases,unit=float('nan')),dict(phases,unexpected=1)):
  try:create_diagnostics(receipt,dict(phasesSeconds=invalid),Path(td))
  except ValueError:pass
  else:raise AssertionError('invalid validated phase timings accepted')
`));
});
