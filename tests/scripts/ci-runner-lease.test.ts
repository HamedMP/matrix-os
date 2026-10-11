import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const runner = resolve("scripts/ci/runner");
function python(body: string) {
  const code = `import sys\nsys.dont_write_bytecode=True\nsys.path.insert(0,${JSON.stringify(runner)})\n${body}`;
  const result = spawnSync("python3", ["-I", "-c", code], { encoding: "utf8", timeout: 20_000 });
  expect(result.status, result.stderr || result.stdout).toBe(0);
}
const fixture = `
from lease_contract import validate_envelope, canonical_digest, LIMITS
request=dict(repository='HamedMP/matrix-os',prNumber=2454,headSha='a'*40,baseSha='b'*40,baseRef='codex/parent',mergeSha='c'*40,mergeParents=['b'*40,'a'*40],requestingRunId=101,requestingRunAttempt=1,controllerRunId=202,controllerRunAttempt=1,controllerSha='d'*40,controllerRef='refs/heads/main',controllerWorkflow='.github/workflows/ci-dedicated.yml',imageDigest='sha256:'+'e'*64,harnessDigest='f'*64,mode='shadow',suite='qualification',limits=dict(LIMITS))
envelope=dict(protocolVersion=1,leaseId='1'*32,capability='2'*64,request=request)
config=dict(repository='HamedMP/matrix-os',controllerShas=['d'*40],imageDigest=request['imageDigest'],harnessDigest=request['harnessDigest'],modes=['shadow','delegated'])
`;

describe("authenticated isolated runner leases", () => {
  it("binds the exact tuple with sorted canonical JSON and approved resource limits", () => python(`${fixture}
import hashlib,json
valid=validate_envelope(envelope,config)
assert valid==envelope
assert canonical_digest(request)==hashlib.sha256(json.dumps(request,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
assert envelope['capability'] not in canonical_digest(request)
`));
  it("rejects other repository/controller/image/resource/parent identities and unknown keys", () => python(`${fixture}
import copy
for key,value in [('repository','attacker/repo'),('controllerSha','0'*40),('controllerRef','refs/pull/2454/merge'),('imageDigest','sha256:'+'0'*64),('mergeParents',['a'*40,'b'*40]),('suite','unit'),('extra','unbound')]:
 bad=copy.deepcopy(envelope);bad['request'][key]=value
 try:validate_envelope(bad,config)
 except ValueError:pass
 else:raise AssertionError(key)
for limits in [dict(LIMITS,cpu=31),dict(LIMITS,unitWorkers=17),dict(LIMITS,memoryMiB=999999)]:
 bad=copy.deepcopy(envelope);bad['request']['limits']=limits
 try:validate_envelope(bad,config)
 except ValueError:pass
 else:raise AssertionError('limits')
`));
  it("retains one-use lease, capability and attempt replay barriers and rejects another owner", () => python(`${fixture}
from lease_store import LeaseStore
from pathlib import Path
import copy,tempfile
with tempfile.TemporaryDirectory() as td:
 store=LeaseStore(Path(td));store.reserve(envelope)
 for mutate in ('same','capability','attempt'):
  bad=copy.deepcopy(envelope)
  if mutate!='same':bad['leaseId']='3'*32
  if mutate=='attempt':bad['capability']='4'*64
  try:store.reserve(bad)
  except ValueError:pass
  else:raise AssertionError(mutate)
 try:store.cancel(envelope['leaseId'],'9'*64,canonical_digest(request))
 except ValueError:pass
 else:raise AssertionError('other owner')
 assert not store.is_cancelled(envelope['leaseId'])
 store.cancel(envelope['leaseId'],envelope['capability'],canonical_digest(request))
 assert store.is_cancelled(envelope['leaseId'])
`));
  it("preserves FIFO admission order and removes only cancelled/completed requests from the queue", () => python(`${fixture}
from lease_store import LeaseStore
import copy,tempfile
with tempfile.TemporaryDirectory() as td:
 store=LeaseStore(td);second=copy.deepcopy(envelope)
 second['leaseId']='3'*32;second['capability']='4'*64;second['request']['controllerRunId']=303
 store.reserve(envelope);store.reserve(second)
 assert store.is_first(envelope['leaseId']) and not store.is_first(second['leaseId'])
 store.cancel(envelope['leaseId'],envelope['capability'],canonical_digest(request))
 assert store.is_first(second['leaseId'])
 store.complete(second['leaseId']);assert not store.is_first(second['leaseId'])
`));
  it("consumes each after-lock grant/renew challenge only once and expires without renewal", () => python(`${fixture}
from lease_protocol import LeaseProtocol
clock=[10.0];p=LeaseProtocol(envelope,now=lambda:clock[0]);locked=p.locked()
message=dict(protocolVersion=1,type='grant',leaseId=envelope['leaseId'],requestDigest=canonical_digest(request),challenge=locked['challenge'],capability=envelope['capability'])
p.accept(message)
try:p.accept(message)
except ValueError:pass
else:raise AssertionError('replayed grant')
clock[0]=69.0
try:p.renewal()
except ValueError:pass
else:raise AssertionError('renewal before authenticated poll interval')
clock[0]=70.0;renew=p.renewal();assert renew['challenge']!=locked['challenge']
message.update(type='renew',challenge=renew['challenge']);p.accept(message)
clock[0]=189.0;assert not p.expired()
clock[0]=190.0;assert p.expired()
initial=LeaseProtocol(envelope,now=lambda:clock[0]);initial.locked()
clock[0]=220.0;assert initial.expired()
`));
  it("kills and reaps its real OS process group while leaving another owner's process alive", () => python(`
from lease_process import OwnedProcess
import subprocess,sys,time,os,signal
other=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)'],start_new_session=True)
owned=OwnedProcess([sys.executable,'-c','import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(60)'])
try:
 time.sleep(.2);owned.cancel(grace=.1)
 assert owned.process.poll() is not None
 assert other.poll() is None
 try:os.killpg(owned.process.pid,0)
 except ProcessLookupError:pass
 else:raise AssertionError('owned CPU group survived')
finally:
 os.killpg(other.pid,signal.SIGKILL);other.wait(timeout=3)
`));
  it("reaps descendants even when the owned process leader exits first", () => python(`
from lease_process import OwnedProcess
import sys,tempfile,time,os
from pathlib import Path
with tempfile.TemporaryDirectory() as td:
 marker=Path(td)/'child'
 code="import subprocess,sys;child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)']);open(sys.argv[1],'w').write(str(child.pid))"
 owned=OwnedProcess([sys.executable,'-c',code,str(marker)])
 try:
  owned.process.wait(timeout=3);pid=int(marker.read_text());owned.cancel(grace=.1)
  deadline=time.monotonic()+3
  while time.monotonic()<deadline:
   try:os.kill(pid,0)
   except ProcessLookupError:break
   time.sleep(.05)
  else:raise AssertionError('descendant survived')
 finally:owned.cancel(grace=.1)
`));
});
