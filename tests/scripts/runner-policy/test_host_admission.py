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
