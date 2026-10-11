import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve("scripts/ci/runner");
function python(body: string) {
  const result = spawnSync("python3", ["-I", "-c", `import sys\nsys.dont_write_bytecode=True\nsys.path.insert(0,${JSON.stringify(root)})\n${body}`], { encoding: "utf8", timeout: 20_000 });
  expect(result.status, result.stderr || result.stdout).toBe(0);
}
const fixture = `
import json,os,sys,tempfile,subprocess,select,time,fcntl,hashlib
from pathlib import Path
from lease_contract import LIMITS,canonical_digest
from lease_store import LeaseStore
request=dict(repository='HamedMP/matrix-os',prNumber=2454,headSha='a'*40,baseSha='b'*40,baseRef='codex/parent',mergeSha='c'*40,mergeParents=['b'*40,'a'*40],requestingRunId=101,requestingRunAttempt=1,controllerRunId=202,controllerRunAttempt=1,controllerSha='d'*40,controllerRef='refs/heads/main',controllerWorkflow='.github/workflows/ci-dedicated.yml',imageDigest='sha256:'+'e'*64,harnessDigest='f'*64,mode='shadow',suite='qualification',limits=dict(LIMITS))
envelope=dict(protocolVersion=1,leaseId='1'*32,capability='2'*64,request=request)
config=dict(repository='HamedMP/matrix-os',controllerShas=['d'*40],imageDigest=request['imageDigest'],harnessDigest=request['harnessDigest'],modes=['shadow','delegated'])

def start(root,fail_cleanup=False):
 command="import sys,time;open(sys.argv[1],'w').write('started');time.sleep(60)"
 script="import sys,json;from pathlib import Path;from lease_manager import LeaseManager;envelope=json.loads(sys.stdin.readline());config=json.loads(sys.stdin.readline());m=LeaseManager(envelope,config,Path(sys.argv[1]),[sys.executable,'-c',sys.argv[2],sys.argv[3]],cleanup=lambda: "+('False' if fail_cleanup else 'True')+",verify=lambda:dict(qualified=True));sys.exit(m.run())"
 proc=subprocess.Popen([sys.executable,'-I','-c','import sys;sys.dont_write_bytecode=True;sys.path.insert(0,'+repr(sys.path[0])+');'+script,str(root),command,str(root/'started')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,bufsize=0)
 proc.stdin.write((json.dumps(envelope)+'\\n'+json.dumps(config)+'\\n').encode());proc.stdin.flush();return proc

def record(proc):
 data=b'';deadline=time.monotonic()+5
 while not data.endswith(b'\\n'):
  ready,_,_=select.select([proc.stdout],[],[],max(0,deadline-time.monotonic()));assert ready,'control record timed out'
  part=os.read(proc.stdout.fileno(),1);assert part,'unexpected control EOF';data+=part;assert len(data)<=32768
 return json.loads(data)
def grant(proc,locked,challenge=None):
 value=dict(protocolVersion=1,type='grant',leaseId=envelope['leaseId'],requestDigest=canonical_digest(request),challenge=challenge or locked['challenge'],capability=envelope['capability'])
 proc.stdin.write((json.dumps(value)+'\\n').encode());proc.stdin.flush()
def cleanup(proc):
 if proc.poll() is None:
  proc.stdin.close();proc.wait(timeout=8)
`;

