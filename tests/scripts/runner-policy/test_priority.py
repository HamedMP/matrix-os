import copy,fcntl,json,os,subprocess,sys,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
sys.dont_write_bytecode=True
sys.path.insert(0,str(Path(__file__).resolve().parents[3]/'scripts/ci/runner'))
from lease_contract import validate_envelope,canonical_digest,LIMITS
from lease_store import LeaseStore
from lease_manager import LeaseManager
from lease_protocol import LeaseProtocol

def envelope(number=1,main=False):
 request=dict(repository='HamedMP/matrix-os',prNumber=2454,headSha='a'*40,baseSha='b'*40,baseRef='codex/parent',mergeSha='c'*40,mergeParents=['b'*40,'a'*40],requestingRunId=number,requestingRunAttempt=1,controllerRunId=number+100,controllerRunAttempt=1,controllerSha='d'*40,controllerRef='refs/heads/main',controllerWorkflow='.github/workflows/ci-dedicated.yml',imageDigest='sha256:'+'e'*64,harnessDigest='f'*64,mode='delegated',suite='qualification',limits=dict(LIMITS))
 if main:request.update(sourceKind='main',prNumber=0,headSha='c'*40,baseRef='main',mergeParents=['b'*40])
 return dict(protocolVersion=1,leaseId=f'{number:032x}',capability=f'{number+100:064x}',request=request)
def config():
 r=envelope()['request'];return dict(repository=r['repository'],controllerShas=['d'*40],imageDigest=r['imageDigest'],harnessDigest=r['harnessDigest'],modes=['shadow','delegated'])

