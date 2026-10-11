import hashlib,json,os,subprocess,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from fixtures import inventory,SOURCE,ROOT
import source as s
import common
from common import canonical,digest
import manifest

class PublicSourceContracts(unittest.TestCase):
 def test_public_source_fetch_ref_depth_and_order_are_exact(self):
  inv=inventory();calls=[]
  def run(args):
   calls.append(args)
   return inv['source'] if args==['rev-parse','HEAD'] else inv['tree'] if args==['rev-parse','HEAD^{tree}'] else ' '.join(inv['parents']) if args[:1]==['show'] else ''
  s.checkout_verified(run,inv)
  self.assertEqual(calls[0],['fetch','--depth=2','origin',SOURCE+':refs/ci/source']);self.assertEqual(calls[1],['checkout','--detach',SOURCE])
 def test_wrong_head_tree_or_parent_order_rejected(self):
  inv=inventory()
  for step in ('HEAD','HEAD^{tree}','parents'):
   def run(args):
    return 'wrong' if args==['rev-parse',step] else inv['source'] if args==['rev-parse','HEAD'] else inv['tree'] if args==['rev-parse','HEAD^{tree}'] else ' '.join(reversed(inv['parents'])) if args[:1]==['show'] and step=='parents' else ' '.join(inv['parents']) if args[:1]==['show'] else ''
   with self.assertRaises(ValueError):s.checkout_verified(run,inv)
 def test_source_root_uid_is_required_before_any_git(self):
  with patch.object(s.os,'getuid',return_value=0),self.assertRaises(ValueError):s.prepare_source(inventory())
 def test_manifest_bytes_bound_digest_symlink_and_nonregular_checked(self):
  with tempfile.TemporaryDirectory() as td:
   root=Path(td);path=root/'input.json';data=canonical(inventory());path.write_bytes(data)
   self.assertEqual(manifest.load_manifest(path,digest(data))['source'],SOURCE)
   with self.assertRaises(ValueError):manifest.load_manifest(path,'a'*64)
   link=root/'link';link.symlink_to(path)
   with self.assertRaises(OSError):manifest.load_manifest(link,digest(data))
   with self.assertRaises((ValueError,OSError)):common.read_regular(root,100)
   with patch.object(manifest,'MAX_MANIFEST',10),self.assertRaises(ValueError):manifest.load_manifest(path,digest(data))
 def test_git_stdout_overflow_is_bounded_not_object_pack_size(self):
  with tempfile.TemporaryDirectory() as td:
   root=Path(td);subprocess.run(['git','init','-q',td],check=True);(root/'big').write_bytes(b'a'*2*1024*1024)
   # A large ordinary blob may be written; the bound applies only to pipes.
   common.git_command(root,['hash-object','-w','big'])
   with patch.object(common,'MAX_GIT_OUTPUT',16),self.assertRaises((RuntimeError,ExceptionGroup)) as caught:common.git_command(root,['hash-object','big'])
   failures=caught.exception.exceptions if isinstance(caught.exception,ExceptionGroup) else [caught.exception]
   self.assertTrue(any('output_bound' in str(error) for error in failures)) # Cleanup errors remain fatal as well.
 def test_git_timeout_reaps_owned_child_group(self):
  with tempfile.TemporaryDirectory() as td:
   with patch.object(common,'GIT_DEADLINE_SECONDS',0),self.assertRaisesRegex(RuntimeError,'deadline'):common.git_command(Path(td),['version'])
 def test_real_git_merge_checkout_and_four_lanes_preserve_parent_identity(self):
  with tempfile.TemporaryDirectory() as td:
   root=Path(td);remote=root/'public';remote.mkdir()
   def git(*args,cwd=remote):return subprocess.check_output(['git','-C',str(cwd),*args],text=True).strip()
   git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');(remote/'pnpm-lock.yaml').write_text('lock');git('add','.');git('commit','-qm','base');base=git('rev-parse','HEAD');(remote/'feature').write_text('feature');git('add','.');git('commit','-qm','head');head=git('rev-parse','HEAD');tree=git('rev-parse','HEAD^{tree}');commit=git('commit-tree',tree,'-p',base,'-p',head,'-m','merge');git('update-ref','refs/heads/public-merge',commit)
   work=root/'work';work.mkdir();unit=work/'unit';unit.mkdir();git('init','-q',cwd=unit);git('remote','add','origin',remote.as_uri(),cwd=unit)
   inv=inventory();inv.update(source=commit,tree=tree,parents=[base,head])
   s.checkout_verified(lambda args:common.git_command(unit,args),inv)
   with patch.object(s,'SOURCE',commit):s.clone_lanes(work)
   for lane in ('unit','mechanical','web','e2e'):
    self.assertEqual(git('show','-s','--format=%P','HEAD',cwd=work/lane),base+' '+head);self.assertFalse((work/lane/'.git/objects/info/alternates').exists())
 def test_source_entry_runs_isolated_python_and_only_fixed_manifest_path(self):
  script=(ROOT/'scripts/ci/qualification/benchmark.sh').read_text();self.assertIn('python3 -I /opt/matrix-ci/qualification/source.py',script);self.assertIn('/work/qualification-input.json',script)
  self.assertNotIn('source.bundle',script)
