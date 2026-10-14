import io,json,subprocess,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from test_priority import envelope
from qualification_host import QualificationHost
from lease_outcome import InfrastructureUnavailable

class HostAdmissionContracts(unittest.TestCase):
 def test_main_and_native_pr_prepare_actual_signed_parents(self):
  with tempfile.TemporaryDirectory() as td:
   for number,main in ((1,False),(2,True)):
    request=envelope(number,main)['request']
    if not main:request['mergeParents'][0]='0'*40
    host=QualificationHost(Path(td),f'{number:032x}',request)
    args=host.source_prepare_args()
    self.assertEqual(args[:4],['docker','exec','--user','10001:10001'])
    self.assertEqual(args[5:8],['/usr/bin/python3','-I','/opt/matrix-ci/qualification/manifest.py'])
    if main:self.assertEqual(args[8:],['--prepare-public-main',request['mergeSha'],json.dumps(request['mergeParents'],separators=(',',':'))])
    else:self.assertEqual(args[8:],['--prepare-public',request['mergeSha'],request['mergeParents'][0],request['headSha']])
 def test_preflight_infra_only_verified_capacity_daemon_or_missing_image(self):
  for failure,reason in (('capacity','host_capacity_unavailable'),('daemon','docker_unavailable'),('image','image_unavailable')):
   with self.subTest(failure=failure),tempfile.TemporaryDirectory() as td:
    host=self.host(td,failure)
    with patch('qualification_host.open',return_value=io.StringIO('MemTotal: 120000000 kB\n')):
     with self.assertRaises(InfrastructureUnavailable) as error:host.preflight()
    self.assertEqual(error.exception.reason,reason)
 def test_configuration_isolation_and_uncertain_state_remain_red(self):
  for failure in ('cores-invalid','firewall','daemon-empty','image-wrong','leftover'):
   with self.subTest(failure=failure),tempfile.TemporaryDirectory() as td:
    host=self.host(td,failure)
    with patch('qualification_host.open',return_value=io.StringIO('MemTotal: 120000000 kB\n')):
     with self.assertRaises(ValueError):host.preflight()
    self.assertFalse((host.lease_dir/'started.json').exists())
 def test_result_cap_counts_exactly_the_lease_directories_retention_manages(self):
  from lease_outcome import HostRejection
  # Manual evidence, look-alike names and symlinks that retention never removes must not hold slots.
  with tempfile.TemporaryDirectory() as td:
   results=Path(td)/'results';results.mkdir(mode=0o700)
   for name in ('run.1','web-final.2','main-baseline','gallery-qualification-3','pr-current-4','lease.abc-old','lease.'+'0'*31):
    (results/name).mkdir(mode=0o700)
   (results/('lease.'+'e'*32+'.tar')).write_text('archive')
   (results/('lease.'+'d'*32)).symlink_to(results/'run.1')
   for i in range(31):(results/f'lease.{i:032x}').mkdir(mode=0o700)
   host=QualificationHost(Path(td),'f'*32,envelope()['request'])
   self.assertEqual(host.lease_dir.name,'lease.'+'f'*32)
  with tempfile.TemporaryDirectory() as td:
   results=Path(td)/'results';results.mkdir(mode=0o700)
   for i in range(32):(results/f'lease.{i:032x}').mkdir(mode=0o700)
   # A full cap stays red with a coded reason; it is never an availability fallback.
   with self.assertRaises(HostRejection) as error:QualificationHost(Path(td),'f'*32,envelope()['request'])
   self.assertEqual(error.exception.reason,'result_cap')
   self.assertNotIsInstance(error.exception,InfrastructureUnavailable)
   # A retained lease directory may always be reopened by its own lease.
   QualificationHost(Path(td),f'{0:032x}',envelope()['request'])
 def test_result_directory_entry_cap_is_the_same_coded_rejection(self):
  from lease_outcome import HostRejection
  with tempfile.TemporaryDirectory() as td:
   results=Path(td)/'results';results.mkdir(mode=0o700)
   for i in range(512):(results/f'manual-{i}').mkdir(mode=0o700)
   with self.assertRaises(HostRejection) as error:QualificationHost(Path(td),'f'*32,envelope()['request'])
   self.assertEqual(error.exception.reason,'result_cap')
   self.assertFalse((results/('lease.'+'f'*32)).exists())
 def test_prunable_completed_leases_free_a_full_host_before_admission(self):
  import os,time
  from lease_store import LeaseStore
  with tempfile.TemporaryDirectory() as td:
   root=Path(td);results=root/'results';results.mkdir(mode=0o700);store=LeaseStore(root/'leases');old=time.time()-900000
   for i in range(485):(results/f'manual-{i}').mkdir(mode=0o700)
   for i in range(32):
    lease=f'{i:032x}';path=results/('lease.'+lease);path.mkdir(mode=0o700)
    store._write(lease,dict(status='completed',leaseId=lease,created=old,cancelled=False),create=True);os.utime(path,(old,old))
   # 517 entries and 32 lease slots, all reclaimable: retention runs first, so admission succeeds.
   host=QualificationHost(root,'f'*32,envelope()['request'])
   self.assertTrue(host.lease_dir.is_dir())
   self.assertEqual(len([p for p in results.iterdir() if p.name.startswith('lease.')]),1)
 def test_retention_reports_usage_and_never_raises_on_a_full_directory(self):
  from lease_retention import cleanup_results
  with tempfile.TemporaryDirectory() as td:
   results=Path(td)/'results';results.mkdir(mode=0o700)
   for i in range(600):(results/f'manual-{i}').mkdir(mode=0o700)
   (results/('lease.'+'a'*32)).mkdir(mode=0o700)
   self.assertEqual(cleanup_results(Path(td)),(601,1))
  with tempfile.TemporaryDirectory() as td:self.assertEqual(cleanup_results(Path(td)),(0,0))
 def test_lease_entries_removed_after_listing_hold_no_slot(self):
  from lease_retention import lease_directories
  with tempfile.TemporaryDirectory() as td:
   kept=Path(td)/('lease.'+'a'*32);kept.mkdir()
   gone=Path(td)/('lease.'+'b'*32) # listed, then pruned by an operator before lstat
   self.assertEqual([lease for _,lease,_ in lease_directories([gone,kept,Path(td)/'manual'])],['a'*32])
 def test_failure_reasons_cover_every_code_the_lease_manager_sends(self):
  import re
  from lease_outcome import FAILURE_REASONS,REJECTIONS
  source=(Path(__file__).resolve().parents[3]/'scripts/ci/runner/lease_manager.py').read_text()
  sent=set(re.findall(r"\d+, '(failed|cancelled)', '(\w+)'",source))
  declared={(kind,reason) for kind,reasons in FAILURE_REASONS.items() for reason in reasons}
  self.assertEqual(sent|{('failed',reason) for reason in REJECTIONS},declared)
  self.assertIn("'failed', error.reason",source)
  self.assertLessEqual(REJECTIONS,FAILURE_REASONS['failed'])
 def host(self,td,failure):
  request=envelope()['request']
  def execute(args,**kwargs):
   status=0;output=b''
   if args==['nproc']:output=b'16' if failure=='capacity' else b'invalid' if failure=='cores-invalid' else b'32'
   elif args[0]=='iptables':status=int(failure=='firewall')
   elif args[1]=='info':status=int(failure=='daemon');output=b'' if failure=='daemon-empty' else b'root-daemon-id'
   elif args[1]=='image':status=int(failure=='image');output=('sha256:'+'0'*64 if failure=='image-wrong' else request['imageDigest']).encode()
   elif args[1]=='container':output=b'leftover' if failure=='leftover' else b''
   else:raise AssertionError(args)
   return subprocess.CompletedProcess(args,status,output,b'')
  return QualificationHost(Path(td),'1'*32,request,execute=execute)

if __name__=='__main__':unittest.main()
