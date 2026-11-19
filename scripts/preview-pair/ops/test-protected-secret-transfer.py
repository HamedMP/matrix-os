"""Exercise the real transfer helper with its subprocess boundaries intercepted."""
import contextlib, importlib.util, io, json, pathlib, subprocess, sys, tempfile, unittest
from unittest.mock import patch
ROOT = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('transfer', ROOT/'github-control-secrets.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

class TransferTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.root=pathlib.Path(self.temp.name)
        (self.root/'control-secret-sources.json').write_text(json.dumps({k:{'secret':v,'version':'1'} for k,v in m.EXPECTED.items()}))
        self.calls=[]
    def tearDown(self): self.temp.cleanup()
    def command(self,args,**kwargs):
        self.calls.append((args,kwargs))
        if args[:3]==['gcloud','secrets','versions']:
            data=b'{"state":"ENABLED"}' if args[3]=='describe' else b'SENTINEL_PRIVATE_VALUE'
        elif args[:2]==['gh','secret'] and args[2]=='list': data=json.dumps([{'name':k} for k in m.EXPECTED]).encode()
        else: data=b''
        return subprocess.CompletedProcess(args,0,stdout=data,stderr=b'')
    def invoke(self,apply=False):
        with patch.object(m,'ROOT',self.root), patch.object(sys,'argv',['helper']+(['--apply'] if apply else [])), patch.object(m.subprocess,'run',side_effect=self.command), contextlib.redirect_stdout(io.StringIO()) as output:
            m.main()
        self.assertNotIn('SENTINEL',output.getvalue())
    def test_default_verifies_protections_and_reads_metadata_only(self):
        self.invoke()
        self.assertEqual(self.calls[0][0],['python3',str(self.root/'check-github-protections.py')])
        self.assertFalse(any('access' in args or args[:3]==['gh','secret','set'] for args,_ in self.calls))
    def test_apply_uses_stdin_and_only_four_protected_environment_names(self):
        self.invoke(True)
        transfers=[(args,kw) for args,kw in self.calls if args[:3]==['gh','secret','set']]
        self.assertEqual({args[3] for args,_ in transfers},set(m.EXPECTED))
        for args,kw in transfers:
            self.assertEqual(args[-2:],['--env','collaboration-preview-control'])
            self.assertNotIn('SENTINEL',' '.join(args)); self.assertEqual(kw['input'],b'SENTINEL_PRIVATE_VALUE')
    def test_failed_receiver_stderr_cannot_leak_secret(self):
        failed=subprocess.CompletedProcess(['gh'],1,stdout=b'',stderr=b'SENTINEL_PRIVATE_VALUE')
        with patch.object(m.subprocess,'run',return_value=failed), self.assertRaisesRegex(RuntimeError,'no credential output') as error: m.run(['gh','secret','set'],b'SENTINEL_PRIVATE_VALUE')
        self.assertNotIn('SENTINEL',str(error.exception))
if __name__=='__main__': unittest.main()
