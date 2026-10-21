import copy,json,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from fixtures import evidence,inventory,report,request
import validate as v
from contract import ARTIFACTS,PHASES,PROVENANCE

class IndependentValidation(unittest.TestCase):
 def test_complete_dynamic_evidence_passes_without_historical_counts(self):
  with tempfile.TemporaryDirectory() as td:
   root=Path(td);inv,req=evidence(root);result=v.validate(root,inv,req)
   self.assertEqual((result['phaseCount'],result['guardCount']),(55,14));self.assertEqual(len(result['requiredElectronFiles']),13);self.assertNotIn('containerGone',result)
 def test_each_artifact_is_required(self):
  for name in ARTIFACTS:
   with self.subTest(name=name),tempfile.TemporaryDirectory() as td:
    root=Path(td);inv,req=evidence(root);(root/name).unlink()
    with self.assertRaises(ValueError):v.validate(root,inv,req)
 def test_unexpected_directory_symlink_and_fifo_rejected(self):
  for kind in ('extra','directory','symlink','fifo'):
   with self.subTest(kind=kind),tempfile.TemporaryDirectory() as td:
    root=Path(td);inv,req=evidence(root);file=root/'unit.json'
    if kind=='extra':(root/'unexpected').write_text('extra')
    else:
     file.unlink()
     if kind=='directory':file.mkdir()
     elif kind=='symlink':file.symlink_to(root/'general.json')
     else:os.mkfifo(file)
    with self.assertRaises((ValueError,OSError)):v.validate(root,inv,req)
 def test_individual_and_aggregate_bounds_rejected(self):
  for bound in ('MAX_FILE','MAX_TOTAL'):
   with tempfile.TemporaryDirectory() as td:
    root=Path(td);inv,req=evidence(root)
    with patch.object(v,bound,10),self.assertRaises(ValueError):v.validate(root,inv,req)
 def test_host_tuple_mismatch_rejected(self):
  for field,value in [('source','a'*40),('tree','b'*40),('parents',[]),('image','sha256:'+'c'*64),('harnessDigest','d'*64),('lockSha256','e'*64),('inventorySha256','f'*64),('status',1),('installCount',1),('unitWorkers',12),('generalWorkers',1),('gridWorkers',2),('clipboardWorkers',2)]:
   with self.subTest(field=field),tempfile.TemporaryDirectory() as td:
    root=Path(td);inv,req=evidence(root);meta=json.loads((root/'qualification.json').read_text());meta[field]=value;(root/'qualification.json').write_text(json.dumps(meta))
    with self.assertRaises(ValueError):v.validate(root,inv,req)
 def test_wrong_host_status_image_source_or_inventory_artifact_rejected(self):
  for name in ('exit-code','benchmark-exit-code','smoke-exit-code','source-sha','image-id','inventory-sha256'):
   with tempfile.TemporaryDirectory() as td:
    root=Path(td);inv,req=evidence(root);(root/name).write_text('wrong')
    with self.assertRaises(ValueError):v.validate(root,inv,req)
 def test_root_time_stamps_and_bounds_are_consistent(self):
  for field,value in [('wallSeconds',0),('wallSeconds',1901),('queueSeconds',1801),('startedUtc','not UTC'),('finishedUtc','2026-10-11T00:00:20Z')]:
   with tempfile.TemporaryDirectory() as td:
    root=Path(td);inv,req=evidence(root);meta=json.loads((root/'qualification.json').read_text());meta[field]=value;(root/'qualification.json').write_text(json.dumps(meta))
    with self.assertRaises(ValueError):v.validate(root,inv,req)
 def test_unit_failed_assertion_and_failed_empty_suite_rejected(self):
  inv=inventory()
  for field,value in [('success',False),('numFailedTests',1),('numFailedTestSuites',1)]:
   value_report=report(inv['unit'],'unit');value_report[field]=value
   with self.assertRaises(ValueError):v.report_counts(value_report,'unit',inv)
 def test_assertion_counts_status_identity_ancestry_and_failure_strings_checked(self):
  inv=inventory()
  for field,value in [('status','todo'),('failureMessages',['failure']),('title',None),('ancestorTitles',['x'*20000])]:
   data=report(inv['unit'],'unit');data['testResults'][0]['assertionResults'][0][field]=value
   with self.assertRaises(ValueError):v.report_counts(data,'unit',inv)
  data=report(inv['unit'],'unit');data['numPassedTests']=3
  with self.assertRaises(ValueError):v.report_counts(data,'unit',inv)
 def test_duplicate_missing_wrong_lane_and_renamed_file_rejected(self):
  inv=inventory()
  for kind in ('duplicate','missing','lane','renamed'):
   data=report(inv['unit'],'unit')
   if kind=='duplicate':data['testResults'].append(copy.deepcopy(data['testResults'][0]))
   elif kind=='missing':data['testResults'].pop()
   else:data['testResults'][0]['name']='/work/'+('web/tests/a.test.ts' if kind=='lane' else 'unit/tests/changed.test.ts')
   with self.assertRaises(ValueError):v.report_counts(data,'unit',inv)
 def test_every_measured_phase_fail_duplicate_omission_rejected(self):
  with tempfile.TemporaryDirectory() as td:
   root=Path(td);evidence(root)
   for lane,phases in PHASES.items():
    path=root/('timing-'+lane+'.tsv');original=path.read_text()
    for phase in phases:
     for replaced in ('',phase+'\t1\t1\n',phase+'\t1\t0\n'+phase+'\t1\t0\n'):
      path.write_text(original.replace(phase+'\t1\t0\n',replaced))
      with self.assertRaises(ValueError):v.phase_times(root)
     path.write_text(original)
 def test_every_guard_is_required_and_clean(self):
  for name in PROVENANCE:
   with tempfile.TemporaryDirectory() as td:
    root=Path(td);inv,req=evidence(root);guard=json.loads((root/name).read_text());guard['untracked']=['new.py'];(root/name).write_text(json.dumps(guard))
    with self.assertRaises(ValueError):v.validate_provenance(root,inv)
 def test_smoke_independent_manifest_controls_and_trace_are_binding(self):
  with tempfile.TemporaryDirectory() as td:
   root=Path(td);inv,_=evidence(root);smoke=json.loads((root/'smoke.json').read_text())
   for field,value in [('svgRenderComparisons',1),('nextVersion','0.0.0'),('negativeAliasControl','accepted'),('missingExportControl','accepted')]:
    wrong=copy.deepcopy(smoke);wrong[field]=value
    with self.assertRaises(ValueError):v.validate_smoke(wrong,inv)
   smoke['trace']['buildSpans']=3
   with self.assertRaises(ValueError):v.trace_summary(root,smoke)
 def test_web_smoke_gate_remains_diagnostic_without_qualifying_failed_unit(self):
  with tempfile.TemporaryDirectory() as td:
   root=Path(td);inv,req=evidence(root);(root/'benchmark-exit-code').write_text('1');self.assertTrue(v.web_phase_ready(root,inv))
   with self.assertRaises(ValueError):v.validate(root,inv,req)
 def test_coverage_proof_must_agree_with_full_unit_report(self):
  with tempfile.TemporaryDirectory() as td:
   root=Path(td);inv,req=evidence(root);proof=json.loads((root/'coverage.json').read_text());proof['passed']=0;(root/'coverage.json').write_text(json.dumps(proof))
   with self.assertRaises(ValueError):v.validate(root,inv,req)
 def test_duplicate_json_fields_are_rejected(self):
  with tempfile.TemporaryDirectory() as td:
   root=Path(td);inv,req=evidence(root);file=root/'unit.json';file.write_text(file.read_text().replace('"numFailedTests": 0','"numFailedTests": 1, "numFailedTests": 0'))
   with self.assertRaises(ValueError):v.validate(root,inv,req)
