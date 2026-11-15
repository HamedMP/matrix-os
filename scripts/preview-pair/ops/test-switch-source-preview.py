import copy,datetime,importlib.util,json,pathlib,tempfile,unittest
from unittest.mock import Mock,patch
R=pathlib.Path(__file__).resolve().parent
sp=importlib.util.spec_from_file_location('switcher',R/'switch-source-preview.py');m=importlib.util.module_from_spec(sp);sp.loader.exec_module(m)
sp=importlib.util.spec_from_file_location('reader_tests',R/'test-bind-source-reader.py');old=importlib.util.module_from_spec(sp);sp.loader.exec_module(old)
class PhaseTests(unittest.TestCase):
 def source(self):
  s,cfg=old.ReaderBindingTests().source();s['template']['containers'][0]['env'].append(copy.deepcopy(m.reader.BINDING));return s,cfg
 def test_maintenance_cannot_open_admission_and_preserves_unrelated_settings(self):
  s,cfg=self.source();before=copy.deepcopy(s);p=m.build_phase_patch(s,cfg,'maintenance');e={x['name']:x for x in p['template']['containers'][0]['env']};self.assertEqual(e['MATRIX_PREVIEW_PAIR_ENABLED']['value'],'false');self.assertEqual(e['MATRIX_PREVIEW_PAIR_MAINTENANCE_ENABLED']['value'],'true');self.assertEqual(s,before)
  a=copy.deepcopy(p['template']['containers'][0]);a['env']=[x for x in a['env'] if x['name'] not in m.FLAGS];b=copy.deepcopy(s['template']['containers'][0]);b['env']=[x for x in b['env'] if x['name'] not in m.FLAGS];self.assertEqual(a,b)
 def test_admission_requires_prior_maintenance(self):
  s,cfg=self.source()
  with self.assertRaises(ValueError):m.build_phase_patch(s,cfg,'admission')
  next(x for x in s['template']['containers'][0]['env'] if x['name']=='MATRIX_PREVIEW_PAIR_MAINTENANCE_ENABLED')['value']='true'
  p=m.build_phase_patch(s,cfg,'admission');self.assertTrue(all(x['value']=='true' for x in p['template']['containers'][0]['env'] if x['name'] in m.FLAGS))
 def test_expired_window_and_github_outage_cannot_block_closing_admission(self):
  with tempfile.TemporaryDirectory() as directory:
   root=pathlib.Path(directory);now=datetime.datetime.now(datetime.timezone.utc);(root/'source-active-window.json').write_text(json.dumps({'deadline':(now-datetime.timedelta(minutes=1)).isoformat()}))
   github=Mock(side_effect=AssertionError('Closing admission must not depend on GitHub'))
   with patch.object(m,'ROOT',root),patch.object(m,'gh',github):
    m.assert_window('close');github.assert_not_called()
 def test_held_target_guard_rejects_started_or_unreviewed_runs(self):
  run={'id':43098186361,'status':'queued','head_sha':'cc366b2385dc76358539b683703058cdbcd4d911'}
  m.assert_held_stale_run(run,0,0,'MATRIX_PREVIEW_WINDOW_PAUSED')
  for changed,jobs,checks,target in [(dict(run,status='in_progress'),0,0,'MATRIX_PREVIEW_WINDOW_PAUSED'),(dict(run,id=1),0,0,'MATRIX_PREVIEW_WINDOW_PAUSED'),(dict(run,head_sha='0'*40),0,0,'MATRIX_PREVIEW_WINDOW_PAUSED'),(run,1,0,'MATRIX_PREVIEW_WINDOW_PAUSED'),(run,0,1,'MATRIX_PREVIEW_WINDOW_PAUSED'),(run,0,0,'matrix-platform')]:
   with self.subTest(changed=changed,jobs=jobs,checks=checks,target=target),self.assertRaises(RuntimeError):m.assert_held_stale_run(changed,jobs,checks,target)
 def test_phase_cannot_replace_existing_reader_or_unknown_flags(self):
  for mode in ['credential','flag','active']:
   s,cfg=self.source();e=s['template']['containers'][0]['env']
   if mode=='credential':next(x for x in e if x['name']=='GITHUB_TOKEN')['valueSource']['secretKeyRef']['version']='latest'
   if mode=='flag':next(x for x in e if x['name']=='MATRIX_PREVIEW_PAIR_ENABLED')['value']='maybe'
   if mode=='active':next(x for x in e if x['name']=='MATRIX_PREVIEW_PAIR_ENABLED')['value']='true'
   with self.subTest(mode=mode),self.assertRaises(ValueError):m.build_phase_patch(s,cfg,'maintenance')
if __name__=='__main__':unittest.main()
