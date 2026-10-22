import copy,json,subprocess,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from fixtures import api_fixture,request,evidence,SOURCE
import test_git_manifest as git_tests
import manifest,source,validate,common

def main_request(parents):
 value=request();value.update(sourceKind='main',prNumber=0,baseRef='main',headSha=SOURCE,baseSha=parents[0],mergeParents=parents)
 return value

class MainSourceContracts(unittest.TestCase):
 def test_api_inventory_binds_explicit_main_with_actual_one_or_two_parents(self):
  for parents in (['3'*40],['3'*40,'4'*40]):
   api,commit,_,_=api_fixture();commit['parents']=[dict(sha=p) for p in parents]
   value=manifest.prepare_manifest(SOURCE,main_request(parents),api)
   self.assertEqual(value['sourceKind'],'main');self.assertEqual(value['parents'],parents)
   self.assertEqual(manifest.check_manifest(value,main_request(parents)),value)
   with self.assertRaises(ValueError):manifest.check_manifest(value,request())
 def test_main_missing_kind_forged_pr_head_and_bad_parents_fail_closed(self):
  req=main_request(['3'*40,'4'*40])
  for key,value in [('sourceKind','pull-request'),('prNumber',1),('baseRef','other'),('headSha','4'*40),('baseSha','9'*40),('mergeParents',[]),('mergeParents',[SOURCE]),('mergeParents',['3'*40]*2),('mergeParents',['3'*40,'4'*40,'5'*40])]:
   bad=copy.deepcopy(req);bad[key]=value
   with self.assertRaises(ValueError):manifest.prepare_manifest(SOURCE,bad,api_fixture()[0])
  req.pop('sourceKind')
  with self.assertRaises(ValueError):manifest.prepare_manifest(SOURCE,req,api_fixture()[0])
 def test_real_git_single_parent_main_and_wrong_actual_parents(self):
  with tempfile.TemporaryDirectory() as td:
   root=Path(td);_,req=git_tests.TrustedGitManifest().seed(root);commit=req['headSha'];parents=[req['baseSha']]
   req.update(sourceKind='main',prNumber=0,baseRef='main',mergeSha=commit,headSha=commit,mergeParents=parents)
   inv=manifest.prepare_manifest_from_git(commit,req,root)
   self.assertEqual(inv['parents'],parents);self.assertEqual(inv['sourceKind'],'main')
   calls=[]
   def git_run(args):
    calls.append(args)
    if args[0] in ('fetch','checkout'):return ''
    return subprocess.check_output(['git','-C',str(root),*args],text=True,timeout=5)
   source.checkout_verified(git_run,inv)
   self.assertTrue(any(a[0]=='fetch' for a in calls))
   req['mergeParents']=['9'*40]
   with self.assertRaises(ValueError):manifest.prepare_manifest_from_git(commit,req,root)
 def test_main_preparer_does_not_execute_source_and_has_fixed_public_transport(self):
  calls=[]
  with tempfile.TemporaryDirectory() as td,patch.object(manifest.os,'getuid',return_value=10001),patch.object(manifest,'git_command',side_effect=lambda root,args,**kw:calls.append((args,kw)) or ''),patch.object(manifest,'prepare_manifest_from_git',return_value={'sourceKind':'main'}) as derive:
   manifest.prepare_public_main(SOURCE,'["'+('3'*40)+'"]',Path(td)/'fresh')
   args=derive.call_args.args
   self.assertEqual(args[1],dict(repository=manifest.REPOSITORY,sourceKind='main',prNumber=0,baseRef='main',mergeSha=SOURCE,headSha=SOURCE,baseSha='3'*40,mergeParents=['3'*40]))
   self.assertEqual([a[0] for a,k in calls],['init','remote','fetch']);self.assertTrue(all(0<k['deadline_seconds']<=120 for a,k in calls))
  for raw in ('[]','["main"]','["'+('3'*40)+'"]'+(' '*130)):
   with self.assertRaises(ValueError):manifest.prepare_public_main(SOURCE,raw,Path('/unused'))
 def test_main_complete_evidence_requires_kind_and_all_same_scope(self):
  with tempfile.TemporaryDirectory() as td:
   root=Path(td);inv,req=evidence(root);inv.update(sourceKind='main',parents=['3'*40]);req=main_request(inv['parents']);new_sha=common.digest(common.canonical(inv)+b'\n')
   (root/'inventory-sha256').write_text(new_sha)
   for p in root.glob('*.json'):
    value=json.loads(p.read_text())
    if isinstance(value,dict) and 'inventorySha256' in value:value['inventorySha256']=new_sha
    if p.name=='qualification.json':value.update(sourceKind='main',parents=inv['parents'])
    p.write_text(json.dumps(value))
   proof=validate.validate(root,inv,req)
   self.assertEqual((proof['phaseCount'],proof['guardCount'],proof['independentHostSourceChecks']),(56,14,4))
   meta=json.loads((root/'qualification.json').read_text());meta.pop('sourceKind');(root/'qualification.json').write_text(json.dumps(meta))
   with self.assertRaises(ValueError):validate.validate(root,inv,req)

if __name__=='__main__':unittest.main()
