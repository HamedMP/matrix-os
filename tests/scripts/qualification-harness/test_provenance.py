import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from fixtures import ROOT,tracked_fixture
from common import canonical,digest
HERE=ROOT/'scripts'/'ci'/'qualification'

def load():
 spec=importlib.util.spec_from_file_location('proof',HERE/'source.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);
 m.UNIT_IMPORTS={name:{'sha256':hashlib.sha256((ROOT/'scripts'/'ops'/name).read_bytes()).hexdigest(),'mode':0o644} for name in ('launch-funded-config-repair.py','repair-funded-chat-config.py')}
 return m

class SourceProvenance(unittest.TestCase):
 def repo(self,root):
  subprocess.run(['git','init','-q',str(root)],check=True)
  subprocess.run(['git','-C',str(root),'config','core.ignorecase','false'],check=True)
  (root/'pnpm-lock.yaml').write_text('fixed lock\n');(root/'.gitignore').write_text('/output/\n/node_modules/\n')
  subprocess.run(['git','-C',str(root),'add','.'],check=True)
  subprocess.run(['git','-C',str(root),'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture'],check=True)
  self.tracked=tracked_fixture(root)
  return subprocess.check_output(['git','-C',str(root),'rev-parse','HEAD'],text=True).strip()
 def inspect(self,m,root,out):
  m.TRACKED=self.tracked;m.TRACKED_DIGEST=digest(canonical(self.tracked))
  return m.check_source(root,out,'postinstall',lane='e2e')
 def test_lane_clones_have_independent_files_and_git_object_stores(self):
  m=load()
  with tempfile.TemporaryDirectory() as td:
   work=Path(td);unit=work/'unit';unit.mkdir();sha=self.repo(unit)
   with patch.object(m,'SOURCE',sha):m.clone_lanes(work)
   for lane in ('mechanical','web','e2e'):
    self.assertEqual(subprocess.check_output(['git','-C',str(work/lane),'rev-parse','HEAD'],text=True).strip(),sha)
    self.assertFalse((work/lane/'.git/objects/info/alternates').exists())
    self.assertNotEqual((unit/'.git/objects').resolve(),(work/lane/'.git/objects').resolve())
    for obj in (unit/'.git/objects').glob('*/*'):
     copy=work/lane/'.git/objects'/obj.relative_to(unit/'.git/objects')
     if copy.exists():self.assertNotEqual(obj.stat().st_ino,copy.stat().st_ino)
   (work/'web'/'pnpm-lock.yaml').write_text('only web changes')
   self.assertTrue(all((work/lane/'pnpm-lock.yaml').read_text()=='fixed lock\n' for lane in ('unit','mechanical','e2e')))
 def test_clean_install_ignored_artifacts_and_exact_lock_accepted(self):
  m=load()
  with tempfile.TemporaryDirectory() as td:
   root=Path(td)/'repo';root.mkdir();sha=self.repo(root);out=Path(td)/'clean.json';(root/'output').mkdir();(root/'output'/'capture.png').write_text('ignored')
   with patch.object(m,'SOURCE',sha),patch.object(m,'LOCK',hashlib.sha256((root/'pnpm-lock.yaml').read_bytes()).hexdigest()):self.inspect(m,root,out)
   evidence=json.loads(out.read_text());self.assertTrue(evidence['clean']);self.assertEqual(evidence['untracked'],[])
 def test_lock_mutation_fails_and_retains_bounded_dirty_paths(self):
  m=load()
  with tempfile.TemporaryDirectory() as td:
   root=Path(td)/'repo';root.mkdir();sha=self.repo(root);lock=hashlib.sha256((root/'pnpm-lock.yaml').read_bytes()).hexdigest();(root/'pnpm-lock.yaml').write_text('rewritten');out=Path(td)/'dirty.json'
   with patch.object(m,'SOURCE',sha),patch.object(m,'LOCK',lock),self.assertRaisesRegex(ValueError,'Source provenance'):self.inspect(m,root,out)
   evidence=json.loads(out.read_text());self.assertFalse(evidence['clean']);self.assertFalse(evidence['lockMatches']);self.assertIn('pnpm-lock.yaml',evidence['tracked'])
 def test_untracked_source_and_staged_mutation_fail_closed(self):
  for kind in ('untracked','staged'):
   m=load()
   with tempfile.TemporaryDirectory() as td:
    root=Path(td)/'repo';root.mkdir();sha=self.repo(root);out=Path(td)/'dirty.json';(root/'new-source.ts').write_text('mutation')
    if kind=='staged':subprocess.run(['git','-C',str(root),'add','new-source.ts'],check=True)
    with patch.object(m,'SOURCE',sha),patch.object(m,'LOCK',hashlib.sha256((root/'pnpm-lock.yaml').read_bytes()).hexdigest()),self.assertRaisesRegex(ValueError,'Source provenance'):self.inspect(m,root,out)
    self.assertIn('new-source.ts',json.loads(out.read_text())[kind if kind=='untracked' else 'tracked'])
 def test_staged_change_canceled_only_in_worktree_still_fails(self):
  m=load()
  with tempfile.TemporaryDirectory() as td:
   root=Path(td)/'repo';root.mkdir();sha=self.repo(root);lock=hashlib.sha256((root/'pnpm-lock.yaml').read_bytes()).hexdigest();out=Path(td)/'dirty.json'
   (root/'pnpm-lock.yaml').write_text('staged mutation');subprocess.run(['git','-C',str(root),'add','pnpm-lock.yaml'],check=True);(root/'pnpm-lock.yaml').write_text('fixed lock\n')
   with patch.object(m,'SOURCE',sha),patch.object(m,'LOCK',lock),self.assertRaisesRegex(ValueError,'Source provenance'):self.inspect(m,root,out)
   self.assertIn('pnpm-lock.yaml',json.loads(out.read_text())['tracked'])
 def test_excessive_paths_fail_closed_with_diagnostic_without_restore(self):
  m=load()
  with tempfile.TemporaryDirectory() as td:
   root=Path(td)/'repo';root.mkdir();sha=self.repo(root);out=Path(td)/'dirty.json'
   for i in range(6):(root/f'untracked-{i}').write_text('keep')
   with patch.object(m,'MAX_SOURCE_PATHS',4),patch.object(m,'SOURCE',sha),patch.object(m,'LOCK',hashlib.sha256((root/'pnpm-lock.yaml').read_bytes()).hexdigest()),self.assertRaises(ValueError):self.inspect(m,root,out)
   evidence=json.loads(out.read_text());self.assertFalse(evidence['clean']);self.assertEqual(evidence['error'],'path_bound');self.assertTrue((root/'untracked-5').exists())
 def test_evidence_is_exclusive_and_symlink_target_is_untouched(self):
  m=load()
  with tempfile.TemporaryDirectory() as td:
   root=Path(td)/'repo';root.mkdir();sha=self.repo(root);target=Path(td)/'target';target.write_text('keep');out=Path(td)/'dirty.json';out.symlink_to(target)
   with patch.object(m,'SOURCE',sha),patch.object(m,'LOCK',hashlib.sha256((root/'pnpm-lock.yaml').read_bytes()).hexdigest()),self.assertRaises(FileExistsError):self.inspect(m,root,out)
   self.assertEqual(target.read_text(),'keep')

if __name__=='__main__':unittest.main()
