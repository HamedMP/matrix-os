import copy, importlib.util, pathlib, unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('protections', ROOT/'check-github-protections.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

class ProtectionTests(unittest.TestCase):
    def metadata(self, path):
        if path.startswith('git/ref/'): return {'object':{'sha':m.PIN}}
        if path.endswith('/deployment-branch-policies?per_page=100'): return {'total_count':1,'branch_policies':[{'name':m.BRANCH,'type':'branch'}]}
        if path.startswith('environments/'): return {'deployment_branch_policy':{'protected_branches':False,'custom_branch_policies':True},'protection_rules':[{'type':'required_reviewers','prevent_self_review':False,'reviewers':[{'reviewer':{'id':1}},{'reviewer':{'id':2}}]}]}
        if path.startswith('rulesets/'): return {'target':'branch','enforcement':'active','bypass_actors':[],'conditions':{'ref_name':{'include':['refs/heads/preview-pair-controller/'+p for p in [m.PIN,m.OLD]],'exclude':[]}},'rules':[{'type':t} for t in ['update','deletion','non_fast_forward']]}
        if path.startswith('actions/variables/'): return {'value':m.PIN}
        raise AssertionError(path)
    def test_allows_authorized_self_review_without_writing(self):
        with patch.object(m,'get',side_effect=self.metadata): m.main()
    def test_rejects_unlocked_ref_bypass_wrong_branch_or_missing_reviewer(self):
        for fault in ['bypass','rule','branch','reviewer','pin']:
            def response(path):
                d=copy.deepcopy(self.metadata(path))
                if fault=='bypass' and path.startswith('rulesets/'): d['bypass_actors']=[{'actor_id':1}]
                if fault=='rule' and path.startswith('rulesets/'): d['rules'].pop()
                if fault=='branch' and 'branch-policies?' in path: d['branch_policies'][0]['name']='main'
                if fault=='reviewer' and path=='environments/collaboration-preview-control': d['protection_rules'][0]['reviewers'].pop()
                if fault=='pin' and path.startswith('actions/variables/'): d['value']='0'*40
                return d
            with self.subTest(fault=fault), patch.object(m,'get',side_effect=response), self.assertRaises(ValueError): m.main()
if __name__=='__main__': unittest.main()
