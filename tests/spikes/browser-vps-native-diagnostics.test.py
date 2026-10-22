import importlib.util,json,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('trial',Path(__file__).resolve().parents[2] / 'scripts/spikes/browser-vps/browser_use_agent_trial.py')
t=importlib.util.module_from_spec(spec);spec.loader.exec_module(t)
class H:
 def errors(self):return [None,'AuthenticationError sk-never-output-this invalid api key']
 def final_result(self):return 'Unable to sign in; synthetic action was rejected. sk-never-output-this'
 def is_done(self):return True
 def is_successful(self):return False
 def number_of_steps(self):return 5
 def model_actions(self):return [{'input':{'text':'sk-never-output-this'},'interacted_element':{'secret':'x'}},{'done':{'text':'failed'}},{'unsafe-user-generated-name':{}}]
class Tests(unittest.TestCase):
 def test_coarse_history_retains_outcome_not_secrets(self):
  d=t.history_diagnostics(H(),{'checkpoint':0,'workCompleted':0})
  self.assertEqual(d['model_reported_success'],False)
  self.assertEqual(d['finished_steps'],5)
  self.assertEqual(d['action_counts'],{'input':1,'done':1,'other':1})
  self.assertIn('authentication',d['diagnostic_categories'])
  self.assertIn('fixture_rejected',d['diagnostic_categories'])
  self.assertNotIn('sk-never',json.dumps(d))
 def test_exception_diagnostic_never_returns_raw_message(self):
  d=t.exception_diagnostics(RuntimeError('token-secret model_not_found'))
  self.assertEqual(d['exception_type'],'RuntimeError')
  self.assertIn('model_access',d['diagnostic_categories'])
  self.assertNotIn('token-secret',json.dumps(d))
unittest.main()