describe("live owned remote lease manager", () => {
  it("requires a valid after-lock grant before allocating candidate CPU and kills on EOF", () => python(`${fixture}
with tempfile.TemporaryDirectory() as td:
 root=Path(td);proc=start(root)
 try:
  assert record(proc)['type']=='queued';locked=record(proc);assert locked['type']=='locked'
  assert not (root/'started').exists()
  grant(proc,locked);assert record(proc)['type']=='running'
  deadline=time.monotonic()+3
  while not (root/'started').exists() and time.monotonic()<deadline:time.sleep(.02)
  assert (root/'started').exists();proc.stdin.close();proc.wait(timeout=8)
  terminal=record(proc);assert terminal['type']=='cancelled' and terminal['status']!=0
  assert envelope['capability'] not in json.dumps(terminal)
  with open(root/'benchmark.lock','a') as lock:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 finally:cleanup(proc)
`));
  it("rejects a stale challenge after lock without starting candidate code", () => python(`${fixture}
with tempfile.TemporaryDirectory() as td:
 root=Path(td);proc=start(root)
 try:
  record(proc);locked=record(proc);grant(proc,locked,'9'*64)
  terminal=record(proc);assert terminal['type']=='failed';proc.wait(timeout=8)
  assert not (root/'started').exists()
 finally:cleanup(proc)
`));
  it("cancels a queued request while preserving another real OS lock owner", () => python(`${fixture}
with tempfile.TemporaryDirectory() as td:
 root=Path(td)
 with open(root/'benchmark.lock','a') as lock:
  fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);proc=start(root)
  try:
   assert record(proc)['type']=='queued'
   LeaseStore(root/'leases').cancel(envelope['leaseId'],envelope['capability'],canonical_digest(request))
   assert record(proc)['type']=='cancelled';proc.wait(timeout=8)
   assert not (root/'started').exists()
   # The unrelated owner's lock is still held by this exact descriptor.
   fd=os.open(root/'benchmark.lock',os.O_RDWR)
   try:
    try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:pass
    else:raise AssertionError('other owner lock was released')
   finally:os.close(fd)
  finally:cleanup(proc)
`));
  it("does not let a different capability cancel the active owner", () => python(`${fixture}
with tempfile.TemporaryDirectory() as td:
 root=Path(td);proc=start(root)
 try:
  record(proc);locked=record(proc);grant(proc,locked);assert record(proc)['type']=='running'
  try:LeaseStore(root/'leases').cancel(envelope['leaseId'],'9'*64,canonical_digest(request))
  except ValueError:pass
  else:raise AssertionError('other owner cancelled')
  assert proc.poll() is None
  LeaseStore(root/'leases').cancel(envelope['leaseId'],envelope['capability'],canonical_digest(request))
  assert record(proc)['type']=='cancelled';proc.wait(timeout=8)
 finally:cleanup(proc)
`));
  it("expires a live owned process without renewal and never accepts the old grant as a heartbeat", () => python(`${fixture}
from lease_manager import LeaseManager
from lease_protocol import LeaseProtocol
clock=[0.0];protocol=LeaseProtocol(envelope,now=lambda:clock[0])
class Pipe:
 def __init__(self):self.eof=False;self.records=[];self.granted=False;self.running=False
 def emit(self,value):self.records.append(value);self.running=self.running or value['type']=='running'
 def poll(self):
  if self.running:clock[0]=121;return []
  if protocol.pending and not self.granted:
   self.granted=True
   return [dict(protocolVersion=1,type='grant',leaseId=envelope['leaseId'],requestDigest=canonical_digest(request),challenge=protocol.pending,capability=envelope['capability'])]
  return []
with tempfile.TemporaryDirectory() as td:
 pipe=Pipe();manager=LeaseManager(envelope,config,Path(td),[sys.executable,'-c','import time;time.sleep(60)'],cleanup=lambda:True,verify=lambda:dict(qualified=True),pipe=pipe,protocol=protocol)
 assert manager.run()!=0 and manager.child.process.poll() is not None
 assert pipe.records[-1]['type']=='cancelled'
`));
  it("rejects a cancellation arriving during root evidence verification before emitting completion", () => python(`${fixture}
from lease_manager import LeaseManager
from lease_protocol import LeaseProtocol
protocol=LeaseProtocol(envelope)
class Pipe:
 def __init__(self):self.eof=False;self.records=[];self.granted=False
 def emit(self,value):self.records.append(value)
 def poll(self):
  if protocol.pending and not self.granted:
   self.granted=True
   return [dict(protocolVersion=1,type='grant',leaseId=envelope['leaseId'],requestDigest=canonical_digest(request),challenge=protocol.pending,capability=envelope['capability'])]
  time.sleep(.005);return []
with tempfile.TemporaryDirectory() as td:
 root=Path(td);pipe=Pipe()
 def verify():
  LeaseStore(root/'leases').cancel(envelope['leaseId'],envelope['capability'],canonical_digest(request))
  return dict(qualified=True)
 manager=LeaseManager(envelope,config,root,[sys.executable,'-c','pass'],cleanup=lambda:True,verify=verify,pipe=pipe,protocol=protocol)
 assert manager.run()!=0
 assert pipe.records[-1]['type']=='failed' and not any(r['type']=='completed' for r in pipe.records)
`));
  it("rechecks owned container cleanup after its wrapper has been reaped", () => python(`${fixture}
from lease_manager import LeaseManager
from lease_process import OwnedProcess
with tempfile.TemporaryDirectory() as td:
 manager=LeaseManager(envelope,config,Path(td),[],cleanup=lambda:True,verify=lambda:dict(qualified=True))
 manager.child=OwnedProcess([sys.executable,'-c','import time;time.sleep(60)'],stdout=subprocess.PIPE)
 states=[]
 def cleanup_owned():
  states.append(manager.child.process.poll())
  return True
 manager.cleanup=cleanup_owned
 assert manager._cleanup_owned() is True
 assert states[0] is None and states[1] is not None and len(states)==2
`));
  it("never qualifies cleanup failure and persists a block against replacement CPU", () => python(`${fixture}
with tempfile.TemporaryDirectory() as td:
 root=Path(td);proc=start(root,True)
 try:
  record(proc);locked=record(proc);grant(proc,locked);record(proc);proc.stdin.close();proc.wait(timeout=8)
  terminal=record(proc);assert terminal['type']=='failed' and terminal['reason']=='cleanup_failed'
  assert (root/'cleanup.blocked').is_file()
 finally:cleanup(proc)
`));
});
