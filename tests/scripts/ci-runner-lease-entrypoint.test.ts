import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
const root=resolve('scripts/ci/runner');
describe('fixed privileged lease entrypoint',()=>{
 it('captures admission time before waiting without allocating result directories',()=>{
  const body=`
import sys,tempfile,json,subprocess
from pathlib import Path
from unittest.mock import patch,mock_open
sys.dont_write_bytecode=True
sys.path.insert(0,${JSON.stringify(root)})
import lease,qualification_host
from lease_contract import LIMITS
request=dict(repository='HamedMP/matrix-os',prNumber=2454,headSha='a'*40,baseSha='b'*40,baseRef='codex/parent',mergeSha='c'*40,mergeParents=['b'*40,'a'*40],requestingRunId=101,requestingRunAttempt=1,controllerRunId=202,controllerRunAttempt=1,controllerSha='d'*40,controllerRef='refs/heads/main',controllerWorkflow='.github/workflows/ci-dedicated.yml',imageDigest='sha256:'+'e'*64,harnessDigest='f'*64,mode='shadow',suite='qualification',limits=dict(LIMITS))
envelope=dict(protocolVersion=1,leaseId='1'*32,capability='2'*64,request=request)
config=dict(repository='HamedMP/matrix-os',controllerShas=['d'*40],imageDigest=request['imageDigest'],harnessDigest=request['harnessDigest'],modes=['shadow','delegated'])
clock=[1767225600.0]
def command(args,**kw):
 data=b'32' if args==['nproc'] else request['imageDigest'].encode() if args[:3]==['docker','image','inspect'] else b''
 return subprocess.CompletedProcess(args,0,data,b'')
real_host=qualification_host.QualificationHost
def host(*args,**kw):return real_host(*args,execute=command,**kw)
class Manager:
 def __init__(self,envelope,config,state,command,**kw):self.state=state;self.preflight=kw['preflight']
 def run(self):
  assert not (self.state/'results').exists(), 'admission allocated unowned outputs before reservation/lock'
  clock[0]+=600
  assert self.preflight() is True
  timing=json.loads((self.state/'results'/('lease.'+envelope['leaseId'])/'started.json').read_text())
  assert timing['queueSeconds']==600,timing
  assert timing['queueStartedUtc']=='2026-01-01T00:00:00Z',timing
  assert timing['startedUtc']=='2026-01-01T00:10:00Z',timing
  return 0
with tempfile.TemporaryDirectory() as td:
 with patch.object(lease,'STATE',Path(td)),patch.object(lease.sys,'argv',['lease.py','run',envelope['leaseId']]),patch.object(lease.os,'geteuid',return_value=0),patch.object(lease,'ControlPipe'),patch.object(lease,'first_record',return_value=envelope),patch.object(lease,'read_owned_json',return_value=config),patch.object(lease,'verify_harness'),patch.object(lease,'LeaseManager',Manager),patch.object(qualification_host,'QualificationHost',side_effect=host),patch.object(qualification_host,'open',mock_open(read_data='MemTotal: 128000000 kB\\n'),create=True),patch.object(lease.time,'time',side_effect=lambda:clock[0]),patch.object(qualification_host,'utc',side_effect=lambda:__import__('datetime').datetime.fromtimestamp(clock[0],__import__('datetime').timezone.utc).isoformat(timespec='seconds').replace('+00:00','Z')):
  assert lease.main()==0
`;
  const result=spawnSync('python3',['-I','-c',body],{encoding:'utf8',timeout:5000});
  expect(result.status,result.stderr||result.stdout).toBe(0);
 });
 it.each([[[]],[['run','main']],[['shell','a'.repeat(32)]],[['run','a'.repeat(32),'extra']]])('rejects malformed CLI before any state or workload allocation (%j)',(args)=>{
  const result=spawnSync('python3',['-I',resolve(root,'lease.py'),...args],{encoding:'utf8',timeout:5000});
  expect(result.status,result.stderr).toBe(64);
 });
 it('never accepts caller paths, environment policy overrides or capability arguments',()=>{
  const source=readFileSync(resolve(root,'lease.py'),'utf8');
  expect(source).toContain("'/etc/matrix-ci/runner.json'");
  expect(source).toContain("'/var/lib/matrix-ci'");
  expect(source).toContain('os.geteuid() != 0');
  expect(source).not.toMatch(/getenv|environ\[/);
  expect(source).toContain('verify_harness');
  expect(source).toContain('validate_envelope');
 });
 it.each(['attempt','capability','capacity'])('allocates no qualification outputs when reservation rejects %s',kind=>{
  const body=`
import sys,os,tempfile,copy
from pathlib import Path
from unittest.mock import patch
sys.dont_write_bytecode=True
sys.path.insert(0,${JSON.stringify(root)})
import lease
from lease_contract import LIMITS
from lease_store import LeaseStore
request=dict(repository='HamedMP/matrix-os',prNumber=2454,headSha='a'*40,baseSha='b'*40,baseRef='codex/parent',mergeSha='c'*40,mergeParents=['b'*40,'a'*40],requestingRunId=101,requestingRunAttempt=1,controllerRunId=202,controllerRunAttempt=1,controllerSha='d'*40,controllerRef='refs/heads/main',controllerWorkflow='.github/workflows/ci-dedicated.yml',imageDigest='sha256:'+'e'*64,harnessDigest='f'*64,mode='shadow',suite='qualification',limits=dict(LIMITS))
envelope=dict(protocolVersion=1,leaseId='1'*32,capability='2'*64,request=request)
config=dict(repository='HamedMP/matrix-os',controllerShas=['d'*40],imageDigest=request['imageDigest'],harnessDigest=request['harnessDigest'],modes=['shadow','delegated'])
class Pipe:
 def emit(self,value):pass
kind=${JSON.stringify(kind)}
with tempfile.TemporaryDirectory() as td:
 state=Path(td);store=LeaseStore(state/'leases')
 for number in range(32 if kind=='capacity' else 1):
  prior=copy.deepcopy(envelope);prior['leaseId']=format(number+10,'032x')
  if kind!='capability':prior['capability']=format(number+10,'064x')
  if kind!='attempt':prior['request']['controllerRunId']=number+300
  store.reserve(prior)
 with patch.object(lease,'STATE',state),patch.object(lease.sys,'argv',['lease.py','run',envelope['leaseId']]),patch.object(lease.os,'geteuid',return_value=0),patch.object(lease,'ControlPipe',return_value=Pipe()),patch.object(lease,'first_record',return_value=envelope),patch.object(lease,'read_owned_json',return_value=config),patch.object(lease,'verify_harness'):
  assert lease.main()!=0
 assert not (state/'results').exists(), 'rejected reservation allocated unowned result directory'
 assert not (state/'leases'/(envelope['leaseId']+'.json')).exists()
 assert len(store.records())==(32 if kind=='capacity' else 1)
`;
  const result=spawnSync('python3',['-I','-c',body],{encoding:'utf8',timeout:5000});
  expect(result.status,result.stderr||result.stdout).toBe(0);
 });
});
