import os,sys,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
from test_priority import envelope,config
from lease_manager import LeaseManager
from lease_store import LeaseStore
from lease_protocol import LeaseProtocol
from lease_contract import canonical_digest

class InfrastructureContracts(unittest.TestCase):
 def run_manager(self,preflight,cleanup=True,command=None,eof=False):
  from lease_outcome import InfrastructureUnavailable
  value=envelope();protocol=LeaseProtocol(value)
  class Pipe:
   def __init__(self):self.eof=eof;self.records=[];self.granted=False
   def emit(self,item):self.records.append(item)
   def poll(self):
    if protocol.pending and not self.granted:
     self.granted=True
     return [dict(protocolVersion=1,type='grant',leaseId=value['leaseId'],requestDigest=canonical_digest(value['request']),challenge=protocol.pending,capability=value['capability'])]
    time.sleep(.002);return []
  with tempfile.TemporaryDirectory() as td:
   pipe=Pipe();manager=LeaseManager(value,config(),Path(td),command or [sys.executable,'-c','pass'],cleanup=lambda:cleanup,verify=lambda:dict(qualified=True),pipe=pipe,protocol=protocol,preflight=preflight)
   status=manager.run();return status,pipe.records[-1],manager.child
 def test_typed_preflight_outcome_binds_request_and_proves_no_cpu(self):
  from lease_outcome import InfrastructureUnavailable
  def unavailable():raise InfrastructureUnavailable('host_capacity_unavailable')
  status,record,child=self.run_manager(unavailable)
  self.assertEqual(status,76);self.assertEqual(record['type'],'infrastructure-unavailable');self.assertEqual(record['stage'],'preflight')
  self.assertIs(record['workloadStarted'],False);self.assertIs(record['containerGone'],True);self.assertIsNone(child)
  self.assertEqual(record['requestDigest'],canonical_digest(envelope()['request']));self.assertNotIn(envelope()['capability'],str(record))
 def test_unknown_source_auth_and_cleanup_never_allow_fallback(self):
  from lease_outcome import InfrastructureUnavailable
  for error in (ValueError('stale source'),RuntimeError('unknown failure'),PermissionError('auth'),InfrastructureUnavailable('host_capacity_unavailable')):
   def failure():raise error
   status,record,_=self.run_manager(failure,cleanup=not isinstance(error,InfrastructureUnavailable))
   self.assertNotEqual(status,76);self.assertEqual(record['type'],'failed');self.assertNotIn('workloadStarted',record)
 def test_cancellation_is_not_infrastructure(self):
  status,record,child=self.run_manager(lambda:True,eof=True)
  self.assertEqual(status,75);self.assertEqual(record['type'],'cancelled');self.assertIsNone(child)
 def test_real_owned_failed_workload_is_never_infrastructure(self):
  status,record,child=self.run_manager(lambda:True,command=[sys.executable,'-c','import sys;sys.exit(42)'])
  self.assertEqual(record['type'],'failed');self.assertNotEqual(status,76);self.assertIsNotNone(child.process.poll())
 def test_queue_capacity_typed_but_replay_at_capacity_remains_denied(self):
  from lease_outcome import InfrastructureUnavailable
  with tempfile.TemporaryDirectory() as td:
   store=LeaseStore(Path(td)/'leases')
   for n in range(1,33):store.reserve(envelope(n))
   with self.assertRaises(ValueError):store.reserve(envelope(1))
   with self.assertRaises(InfrastructureUnavailable):store.reserve(envelope(33))
 def test_queue_timeout_is_pre_workload_only(self):
  from lease_outcome import InfrastructureUnavailable
  value=envelope();manager=LeaseManager(value,config(),Path(tempfile.mkdtemp()),[],cleanup=lambda:True,verify=lambda:dict(qualified=True))
  class Store:
   def is_cancelled(self,lease):return False
   def is_first(self,lease):return False
  class Pipe:
   eof=False
   def poll(self):return []
  manager.store=Store();manager.pipe=Pipe()
  try:
   with patch('lease_manager.time.monotonic',side_effect=[0,1801]),self.assertRaises(InfrastructureUnavailable):manager._acquire(-1)
  finally:
   import shutil;shutil.rmtree(manager.root)
 def test_reason_allowlist_is_not_an_arbitrary_retry_policy(self):
  from lease_outcome import InfrastructureUnavailable
  for reason in ('workload_failed','source_unavailable','authentication_failed','cancelled','cleanup_failed','unknown','execution_timeout'):
   with self.assertRaises(ValueError):InfrastructureUnavailable(reason)

if __name__=='__main__':unittest.main()