class PriorityContracts(unittest.TestCase):
 def test_explicit_main_kind_binds_actual_one_or_two_parents(self):
  for parents in (['b'*40],['b'*40,'a'*40]):
   value=envelope(main=True);value['request']['mergeParents']=parents
   self.assertEqual(validate_envelope(value,config()),value)
   self.assertNotEqual(canonical_digest(value['request']),canonical_digest({k:v for k,v in value['request'].items() if k!='sourceKind'}))
 def test_no_bare_pr_zero_or_forged_kind_or_priority(self):
  for key,value in [('prNumber',0),('sourceKind','pull-request'),('sourceKind','main'),('priority',100)]:
   item=envelope();item['request'][key]=value
   with self.assertRaises(ValueError):validate_envelope(item,config())
  for key,value in [('baseRef','other'),('headSha','a'*40),('baseSha','a'*40),('mergeParents',[]),('mergeParents',['b'*40,'b'*40]),('mergeParents',['c'*40]),('mergeParents',['b'*40,'a'*40,'d'*40]),('prNumber',1)]:
   item=envelope(main=True);item['request'][key]=value
   with self.assertRaises(ValueError):validate_envelope(item,config())
 def test_two_main_burst_then_oldest_pr_and_fifo_per_class(self):
  with tempfile.TemporaryDirectory() as td:
   store=LeaseStore(Path(td)/'leases');pr1=envelope(1);pr2=envelope(2);main1=envelope(3,True);main2=envelope(4,True);main3=envelope(5,True)
   for item in (pr1,pr2,main1,main2,main3):store.reserve(item)
   for item in (main1,main2,pr1,main3,pr2):
    self.assertTrue(store.is_first(item['leaseId']),item['request'])
    self.assertTrue(store.claim(item['leaseId']));store.admit(item['leaseId']);store.complete(item['leaseId'])
   self.assertFalse(store.is_first(pr1['leaseId']))
 def test_priority_survives_process_reopen_and_does_not_preempt_claim(self):
  with tempfile.TemporaryDirectory() as td:
   root=Path(td)/'leases';store=LeaseStore(root);pr=envelope(1);main=envelope(2,True)
   store.reserve(pr);self.assertTrue(store.claim(pr['leaseId']));store.reserve(main)
   self.assertTrue(store.is_first(pr['leaseId']));self.assertFalse(store.claim(main['leaseId']))
   store.admit(pr['leaseId']);store.complete(pr['leaseId'])
   for n in (2,3):
    if n==3:store.reserve(envelope(n,True))
    store=LeaseStore(root);self.assertTrue(store.claim(envelope(n,True)['leaseId']));store.admit(envelope(n,True)['leaseId']);store.complete(envelope(n,True)['leaseId'])
   oldest=envelope(4);latest=envelope(5,True);store.reserve(oldest);store.reserve(latest)
   self.assertTrue(LeaseStore(root).is_first(oldest['leaseId']))
 def test_claim_reselects_after_priority_arrives_before_cpu_lock(self):
  with tempfile.TemporaryDirectory() as td:
   store=LeaseStore(Path(td)/'leases');pr=envelope(1);main=envelope(2,True);store.reserve(pr)
   self.assertTrue(store.is_first(pr['leaseId']));store.reserve(main)
   self.assertFalse(store.claim(pr['leaseId']));self.assertTrue(store.claim(main['leaseId']))
 def test_manager_rechecks_priority_after_real_cpu_flock(self):
  with tempfile.TemporaryDirectory() as td:
   root=Path(td);pr=envelope(1);main=envelope(2,True)
   manager=LeaseManager(pr,config(),root,[],cleanup=lambda:True,verify=lambda:dict(qualified=True))
   manager.store.reserve(pr);manager._tick=lambda **_:None
   fd=os.open(root/'benchmark.lock',os.O_RDWR|os.O_CREAT,0o600);original=fcntl.flock;acquisitions=[]
   def flock(descriptor,flags):
    if flags==fcntl.LOCK_EX|fcntl.LOCK_NB and descriptor==fd:
     acquisitions.append(flags)
     if len(acquisitions)==1:manager.store.reserve(main)
    original(descriptor,flags)
    if descriptor==fd and flags==fcntl.LOCK_UN:
     manager.store.cancel(main['leaseId'],main['capability'],canonical_digest(main['request']))
   try:
    with patch('lease_manager.fcntl.flock',side_effect=flock):manager._acquire(fd)
    self.assertEqual(len(acquisitions),2)
    self.assertTrue(manager.store.read(pr['leaseId'])['lockClaimed'])
    self.assertNotIn('lockClaimed',manager.store.read(main['leaseId']))
   finally:os.close(fd)
 def test_queue_deadline_also_bounds_repeated_claim_races(self):
  from lease_outcome import InfrastructureUnavailable
  with tempfile.TemporaryDirectory() as td:
   value=envelope();manager=LeaseManager(value,config(),Path(td),[],cleanup=lambda:True,verify=lambda:dict(qualified=True))
   manager._tick=lambda **_:None
   class Store:
    def is_first(self,lease):return True
    def claim(self,lease):
     self.claims=getattr(self,'claims',0)+1
     if self.claims>2:raise AssertionError('Claim race ignored queue deadline')
     return False
   manager.store=Store();fd=os.open(Path(td)/'benchmark.lock',os.O_RDWR|os.O_CREAT,0o600)
   try:
    with patch('lease_manager.time.monotonic',side_effect=[0,1,1801]),self.assertRaises(InfrastructureUnavailable):manager._acquire(fd)
   finally:os.close(fd)
 def test_cancelled_main_does_not_own_queue_or_advance_burst(self):
  with tempfile.TemporaryDirectory() as td:
   store=LeaseStore(Path(td)/'leases');pr=envelope(1);main=envelope(2,True)
   store.reserve(pr);store.reserve(main);store.cancel(main['leaseId'],main['capability'],canonical_digest(main['request']))
   self.assertTrue(store.is_first(pr['leaseId']))
   with self.assertRaises(InterruptedError):store.admit(main['leaseId'])
 def test_store_rejects_main_priority_forged_on_a_pr(self):
  with tempfile.TemporaryDirectory() as td:
   value=envelope();value['request']['sourceKind']='main'
   with self.assertRaises(ValueError):LeaseStore(Path(td)/'leases').reserve(value)

if __name__=='__main__':unittest.main()
