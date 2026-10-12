import copy,hashlib,json,os,subprocess,tempfile,unittest,io,types
from pathlib import Path
from unittest.mock import patch
from fixtures import inventory,ROOT
import source as s,manifest,validate as v
from common import canonical,digest

class ImmutableTrackedSource(unittest.TestCase):
 def seed(self,root):
  def git(*args):return subprocess.check_output(['git','-C',str(root),*args],text=True).strip()
  git('init','-q');git('config','core.ignorecase','false');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid')
  (root/'tests').mkdir();(root/'tests/example.test.ts').write_text('original assertions\n');(root/'pnpm-lock.yaml').write_text('lock');(root/'.gitignore').write_text('/output/\n');(root/'link').symlink_to('tests/example.test.ts')
  git('add','.');git('commit','-qm','base');source=git('rev-parse','HEAD')
  tracked={}
  for row in subprocess.check_output(['git','-C',str(root),'ls-tree','-rlz','HEAD']).decode().split('\0')[:-1]:
   metadata,name=row.split('\t');mode,kind,sha,size=metadata.split();tracked[name]=[mode,sha,int(size)]
  s.SOURCE=source;s.LOCK=digest((root/'pnpm-lock.yaml').read_bytes());s.TRACKED=tracked;s.TRACKED_DIGEST=digest(canonical(tracked));return git,tracked
 def probe(self,root,out):return s.check_source(root,out,'postinstall','e2e')
 def test_clean_actual_bytes_symlink_and_host_proof_are_bound_to_prework_inventory(self):
  with tempfile.TemporaryDirectory() as td:
   root=Path(td)/'repo';root.mkdir();self.seed(root);value=self.probe(root,Path(td)/'guard')
   self.assertEqual(value['actualTrackedInventorySha256'],s.TRACKED_DIGEST);self.assertEqual(value['trackedFilesChecked'],4);self.assertTrue(value['indexFlagsClean']);self.assertTrue(value['ignorePolicyClean'])
 def test_assume_unchanged_skip_worktree_and_local_exclude_cannot_hide_source(self):
  for kind in ('assume-unchanged','skip-worktree','local-exclude'):
   with self.subTest(kind=kind),tempfile.TemporaryDirectory() as td:
    root=Path(td)/'repo';root.mkdir();git,_=self.seed(root);out=Path(td)/'guard'
    if kind=='local-exclude':
     with (root/'.git/info/exclude').open('a') as file:file.write('\n/generated.py\n')
     (root/'generated.py').write_text('hidden generated source')
    else:
     git('update-index','--'+kind,'tests/example.test.ts');(root/'tests/example.test.ts').write_text('assertions removed\n')
    with self.assertRaises(ValueError):self.probe(root,out)
    self.assertFalse(json.loads(out.read_text())['clean']);self.assertTrue((root/'tests/example.test.ts').exists())
 def test_global_ignore_override_and_index_authority_tampering_rejected(self):
  for kind in ('global','index'):
   with tempfile.TemporaryDirectory() as td:
    root=Path(td)/'repo';root.mkdir();git,_=self.seed(root)
    if kind=='global':
     ignore=Path(td)/'global-ignore';ignore.write_text('generated.py\n');git('config','core.excludesFile',str(ignore));(root/'generated.py').write_text('hidden')
    else:git('update-index','--cacheinfo','100644,'+'a'*40+',tests/example.test.ts')
    with self.assertRaises(ValueError):self.probe(root,Path(td)/'guard')
 def test_changed_executable_mode_target_or_ancestor_symlink_rejected(self):
  for kind in ('mode','target','ancestor'):
   with tempfile.TemporaryDirectory() as td:
    root=Path(td)/'repo';root.mkdir();self.seed(root)
    if kind=='mode':(root/'tests/example.test.ts').chmod(0o755)
    elif kind=='target':(root/'link').unlink();(root/'link').symlink_to('/outside/secret')
    else:
     external=Path(td)/'external';(root/'tests').rename(external);(root/'tests').symlink_to(external,target_is_directory=True)
    with self.assertRaises(ValueError):self.probe(root,Path(td)/'guard')
 def test_manifest_retains_all_blob_modes_hashes_sizes_and_bounded_transport(self):
  value=inventory();self.assertIn('tracked',value);self.assertIn('trackedInventorySha256',value);self.assertEqual(value['trackedInventorySha256'],digest(canonical(value['tracked'])));self.assertEqual(manifest.MAX_MANIFEST,2*1024*1024)
  for mutate in ('digest','size','mode','path','aggregate'):
   bad=copy.deepcopy(value)
   if mutate=='digest':bad['trackedInventorySha256']='a'*64
   elif mutate=='size':next(iter(bad['tracked'].values()))[2]=50*1024*1024+1
   elif mutate=='mode':next(iter(bad['tracked'].values()))[0]='160000'
   elif mutate=='path':bad['tracked']['../escape']=['100644','a'*40,1]
   else:bad['tracked']={f'blob/{i}':['100644','a'*40,50*1024*1024] for i in range(11)}
   with self.assertRaises(ValueError):manifest.check_manifest(bad)
 def test_independent_host_validator_rejects_missing_forged_integrity_proof(self):
  from fixtures import evidence
  with tempfile.TemporaryDirectory() as td:
   root=Path(td);inv,_=evidence(root);name=root/'source-unit-postinstall.json';value=json.loads(name.read_text())
   for key,wrong in [('actualTrackedInventorySha256','a'*64),('trackedFilesChecked',0),('trackedBytesChecked',0),('indexFlagsClean',False),('ignorePolicyClean',False)]:
    altered=dict(value);altered[key]=wrong;name.write_text(json.dumps(altered))
    with self.assertRaises(ValueError):v.validate_provenance(root,inv)
 def test_streaming_file_and_total_caps_and_growth_fail_closed(self):
  with tempfile.TemporaryDirectory() as td:
   root=Path(td)/'repo';root.mkdir();self.seed(root)
   import integrity
   for key in ('MAX_TRACKED_FILE','MAX_TRACKED_TOTAL'):
    with patch.object(integrity,key,1),self.assertRaises(ValueError):integrity.actual_inventory(root,s.TRACKED)
 def test_host_final_probe_uses_immutable_code_and_revalidates_manifest_digest(self):
  code=(ROOT/'scripts/ci/qualification/source.py').read_text();self.assertIn('--host-final-check',code)
  self.assertIn('load_manifest(filename,manifest_sha)',code)
  from contract import ARTIFACTS
  self.assertTrue(all('host-source-'+lane+'.json' in ARTIFACTS for lane in ('unit','mechanical','web','e2e')))

 def test_flags_are_rejected_even_when_current_file_bytes_are_unchanged(self):
  for flag in ('--assume-unchanged','--skip-worktree'):
   with tempfile.TemporaryDirectory() as td:
    root=Path(td)/'repo';root.mkdir();git,_=self.seed(root);git('update-index',flag,'tests/example.test.ts')
    with self.assertRaises(ValueError):self.probe(root,Path(td)/'guard')
 def test_host_final_stdout_is_generated_by_probe_and_forged_host_fields_fail(self):
  from fixtures import evidence
  with tempfile.TemporaryDirectory() as td:
   root=Path(td)/'repo';root.mkdir();self.seed(root);stream=io.BytesIO()
   with patch.object(s.sys,'stdout',types.SimpleNamespace(buffer=stream)):
    result=s.check_source(root,None,'host-final','e2e')
   self.assertTrue(json.loads(stream.getvalue())['clean']);self.assertEqual(result['stage'],'host-final')
  for lane in ('unit','mechanical','web','e2e'):
   with tempfile.TemporaryDirectory() as td:
    root=Path(td);inv,req=evidence(root);file=root/('host-source-'+lane+'.json');proof=json.loads(file.read_text());proof['trackedIntegrityClean']=False;file.write_text(json.dumps(proof))
    with self.assertRaises(ValueError):v.validate(root,inv,req)
 def test_empty_tracked_blobs_and_correct_executable_modes_pass(self):
  with tempfile.TemporaryDirectory() as td:
   root=Path(td)/'repo';root.mkdir();git,tracked=self.seed(root);(root/'empty').write_bytes(b'');(root/'run.sh').write_text('#!/bin/sh\n');(root/'run.sh').chmod(0o755);git('add','.');git('commit','-qm','regular executable and empty file')
   from fixtures import tracked_fixture
   s.SOURCE=git('rev-parse','HEAD');s.TRACKED=tracked_fixture(root);s.TRACKED_DIGEST=digest(canonical(s.TRACKED))
   self.assertTrue(self.probe(root,Path(td)/'guard')['clean'])
 def test_actual_aggregate_bound_rejects_growth_before_reading_over_budget(self):
  import integrity
  with tempfile.TemporaryDirectory() as td:
   root=Path(td)/'repo';root.mkdir();self.seed(root);(root/'.gitignore').write_bytes(b'x'*200);original=integrity.os.fdopen;bytes_read=[]
   class Reader:
    def __init__(self,file):self.file=file
    def __enter__(self):return self
    def __exit__(self,*args):self.file.close()
    def fileno(self):return self.file.fileno()
    def read(self,size):data=self.file.read(size);bytes_read.append(len(data));return data
   with patch.object(integrity,'MAX_TRACKED_TOTAL',100),patch.object(integrity.os,'fdopen',side_effect=lambda *a,**k:Reader(original(*a,**k))),self.assertRaises(ValueError):integrity.actual_inventory(root,s.TRACKED)
   self.assertEqual(sum(bytes_read),0)
