import copy
import json
from pathlib import Path
import tempfile
import unittest
from fixtures import ROOT,inventory,SOURCE,TREE
import validate as v
INVENTORY=inventory();LOCK=INVENTORY['lockSha256']

class EvidenceContracts(unittest.TestCase):
 def test_every_promised_phase_is_present_once_and_blocking(self):
  with tempfile.TemporaryDirectory() as root:
   path=Path(root)
   for lane,phases in v.LANE_PHASES.items():(path/('timing-'+lane+'.tsv')).write_text(''.join(p+'\t1\t0\n' for p in phases))
   v.phase_times(path)
   for lane,phases in v.LANE_PHASES.items():
    file=path/('timing-'+lane+'.tsv');original=file.read_text()
    for phase in phases:
     for replacement in ('',phase+'\t1\t1\n',phase+'\t1\t0\n'+phase+'\t1\t0\n'):
      file.write_text(original.replace(phase+'\t1\t0\n',replacement))
      with self.assertRaises(ValueError):v.phase_times(path)
     file.write_text(original)
 def test_source_inventory_covers_gallery_without_historical_totals(self):
  inventory=INVENTORY
  self.assertEqual(inventory['source'],SOURCE);self.assertEqual(inventory['tree'],TREE)
  self.assertTrue(all(name.startswith('tests/') for name in inventory['unit']))
  self.assertEqual(len(inventory['unit']),len(set(inventory['unit'])))
  self.assertEqual(set(inventory['configBlobs']),{'vitest.config.ts','vitest.e2e.config.ts','.github/workflows/ci.yml'})
 def test_reports_reject_another_lane_even_when_every_filename_matches(self):
  paths=['tests/a.test.ts']
  report=dict(success=True,numFailedTests=0,numTotalTests=1,numPassedTests=1,numPendingTests=0,testResults=[dict(name='/work/e2e/tests/a.test.ts',status='passed',assertionResults=[dict(status='passed',title='case',fullName='case',ancestorTitles=[],failureMessages=[])])])
  from unittest.mock import patch
  with patch.dict(INVENTORY,unit=paths):
   with self.assertRaisesRegex(ValueError,'root'):v.report_counts(report,'unit',INVENTORY)
   report['testResults'][0]['name']='/work/unit/tests/a.test.ts';self.assertEqual(v.report_counts(report,'unit',INVENTORY)['files'],1)
 def test_all_source_guard_artifacts_required_and_content_validated(self):
  import hashlib
  with tempfile.TemporaryDirectory() as td:
   path=Path(td);empty=hashlib.sha256(b'[]').hexdigest()
   for name in v.PROVENANCE:
    lane,stage=name.removeprefix('source-').removesuffix('.json').split('-',1)
    value=dict(source=SOURCE,actualSource=SOURCE,lane=lane,stage=stage,clean=True,lockSha256=LOCK,lockMatches=True,tracked=[],untracked=[],trackedPathsSha256=empty,untrackedPathsSha256=empty)
    (path/name).write_text(json.dumps(value))
   self.assertTrue(v.validate_provenance(path,INVENTORY))
   name=v.PROVENANCE[0];value=json.loads((path/name).read_text());value['clean']=False;(path/name).write_text(json.dumps(value))
   with self.assertRaises(ValueError):v.validate_provenance(path,INVENTORY)
 def test_icon_wrong_inventory_negative_controls_and_missing_trace_are_fatal(self):
  n=len(INVENTORY['icons']);good=dict(nextVersion='16.2.6',iconsVersion='4.3.0',comparedExports=n,svgRenderComparisons=n,distinctIconModules=n,negativeAliasControl='rejected',missingExportControl='rejected',trace=dict(optimizerRequests=1,uniqueIconLeaves=1,buildSpans=1))
  v.validate_smoke(good,INVENTORY)
  for field,value in [('comparedExports',n-1),('negativeAliasControl','accepted'),('missingExportControl','accepted'),('trace',None)]:
   wrong=copy.deepcopy(good);wrong[field]=value
   with self.assertRaises(ValueError):v.validate_smoke(wrong,INVENTORY)
 def test_real_frozen_source_helper_and_smoke_required_paths(self):
  root=ROOT/'scripts'/'ci'/'qualification'
  inner=(root/'benchmark.sh').read_text();smoke=(root/'smoke.mjs').read_text()
  self.assertIn('node scripts/ci/qualification-coverage.mjs',inner)
  self.assertIn('\"${proof[@]}\" --coverage',inner)
  self.assertIn('frozen.icons',smoke);self.assertIn('assert.throws(() => verify',smoke)
  self.assertNotIn('names.length === 264',smoke);self.assertNotIn('names.length == 264',smoke)

class TraceContracts(unittest.TestCase):
 def test_production_trace_is_recounted_against_smoke(self):
  rows=[dict(name='build-module',tags=dict(name='/node_modules/@hugeicons/core-free-icons/__barrel_optimize__')),dict(name='build-module',tags=dict(name='/node_modules/@hugeicons/core-free-icons/Icon.js'))]
  with tempfile.TemporaryDirectory() as root:
   path=Path(root);(path/'trace').write_text(json.dumps(rows)+'\n');smoke=dict(trace=dict(optimizerRequests=1,uniqueIconLeaves=1,buildSpans=2))
   self.assertEqual(v.trace_summary(path,smoke),smoke['trace'])
   smoke['trace']['buildSpans']=3
   with self.assertRaises(ValueError):v.trace_summary(path,smoke)
 def test_invalid_trace_and_symlink_are_rejected(self):
  with tempfile.TemporaryDirectory() as root:
   path=Path(root);(path/'trace').write_text('[1]')
   with self.assertRaises(ValueError):v.trace_summary(path,dict(trace={}))
   (path/'trace').unlink();(path/'other').write_text('[]');(path/'trace').symlink_to(path/'other')
   with self.assertRaises(OSError):v.trace_summary(path,dict(trace={}))

if __name__=='__main__':unittest.main()
