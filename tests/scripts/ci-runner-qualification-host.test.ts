import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
function python(body:string){const result=spawnSync('python3',['-I','-c',`import sys\nsys.dont_write_bytecode=True\nsys.path.insert(0,${JSON.stringify(resolve('scripts/ci/runner'))})\n${body}`],{encoding:'utf8',timeout:10000});expect(result.status,result.stderr||result.stdout).toBe(0);}
const fixture=`
from qualification_host import QualificationHost,copy_member
from lease_contract import LIMITS
import tempfile,json,subprocess,io,tarfile,os
from pathlib import Path
request=dict(repository='HamedMP/matrix-os',prNumber=2454,headSha='a'*40,baseSha='b'*40,baseRef='codex/parent',mergeSha='c'*40,mergeParents=['b'*40,'a'*40],requestingRunId=101,requestingRunAttempt=1,controllerRunId=202,controllerRunAttempt=1,controllerSha='d'*40,controllerRef='refs/heads/main',controllerWorkflow='.github/workflows/ci-dedicated.yml',imageDigest='sha256:'+'e'*64,harnessDigest='f'*64,mode='shadow',suite='qualification',limits=dict(LIMITS))
`;
describe('root-owned disposable qualification host',()=>{
 it('retains the trusted admission timestamp across delayed allocation and child reconstruction',()=>python(`${fixture}
from unittest.mock import patch
admitted=1767225600.25
with tempfile.TemporaryDirectory() as td:
 with patch('qualification_host.time.time',return_value=admitted+600):
  host=QualificationHost(Path(td),'1'*32,request,queue_started_epoch=admitted)
  queued=json.loads((host.lease_dir/'queued.json').read_text())
  assert queued==dict(queueStartedUtc='2026-01-01T00:00:00Z',queueStartedEpoch=admitted),queued
 with patch('qualification_host.time.time',return_value=admitted+900):
  child=QualificationHost(Path(td),'1'*32,request)
  assert json.loads((child.lease_dir/'queued.json').read_text())==queued
`));
 it('pins nonroot isolation and approved quotas without mount, secret or caller resource overrides',()=>python(`${fixture}
with tempfile.TemporaryDirectory() as td:
 host=QualificationHost(Path(td),'1'*32,request)
 args=host.create_args();joined=' '.join(args)
 for text in ('--user 10001:10001','--cpus 30','--memory 112g','--memory-swap 112g','--pids-limit 4096','--shm-size 2g','--read-only','--cap-drop ALL','--security-opt no-new-privileges:true','--network matrix-ci','size=64g','size=8g','size=1g',request['imageDigest']):assert text in joined,text
 for forbidden in ('--privileged','--mount','--volume','docker.sock','--network host','GITHUB_TOKEN','capability'):assert forbidden not in joined
 assert '--label' in args and 'matrix-ci.lease='+'1'*32 in args
`));
 it('refuses leftover containers before any new candidate and cleans only the exact owned lease',()=>python(`${fixture}
with tempfile.TemporaryDirectory() as td:
 calls=[]
 def fake(args,**kw):
  calls.append(args)
  output=b'leftover\\n' if args[:4]==['docker','container','ls','-a'] else b''
  return subprocess.CompletedProcess(args,0,output,b'')
 host=QualificationHost(Path(td),'1'*32,request,execute=fake)
 try:host.no_leftovers()
 except ValueError:pass
 else:raise AssertionError('replacement CPU admitted')
 assert not any('create' in a for a in calls)
 def wrong(args,**kw):return subprocess.CompletedProcess(args,0,json.dumps([{'Id':'0'*64,'Config':{'Labels':{'matrix-ci.lease':'9'*32}}}]).encode(),b'')
 host.execute=wrong;assert host.cleanup() is False
`));
  it.each([[42,true,0,false],[0,false,0,false],[0,true,42,false],[0,true,42,true]])("measures icons independently and remains failed for benchmark=%i web=%s smoke=%i",(benchmarkStatus,webReady,smokeStatus,native)=>python(`${fixture}
${native ? "request['mergeParents'][0]='0'*40" : ""}
import types,datetime
from qualification_host import write_json,utc
manifest=dict(source=request['mergeSha'],tree='0'*40,parents=request['mergeParents'],lockSha256='0'*64,tracked='x'*(1024*1024+200))
sys.modules['manifest']=types.SimpleNamespace(check_manifest=lambda value,req:value)
sys.modules['contract']=types.SimpleNamespace(ARTIFACTS=('unit.json','trace','timing-smoke.tsv'))
sys.modules['validate']=types.SimpleNamespace(web_phase_ready=lambda result,inventory:${webReady ? 'True' : 'False'})
with tempfile.TemporaryDirectory() as td:
 calls=[]
 def tar(name):
  out=io.BytesIO()
  with tarfile.open(fileobj=out,mode='w') as a:
   e=tarfile.TarInfo(name);e.size=2;a.addfile(e,io.BytesIO(b'{}'))
  return out.getvalue()
 def fake(args,**kw):
  calls.append(args);output=b'';status=0
  if args[1]=='create':output=b'0'*64+b'\\n'
  elif '--prepare-public' in args:
   assert kw['cap']>=2*1024*1024;assert args[-3:]==[request['mergeSha'],request['mergeParents'][0],request['headSha']];output=json.dumps(manifest).encode()
  elif '/usr/bin/tee' in args:output=kw['data']
  elif '/opt/matrix-ci/qualification/benchmark.sh' in args:status=${benchmarkStatus};output=b'unit diagnostic'
  elif '/opt/matrix-ci/qualification/smoke.mjs' in args:status=${smokeStatus};output=b'{}'
  elif '/usr/bin/tar' in args:output=tar(args[-1])
  elif '--host-final-check' in args:output=json.dumps(dict(clean=True,lane=args[-1],source=request['mergeSha'],inventorySha256=args[-3])).encode()
  return subprocess.CompletedProcess(args,status,output,b'')
 host=QualificationHost(Path(td),'1'*32,request,execute=fake);host.cleanup=lambda:True
 now=utc();write_json(host.lease_dir/'started.json',dict(startedUtc=now,startedEpoch=__import__('time').time(),queueStartedUtc=now,queueSeconds=0))
 assert host.run()!=0
 ran=any('/opt/matrix-ci/qualification/smoke.mjs' in args for args in calls)
 assert ran==${webReady ? 'True' : 'False'}
 assert (host.result/'exit-code').read_text().strip()!='0'
 assert (host.result/'timing-smoke.tsv').is_file()
 assert not any(args[-1]=='trace' and '/work/results' in args for args in calls)
 assert not any('git'==args[0] for args in calls)
 probes=[i for i,args in enumerate(calls) if '--host-final-check' in args]
 assert len(probes)==4 and [calls[i][-1] for i in probes]==['unit','mechanical','web','e2e']
 if ran:assert min(probes)>next(i for i,args in enumerate(calls) if '/opt/matrix-ci/qualification/smoke.mjs' in args)
`));
 it.each([null,'mechanical'])('obtains four independent trusted source proofs and fails closed for dirty lane=%s',(dirtyLane)=>python(`${fixture}
with tempfile.TemporaryDirectory() as td:
 calls=[];digest='f'*64
 def fake(args,**kw):
  calls.append(args);lane=args[-1]
  assert args[:4]==['docker','exec','--user','10001:10001']
  assert args[5:]==['/usr/bin/python3','-I','/opt/matrix-ci/qualification/source.py',request['mergeSha'],'/work/qualification-input.json',digest,'--host-final-check',lane]
  assert kw['timeout']==120 and kw['cap']<=320*1024
  proof=dict(source=request['mergeSha'],lane=lane,inventorySha256=digest,clean=lane!=${dirtyLane ? JSON.stringify(dirtyLane) : 'None'})
  return subprocess.CompletedProcess(args,0,json.dumps(proof).encode(),b'')
 host=QualificationHost(Path(td),'1'*32,request,execute=fake)
 assert host.final_source_checks(digest)==${dirtyLane ? 'False' : 'True'}
 assert [a[-1] for a in calls]==['unit','mechanical','web','e2e']
 for lane in ('unit','mechanical','web','e2e'):
  proof=json.loads((host.result/('host-source-'+lane+'.json')).read_bytes())
  assert proof['lane']==lane and proof['source']==request['mergeSha']
 # Candidate-created files cannot substitute the independent fixed-path probes.
 calls.clear();host.collect(['host-source-unit.json']);assert calls==[]
`));
 it('accepts exactly one bounded named regular TAR member and rejects links, duplicates and unexpected paths',()=>python(`${fixture}
def archive(kind='file',extra=False,name='unit.json'):
 out=io.BytesIO()
 with tarfile.open(fileobj=out,mode='w') as tar:
  e=tarfile.TarInfo(name);e.size=2
  if kind=='link':e.type=tarfile.SYMTYPE;e.linkname='/etc/passwd';e.size=0
  tar.addfile(e,io.BytesIO(b'{}') if kind=='file' else None)
  if extra:tar.addfile(tarfile.TarInfo('second'),io.BytesIO())
 return out.getvalue()
with tempfile.TemporaryDirectory() as td:
 root=Path(td);copy_member(archive(),root/'valid','unit.json');assert (root/'valid').read_bytes()==b'{}'
 for i,data in enumerate((archive('link'),archive(extra=True),archive(name='../unit.json'))):
  p=root/str(i)
  try:copy_member(data,p,'unit.json')
  except ValueError:pass
  else:raise AssertionError('invalid archive accepted')
  assert not p.exists()
`));
});
