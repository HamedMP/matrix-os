import copy
import hashlib
import json
from pathlib import Path
import unittest
from fixtures import inventory, report
from coverage import coverage
import validate


def inactive_file(value, index, kind):
 file=value['testResults'][index]
 for assertion in file['assertionResults']:
  if assertion['status']=='passed':value['numPassedTests']-=1
  else:value['numPendingTests']-=1
  value['numTotalTests']-=1
 if kind=='empty':file['assertionResults']=[]
 else:
  file['status']='skipped'
  for assertion in file['assertionResults']:
   assertion['status']='skipped';value['numTotalTests']+=1;value['numPendingTests']+=1


class RequiredExecution(unittest.TestCase):
 def test_real_pinned_vitest_report_preserves_platform_skips(self):
  # Exact retained Linux reporter bytes; five passes plus two mac-only skips.
  raw=Path(__file__).with_name('vitest-4.0.18-linux-electron-drop.json').read_bytes()
  self.assertEqual(hashlib.sha256(raw).hexdigest(),'c2f1ffd291457978e9a8ac87f2cef17c909849c3f6fa9ab461b268194d679d10')
  value=json.loads(raw);inv=inventory()
  self.assertEqual({a['status'] for f in value['testResults'] for a in f['assertionResults']},{'passed','skipped'})
  for result in (validate.report_counts(value,'electron-drop',inv),coverage(value,inv['requiredElectron']['electron-drop'],'electron')):
   self.assertEqual((result['passed'],result['skipped']),(5,2))

 def test_every_required_file_needs_a_passed_assertion(self):
  inv=inventory()
  for phase,paths in inv['requiredElectron'].items():
   for index in range(len(paths)):
    for kind in ('empty','all-skipped'):
     with self.subTest(phase=phase,index=index,kind=kind):
      value=report(paths,phase);inactive_file(value,index,kind)
      with self.assertRaisesRegex(ValueError,'passed assertion'):validate.report_counts(value,phase,inv)
      with self.assertRaisesRegex(ValueError,'passed assertion'):coverage(value,paths,'grid' if phase=='grid' else 'electron')

 def test_required_files_allow_individual_platform_skips_with_active_cases(self):
  inv=inventory()
  for phase,paths in inv['requiredElectron'].items():
   value=report(paths,phase)
   skipped=copy.deepcopy(value['testResults'][0]['assertionResults'][0]);skipped['status']='skipped'
   value['testResults'][0]['assertionResults'].append(skipped)
   value['numTotalTests']+=1;value['numPendingTests']+=1
   self.assertEqual(validate.report_counts(value,phase,inv)['skipped'],1)
   self.assertEqual(coverage(value,paths,'grid' if phase=='grid' else 'electron')['skipped'],1)

 def test_full_unit_and_general_inventory_preserve_expected_inactive_files(self):
  inv=inventory()
  for phase in ('unit','general'):
   for kind in ('empty','all-skipped'):
    value=report(inv[phase],phase);inactive_file(value,0,kind)
    self.assertEqual(validate.report_counts(value,phase,inv)['files'],len(inv[phase]))
    self.assertEqual(coverage(value,inv[phase],phase)['files'],len(inv[phase]))

 def test_unobserved_pending_status_is_not_a_skip_alias(self):
  inv=inventory();value=report(inv['unit'],'unit')
  value['testResults'][0]['assertionResults'][0]['status']='pending'
  value['numPassedTests']-=1;value['numPendingTests']+=1
  with self.assertRaises(ValueError):validate.report_counts(value,'unit',inv)
  with self.assertRaises(ValueError):coverage(value,inv['unit'],'unit')


if __name__=='__main__':unittest.main()
