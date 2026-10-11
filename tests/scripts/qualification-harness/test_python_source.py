import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import test_provenance as provenance
load=provenance.load

class PythonSourceImmutability(unittest.TestCase):
 repo=provenance.SourceProvenance.repo
 def scripts(self,root):
  ops=root/'scripts'/'ops';ops.mkdir(parents=True)
  from fixtures import ROOT
  source=ROOT
  for name in ('launch-funded-config-repair.py','repair-funded-chat-config.py'):
   shutil.copyfile(source/'scripts'/'ops'/name,ops/name)
  return ops,self.repo(root)
 def imports(self,ops,cache):
  # macOS Python disables bytecode globally here. Restore Linux's default only
  # in this throwaway fixture, preserving the real isolated import invocation.
  code="""import importlib.util,os,sys,json
sys.dont_write_bytecode=False
for name in ('launch-funded-config-repair.py','repair-funded-chat-config.py'):
 s=importlib.util.spec_from_file_location('fixture',os.path.join(sys.argv[1],name));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
 if name.startswith('repair'):
  try:m.require(False,'fixture_error')
  except m.RepairError as e:assert e.code=='fixture_error'
 else:m.require(True,'fixture_error')
print(json.dumps({'ignore_environment':sys.flags.ignore_environment,'prefix':sys.pycache_prefix}))
"""
  return subprocess.run(['/usr/bin/python3','-I','-c',code,str(ops)],env=dict(os.environ,PYTHONPYCACHEPREFIX=str(cache)),capture_output=True,text=True,timeout=10)
 def test_isolated_python_ignores_prefix_and_writable_source_is_rejected(self):
  m=load()
  with tempfile.TemporaryDirectory() as td:
   root=Path(td)/'unit';root.mkdir();ops,sha=self.scripts(root)
   result=self.imports(ops,Path(td)/'cache');self.assertEqual(result.returncode,0,result.stderr)
   self.assertEqual(json.loads(result.stdout),{'ignore_environment':1,'prefix':None})
   self.assertEqual(len(list((ops/'__pycache__').glob('*.pyc'))),2)
   with patch.object(m,'SOURCE',sha),patch.object(m,'LOCK',hashlib.sha256((root/'pnpm-lock.yaml').read_bytes()).hexdigest()),self.assertRaisesRegex(ValueError,'Source provenance'):
    m.check_source(root,Path(td)/'dirty.json','after-lane','unit')
 def test_readonly_ops_preserves_imports_bytes_modes_and_git_cleanliness(self):
  m=load()
  with tempfile.TemporaryDirectory() as td:
   root=Path(td)/'unit';root.mkdir();ops,sha=self.scripts(root)
   original={p.name:(p.read_bytes(),p.stat().st_mode) for p in ops.iterdir()}
   try:
    with patch.object(m,'SOURCE',sha):m.prepare_unit_source(root)
    self.assertEqual(ops.stat().st_mode & 0o777,0o555)
    result=self.imports(ops,Path(td)/'cache');self.assertEqual(result.returncode,0,result.stderr)
    self.assertFalse((ops/'__pycache__').exists())
    with self.assertRaises(PermissionError):(ops/'unexpected.pyc').write_bytes(b'write')
    self.assertEqual({p.name:(p.read_bytes(),p.stat().st_mode) for p in ops.iterdir()},original)
    with patch.object(m,'SOURCE',sha),patch.object(m,'LOCK',hashlib.sha256((root/'pnpm-lock.yaml').read_bytes()).hexdigest()):
     self.assertTrue(m.check_source(root,Path(td)/'clean.json','after-lane','unit')['clean'])
   finally:ops.chmod(0o755) # Own fixture teardown only; runtime never restores.
 def test_symlink_directory_is_rejected_without_changing_target(self):
  m=load()
  with tempfile.TemporaryDirectory() as td:
   root=Path(td)/'unit';root.mkdir();(root/'scripts').mkdir();target=Path(td)/'target';target.mkdir();(root/'scripts'/'ops').symlink_to(target,target_is_directory=True)
   with self.assertRaises(OSError):m.prepare_unit_source(root)
   self.assertEqual(target.stat().st_mode & 0o777,0o755)
 def test_symlink_scripts_and_unknown_root_are_rejected(self):
  m=load()
  with tempfile.TemporaryDirectory() as td:
   root=Path(td)/'unit';root.mkdir();target=Path(td)/'target';target.mkdir();(target/'ops').mkdir();(root/'scripts').symlink_to(target,target_is_directory=True)
   with self.assertRaises(OSError):m.prepare_unit_source(root)
   self.assertEqual((target/'ops').stat().st_mode & 0o777,0o755)
   with self.assertRaises(ValueError):m.prepare_unit_source(target)
 def test_existing_cache_or_changed_source_rejects_without_deleting(self):
  m=load()
  for mutation in ('cache','bytes','mode'):
   with tempfile.TemporaryDirectory() as td:
    root=Path(td)/'unit';root.mkdir();ops,sha=self.scripts(root)
    if mutation=='cache':(ops/'__pycache__').mkdir();(ops/'__pycache__'/'keep.pyc').write_bytes(b'keep')
    elif mutation=='bytes':(ops/'repair-funded-chat-config.py').write_text('changed')
    else:(ops/'repair-funded-chat-config.py').chmod(0o755)
    with patch.object(m,'SOURCE',sha),self.assertRaises(ValueError):m.prepare_unit_source(root)
    self.assertEqual(ops.stat().st_mode & 0o777,0o755)
    if mutation=='cache':self.assertEqual((ops/'__pycache__'/'keep.pyc').read_bytes(),b'keep')
 def test_ordinary_python_cache_prefix_is_external(self):
  with tempfile.TemporaryDirectory() as td:
   root=Path(td)/'unit';root.mkdir();ops,_=self.scripts(root);cache=Path(td)/'cache'/'unit'/'python'
   code="import sys,py_compile;sys.dont_write_bytecode=False;py_compile.compile(sys.argv[1],doraise=True)"
   result=subprocess.run(['/usr/bin/python3','-c',code,str(ops/'repair-funded-chat-config.py')],env=dict(os.environ,PYTHONPYCACHEPREFIX=str(cache)),capture_output=True,text=True,timeout=10)
   self.assertEqual(result.returncode,0,result.stderr);self.assertTrue(list(cache.rglob('repair-funded-chat-config.*.pyc')));self.assertFalse((ops/'__pycache__').exists())
if __name__=='__main__':unittest.main()
