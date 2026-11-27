import copy,importlib.util,pathlib,unittest
ROOT=pathlib.Path(__file__).resolve().parent
sp=importlib.util.spec_from_file_location('binding',ROOT/'bind-source-reader.py');m=importlib.util.module_from_spec(sp);sp.loader.exec_module(m)
sp=importlib.util.spec_from_file_location('previous_tests',ROOT/'test-source-disabled-config.py');prev=importlib.util.module_from_spec(sp);sp.loader.exec_module(prev)
class ReaderBindingTests(unittest.TestCase):
 def source(self,worker=False):
  old=prev.SourceConfigurationTests();s=old.base(worker);cfg=old.cfg();s['template']['containers'][0]['env'] +=[{'name':k,'value':v} for k,v in cfg.items()]+[copy.deepcopy(m.base.OPERATOR)];return s,cfg
 def test_adds_only_pinned_reader_reference_preserving_container_configuration(self):
  for worker in [False,True]:
   s,cfg=self.source(worker);before=copy.deepcopy(s);p=m.build_reader_patch(s,cfg);self.assertEqual(s,before)
   actual=p['template']['containers'][0];expected=copy.deepcopy(s['template']['containers'][0]);expected['env'].append(m.BINDING)
   self.assertEqual(actual,expected);self.assertEqual(p['etag'],s['etag']);self.assertEqual(p['traffic'][1],s['traffic'][1])
 def test_exact_existing_binding_is_idempotent(self):
  s,cfg=self.source();s['template']['containers'][0]['env'].append(copy.deepcopy(m.BINDING));self.assertEqual(m.build_reader_patch(s,cfg)['template']['containers'][0]['env'],s['template']['containers'][0]['env'])
 def test_refuses_plaintext_different_secret_or_mutable_version(self):
  for entry in [{'name':'GITHUB_TOKEN','value':'never-copy'}, {'name':'GITHUB_TOKEN','valueSource':{'secretKeyRef':{'secret':'different','version':'1'}}},{'name':'GITHUB_TOKEN','valueSource':{'secretKeyRef':{'secret':'matrix-pair-preview-source-github-token','version':'latest'}}}]:
   s,cfg=self.source();s['template']['containers'][0]['env'].append(entry)
   with self.subTest(entry=entry),self.assertRaises(ValueError):m.build_reader_patch(s,cfg)
 def test_refuses_missing_or_active_pair_configuration(self):
  for mode in ['missing','enabled']:
   s,cfg=self.source();env=s['template']['containers'][0]['env']
   if mode=='missing':env[:]=[x for x in env if x['name']!='MATRIX_PREVIEW_PAIR_CONTROL_ORIGIN']
   else:next(x for x in env if x['name']=='MATRIX_PREVIEW_PAIR_ENABLED')['value']='true'
   with self.subTest(mode=mode),self.assertRaises(ValueError):m.build_reader_patch(s,cfg)
if __name__=='__main__':unittest.main()
