import unittest
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[3]/'scripts'/'ci'/'qualification'))
import manifest

class PublicManifestContracts(unittest.TestCase):
 def test_repository_is_fixed(self):self.assertEqual(manifest.REPOSITORY,'HamedMP/matrix-os')
 def test_exact_fifty_five_phases_and_fourteen_guards(self):
  from contract import PHASES,PROVENANCE,ELECTRON
  self.assertEqual(sum(len(v) for v in PHASES.values()),55)
  self.assertEqual(len(PROVENANCE),14)
  self.assertEqual(len(set(p for v in ELECTRON.values() for p in v)),14) # thirteen Electron + one grid
 def test_sha_rejects_shell_and_traversal(self):
  for value in ('../main','main','A'*40,'0'*39,'0'*40+';id'):
   with self.assertRaises(ValueError):manifest.sha(value)

from fixtures import api_fixture,request,inventory,SOURCE
from unittest.mock import patch
import copy
class PublicAPIContracts(unittest.TestCase):
 def test_inventory_is_derived_from_public_source(self):
  value=inventory();self.assertEqual(value['unit'],['tests/a.test.ts','tests/a.test.tsx']);self.assertEqual(len(value['general']),14);self.assertEqual(value['tools']['icons'],'4.3.0')
 def test_wrong_commit_or_parent_order_rejected(self):
  for field in ('sha','parents'):
   api,commit,_,_=api_fixture();commit[field]='a'*40 if field=='sha' else list(reversed(commit['parents']))
   with self.assertRaises(ValueError):manifest.prepare_manifest(SOURCE,request(),api)
 def test_tree_truncation_duplicate_and_symlink_config_rejected(self):
  for kind in ('truncated','duplicate','symlink'):
   api,_,tree,_=api_fixture()
   if kind=='truncated':tree['truncated']=True
   elif kind=='duplicate':tree['tree'].append(copy.deepcopy(tree['tree'][0]))
   else:tree['tree'][0]['mode']='120000'
   with self.assertRaises(ValueError):manifest.prepare_manifest(SOURCE,request(),api)
 def test_blob_digest_size_and_encoding_must_match(self):
  for kind in ('content','size','encoding'):
   api,_,_,objects=api_fixture();value=next(iter(objects.values()));value[kind]='Y2hhbmdlZA==' if kind=='content' else 999 if kind=='size' else 'utf8'
   with self.assertRaises(ValueError):manifest.prepare_manifest(SOURCE,request(),api)
 def test_foreign_repo_head_and_base_rejected(self):
  for key,value in [('repository','other/repo'),('mergeSha','a'*40),('headSha','b'*40)]:
   req=request();req[key]=value
   with self.assertRaises(ValueError):manifest.prepare_manifest(SOURCE,req,api_fixture()[0])
 def test_literal_collection_scope_changes_fail_closed(self):
  for source in ('include: ["tests/one.test.ts"]','include: [...user]','include: ["tests/e2e/**/*.e2e.test.ts"], exclude: ["tests/e2e/desktop/**"]'):
   with self.assertRaises(ValueError):manifest.collection_scope(source,['tests/e2e/**/*.e2e.test.ts'])
 def test_redirects_and_nonpublic_endpoints_rejected(self):
  with self.assertRaises(ValueError):manifest.NoRedirect().redirect_request(None,None,302,'',None,'https://other.example')
  for endpoint in ('../secret','commits/main','git/blobs/'+'a'*40+'?secret=x'):
   with self.assertRaises(ValueError):manifest.public_api(endpoint,100)
 def test_missing_required_electron_file_rejected(self):
  api,_,tree,_=api_fixture();tree['tree']=[e for e in tree['tree'] if e['path']!='tests/e2e/desktop/terminal-clipboard.e2e.test.ts']
  with self.assertRaises(ValueError):manifest.prepare_manifest(SOURCE,request(),api)
 def test_manifest_fields_identity_and_caps_fail_closed(self):
  good=inventory()
  for key,value in [('source','main'),('unit',['../x.test.ts']),('general',[]),('requiredElectron',{}),('icons',['one']),('unitImports',{}),('lockSha256','x'),('tools',{})]:
   wrong=copy.deepcopy(good);wrong[key]=value
   with self.assertRaises(ValueError):manifest.check_manifest(wrong)

 def test_authenticated_native_actual_pair_is_independent_of_branch_base(self):
  req=request();req['baseSha']='9'*40
  value=manifest.prepare_manifest(SOURCE,req,api_fixture()[0])
  self.assertEqual(value['parents'],req['mergeParents'])
  self.assertEqual(manifest.check_manifest(value,req),value)
 def test_actual_parent_proof_cannot_change_head_pair_or_shape(self):
  for parents in ([],['3'*40],['3'*40,'4'*40,'5'*40],['4'*40,'3'*40],['4'*40,'4'*40]):
   req=request();req['mergeParents']=parents
   with self.assertRaises(ValueError):manifest.prepare_manifest(SOURCE,req,api_fixture()[0])
   with self.assertRaises(ValueError):manifest.check_manifest(inventory(),req)
