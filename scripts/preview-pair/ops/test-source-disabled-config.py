import copy,importlib.util,pathlib,unittest
from unittest.mock import Mock
P=pathlib.Path(__file__).with_name('configure-source-disabled.py')
spec=importlib.util.spec_from_file_location('source_config',P);mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
class SourceConfigurationTests(unittest.TestCase):
 def base(self,worker=False):
  name='matrix-platform-worker' if worker else 'matrix-platform'
  return {'name':'projects/matrix-os-1144/locations/europe-west3/services/'+name,'etag':'etag-current','reconciling':False,'terminalCondition':{'state':'CONDITION_SUCCEEDED'},'template':{'revision':'old-revision','serviceAccount':'matrix-platform-runner@matrix-os-1144.iam.gserviceaccount.com','timeout':'3600s','scaling':{'maxInstanceCount':30},'containers':[{'image':mod.IMAGE,'resources':{'limits':{'cpu':'2','memory':'2Gi'}},'env':[{'name':'PLATFORM_BACKGROUND_WORKERS_ENABLED','value':str(worker).lower()},{'name':'CUSTOMER_SETTING','value':'keep-me'},{'name':'PLATFORM_SECRET','valueSource':{'secretKeyRef':{'secret':'platform-secret','version':'latest'}}}]}]},'traffic':[{'revision':'old-revision','percent':100,'type':'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION'},{'revision':'unrelated-tagged','tag':'other-engineer','type':'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION'}]}
 def cfg(self): return {'MATRIX_PREVIEW_PAIR_ENABLED':'false','MATRIX_PREVIEW_PAIR_MAINTENANCE_ENABLED':'false','MATRIX_PREVIEW_PAIR_CONTROL_ORIGIN':'https://app.matrix-os.com'}
 def test_preserves_customer_configuration_and_uses_current_etag(self):
  s=self.base();before=copy.deepcopy(s);p=mod.build_patch(s,self.cfg());self.assertEqual(s,before);self.assertEqual(p['etag'],'etag-current');t=p['template'];self.assertNotIn('revision',t);self.assertEqual(t['timeout'],'3600s');self.assertEqual(t['containers'][0]['resources'],before['template']['containers'][0]['resources']);env={x['name']:x for x in t['containers'][0]['env']};self.assertEqual(env['PLATFORM_SECRET'],before['template']['containers'][0]['env'][2]);self.assertEqual(env['CUSTOMER_SETTING']['value'],'keep-me');self.assertEqual(t['containers'][0]['image'],mod.IMAGE)
 def test_preserves_other_engineer_tags(self):
  s=self.base();p=mod.build_patch(s,self.cfg());self.assertEqual(p['traffic'][1],s['traffic'][1]);self.assertEqual(p['traffic'][0],{'type':'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST','percent':100})
 def test_keeps_worker_roles_and_binds_only_operator(self):
  for worker in [False,True]:
   p=mod.build_patch(self.base(worker),self.cfg());e={x['name']:x for x in p['template']['containers'][0]['env']};self.assertEqual(e['PLATFORM_BACKGROUND_WORKERS_ENABLED']['value'],str(worker).lower());self.assertNotIn('GITHUB_TOKEN',e);self.assertEqual(e['MATRIX_PREVIEW_PAIR_OPERATOR_SECRET']['valueSource']['secretKeyRef'],{'secret':'matrix-pair-preview-operator-secret','version':'1'})
 def test_cannot_enable_admission_or_maintenance(self):
  for flag in ['MATRIX_PREVIEW_PAIR_ENABLED','MATRIX_PREVIEW_PAIR_MAINTENANCE_ENABLED']:
   cfg=self.cfg();cfg[flag]='true'
   with self.assertRaises(ValueError):mod.build_patch(self.base(),cfg)
 def test_refuses_active_pair_or_unknown_current_source(self):
  for mutation in ['active','image','workers','split','reconciling','etag']:
   s=self.base()
   if mutation=='active':s['template']['containers'][0]['env'].append({'name':'MATRIX_PREVIEW_PAIR_ENABLED','value':'true'})
   if mutation=='image':s['template']['containers'][0]['image']='other-image@sha256:'+'0'*64
   if mutation=='workers':s['template']['containers'][0]['env'][0]['value']='true'
   if mutation=='split':s['traffic'][0]['percent']=50
   if mutation=='reconciling':s['reconciling']=True
   if mutation=='etag':s.pop('etag')
   with self.subTest(mutation=mutation),self.assertRaises(ValueError):mod.build_patch(s,self.cfg())
 def test_validate_only_accepts_ephemeral_service_metadata_without_polling(self):
  source=self.base();patch=mod.build_patch(source,self.cfg());cloud=object.__new__(mod.Cloud)
  metadata=copy.deepcopy(patch);metadata['@type']='type.googleapis.com/google.cloud.run.v2.Service'
  cloud.request=Mock(return_value={'name':'ephemeral-operation-not-persisted','metadata':metadata});cloud.wait=Mock(side_effect=AssertionError('validateOnly operations must not be polled'))
  cloud.validate(patch);cloud.request.assert_called_once_with(patch['name'],patch,validate=True);cloud.wait.assert_not_called()
 def test_refuses_secret_literals_or_unreviewed_configuration(self):
  for k,v in [('PLATFORM_SECRET','bad'),('MATRIX_PREVIEW_PAIR_OPERATOR_SECRET','bad'),('MATRIX_PREVIEW_PAIR_UNKNOWN','bad')]:
   cfg=self.cfg();cfg[k]=v
   with self.assertRaises(ValueError):mod.build_patch(self.base(),cfg)
if __name__=='__main__':unittest.main()
