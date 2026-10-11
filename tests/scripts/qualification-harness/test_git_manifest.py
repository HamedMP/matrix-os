import base64,json,os,subprocess,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
from fixtures import api_fixture,request
import manifest,common

class TrustedGitManifest(unittest.TestCase):
 def seed(self,root):
  api,_,tree,objects=api_fixture()
  for entry in tree['tree']:
   name=root/entry['path'];name.parent.mkdir(parents=True,exist_ok=True);name.write_bytes(base64.b64decode(objects[entry['sha']]['content']))
  def git(*args):return subprocess.check_output(['git','-C',str(root),*args],text=True).strip()
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');git('add','.');git('commit','-qm','base');base=git('rev-parse','HEAD')
  (root/'feature').write_text('feature');git('add','.');git('commit','-qm','head');head=git('rev-parse','HEAD');source=git('commit-tree',git('rev-parse','HEAD^{tree}'),'-p',base,'-p',head,'-m','merge');git('update-ref','refs/heads/merge',source)
  req=request();req.update(mergeSha=source,baseSha=base,headSha=head,mergeParents=[base,head]);return source,req
 def test_real_git_inventory_matches_api_without_source_execution(self):
  with tempfile.TemporaryDirectory() as td:
   root=Path(td);source,req=self.seed(root)
   value=manifest.prepare_manifest_from_git(source,req,root)
   self.assertEqual(value['source'],source);self.assertEqual(value['parents'],req['mergeParents']);self.assertEqual(value['unit'],['tests/a.test.ts','tests/a.test.tsx']);self.assertEqual(len(value['general']),14)
   self.assertEqual(value['lockSha256'],common.digest((root/'pnpm-lock.yaml').read_bytes()))
 def test_wrong_order_and_truncated_tree_fail_closed(self):
  with tempfile.TemporaryDirectory() as td:
   root=Path(td);source,req=self.seed(root);wrong=dict(req);wrong['mergeParents']=list(reversed(req['mergeParents']));wrong['baseSha'],wrong['headSha']=wrong['mergeParents']
   with self.assertRaises(ValueError):manifest.prepare_manifest_from_git(source,wrong,root)
   with patch.object(manifest,'MAX_TREE',1),self.assertRaises(ValueError):manifest.prepare_manifest_from_git(source,req,root)
 def test_preparer_uid_freshness_fixed_repo_and_exact_fetch(self):
  calls=[];value={'source':'1'*40}
  with tempfile.TemporaryDirectory() as td:
   root=Path(td)/'fresh'
   with patch.object(manifest.os,'getuid',return_value=0),self.assertRaises(ValueError):manifest.prepare_public('1'*40,'3'*40,'4'*40,root)
   self.assertFalse(root.exists())
   with patch.object(manifest.os,'getuid',return_value=10001),patch.object(manifest,'git_command',side_effect=lambda root,args,**kw:calls.append((args,kw)) or ''),patch.object(manifest,'prepare_manifest_from_git',return_value=value):
    self.assertEqual(manifest.prepare_public('1'*40,'3'*40,'4'*40,root),value)
    with self.assertRaises(FileExistsError):manifest.prepare_public('1'*40,'3'*40,'4'*40,root)
   self.assertEqual([a for a,k in calls],[['init','--quiet'],['remote','add','origin','https://github.com/HamedMP/matrix-os.git'],['fetch','--depth=2','origin','1'*40+':refs/ci/source']])
   self.assertTrue(all(0<k['deadline_seconds']<=120 for a,k in calls));self.assertFalse(any(a[0]=='checkout' for a,k in calls))
 def test_large_tree_pipe_cap_is_explicit_and_not_git_file_cap(self):
  with tempfile.TemporaryDirectory() as td:
   root=Path(td);subprocess.run(['git','init','-q',td],check=True);(root/'large').write_bytes(b'x'*(2*1024*1024))
   blob=common.git_command(root,['hash-object','-w','large']).strip()
   self.assertEqual(len(common.git_command(root,['cat-file','blob',blob],output_limit=3*1024*1024)),2*1024*1024)
 def test_symlinked_test_and_unsafe_tracked_path_rejected(self):
  api,_,tree,_=api_fixture();next(e for e in tree['tree'] if e['path']=='tests/a.test.ts')['mode']='120000'
  with self.assertRaises(ValueError):manifest.prepare_manifest('1'*40,request(),api)
  for name in ('tests/evil\n.test.ts','tests/tab\t.test.ts','tests/nul\0.test.ts'):
   with self.assertRaises(ValueError):manifest.path(name)
 def test_cli_is_isolated_fixed_entry_and_manifest_transport_has_newline(self):
  entry=Path(manifest.__file__).read_text();self.assertIn('--prepare-public',entry)
  data=manifest.manifest_bytes(manifest.prepare_manifest('1'*40,request(),api_fixture()[0]));self.assertTrue(data.endswith(b'\n'));self.assertEqual(len(data.splitlines()),1)
  self.assertLessEqual(len(data),manifest.MAX_MANIFEST)
