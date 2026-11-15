"""Exercise the actual deploy command and Cloud Run revision -> CLI-bindings boundary."""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[2]
HELPER=ROOT/'scripts/ci/platform-preview-pair-env.py'
WORKFLOW=ROOT/'.github/workflows/platform-cloud-run.yml'

class Deployment(unittest.TestCase):
    def render(self,env):
        revision={'spec':{'containers':[{'env':env}]}}
        return subprocess.run(['python3',str(HELPER)],input=json.dumps(revision),text=True,capture_output=True)

    def test_actual_candidate_deploy_command_retains_control_and_secret_bindings(self):
        workflow=WORKFLOW.read_text()
        match=re.search(r'if ! deploy_json=\$\((gcloud run deploy .*?--format=json)\); then',workflow,re.S)
        self.assertIsNotNone(match,'Production candidate deployment must exist')
        command=match.group(1)
        with tempfile.TemporaryDirectory() as temp:
            fake=Path(temp)/'gcloud'
            fake.write_text('#!/usr/bin/env python3\nimport json,sys\nprint(json.dumps(sys.argv[1:]))\n')
            fake.chmod(0o700)
            names=set(re.findall(r'\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}',command))
            environment={**os.environ,**{name:'fixture' for name in names}}
            environment.update({'PATH':temp+os.pathsep+os.environ['PATH'],
                'preview_pair_env_bindings':'|MATRIX_PREVIEW_PAIR_ENABLED=true|MATRIX_PREVIEW_PAIR_MAINTENANCE_ENABLED=true',
                'preview_pair_secret_bindings':',MATRIX_PREVIEW_PAIR_OPERATOR_SECRET=pair-preview-operator:1,GITHUB_TOKEN=pair-preview-github:2'})
            result=subprocess.run(['bash','-c','traffic_flags=(); '+command],env=environment,text=True,capture_output=True)
            self.assertEqual(result.returncode,0,result.stderr)
            args=json.loads(result.stdout)
            values=dict(x.split('=',1) for x in args[args.index('--set-env-vars')+1][3:].split('|') if '=' in x)
            self.assertEqual(values.get('MATRIX_PREVIEW_PAIR_ENABLED'),'true','A deployment must not silently disable pair admission')
            self.assertEqual(values.get('MATRIX_PREVIEW_PAIR_MAINTENANCE_ENABLED'),'true','Cleanup/expiry must survive an unrelated deploy')
            secrets=dict(x.split('=',1) for x in args[args.index('--set-secrets')+1].split(',') if '=' in x)
            self.assertEqual(secrets.get('MATRIX_PREVIEW_PAIR_OPERATOR_SECRET'),'pair-preview-operator:1')
            self.assertEqual(secrets.get('GITHUB_TOKEN'),'pair-preview-github:2')

    def test_snapshot_uses_default_serving_revision_instead_of_pending_candidate(self):
        workflow=WORKFLOW.read_text()
        block='service_exists=0'+workflow.split('          service_exists=0',1)[1].split('          ats_env_bindings=',1)[0]
        with tempfile.TemporaryDirectory() as temp:
            fake=Path(temp)/'gcloud'
            fake.write_text("""#!/usr/bin/env python3
import json,sys
args=sys.argv[1:]
if args[:3]==['run','services','list']:
 print('other-service\\nsource')
elif args[:3]==['run','services','describe']:
 print(json.dumps({'status':{'traffic':[{'percent':100,'revisionName':'source-active'},{'percent':0,'revisionName':'source-untrusted-pending','tag':'candidate'}]}}))
elif args[:3]==['run','revisions','describe'] and args[3]=='source-active':
 print(json.dumps({'spec':{'containers':[{'env':[{'name':'MATRIX_PREVIEW_PAIR_ENABLED','value':'true'}]}]}}))
else: raise SystemExit(7)
""")
            fake.chmod(0o700)
            environment={**os.environ,'PATH':temp+os.pathsep+os.environ['PATH'],'DEPLOY_ENVIRONMENT':'production',
                'CLOUD_RUN_SERVICE':'source','GCP_PROJECT_ID':'project','GCP_REGION':'region'}
            command='set -euo pipefail; '+block+'\n printf "%s" "$preview_pair_env_bindings"'
            result=subprocess.run(['bash','-c',command],cwd=ROOT,env=environment,text=True,capture_output=True)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(result.stdout,'|MATRIX_PREVIEW_PAIR_ENABLED=true')

    def test_service_lookup_error_cannot_fall_through_to_deployment(self):
        workflow=WORKFLOW.read_text()
        block='service_exists=0'+workflow.split('          service_exists=0',1)[1].split('          ats_env_bindings=',1)[0]
        with tempfile.TemporaryDirectory() as temp:
            fake=Path(temp)/'gcloud'
            fake.write_text('#!/usr/bin/env bash\nexit 1\n')
            fake.chmod(0o700)
            environment={**os.environ,'PATH':temp+os.pathsep+os.environ['PATH'],'DEPLOY_ENVIRONMENT':'production',
                'CLOUD_RUN_SERVICE':'source','GCP_PROJECT_ID':'project','GCP_REGION':'region'}
            result=subprocess.run(['bash','-c','set -euo pipefail; '+block+'\n echo DEPLOY_WOULD_RUN'],cwd=ROOT,env=environment,text=True,capture_output=True)
            self.assertNotEqual(result.returncode,0,'A Cloud Run lookup failure must stop before deployment')
            self.assertNotIn('DEPLOY_WOULD_RUN',result.stdout)

    def test_confirmed_missing_service_can_keep_default_off_bootstrap(self):
        workflow=WORKFLOW.read_text()
        block='service_exists=0'+workflow.split('          service_exists=0',1)[1].split('          ats_env_bindings=',1)[0]
        with tempfile.TemporaryDirectory() as temp:
            fake=Path(temp)/'gcloud'
            fake.write_text('#!/usr/bin/env bash\nif [ "$1 $2 $3" != "run services list" ]; then exit 7; fi\n')
            fake.chmod(0o700)
            environment={**os.environ,'PATH':temp+os.pathsep+os.environ['PATH'],'DEPLOY_ENVIRONMENT':'production',
                'CLOUD_RUN_SERVICE':'source','GCP_PROJECT_ID':'project','GCP_REGION':'region'}
            result=subprocess.run(['bash','-c','set -euo pipefail; '+block+'\n printf "%s:%s" "$service_exists" "$preview_pair_env_bindings"'],cwd=ROOT,env=environment,text=True,capture_output=True)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(result.stdout,'0:')

    def test_preserves_literal_json_and_pinned_references_without_resolving_values(self):
        fixtures='[\n {"id":"fixture-1","ownerActorId":"owner"}\n]'
        env=[{'name':'MATRIX_PREVIEW_PAIR_ENABLED','value':'true'},
             {'name':'MATRIX_PREVIEW_PAIR_FIXTURES','value':fixtures},
             {'name':'MATRIX_PREVIEW_PAIR_OPERATOR_SECRET','valueFrom':{'secretKeyRef':{'name':'pair-preview-operator','key':'1'}}},
             {'name':'GITHUB_TOKEN','valueFrom':{'secretKeyRef':{'name':'pair-preview-github','key':'2'}}},
             {'name':'UNRELATED','value':'unrelated-must-not-be-copied'}]
        result=self.render(env)
        self.assertEqual(result.returncode,0,result.stderr)
        bindings=json.loads(result.stdout)
        self.assertIn('|MATRIX_PREVIEW_PAIR_FIXTURES='+fixtures,bindings['env'])
        self.assertIn(',GITHUB_TOKEN=pair-preview-github:2',bindings['secrets'])
        self.assertNotIn('unrelated-must-not-be-copied',result.stdout)

    def test_unconfigured_source_remains_default_off(self):
        result=self.render([{'name':'PLATFORM_RUNTIME_MODE','value':'cloud_run'}])
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(json.loads(result.stdout),{'env':'','secrets':''})

    def test_plaintext_secret_never_reaches_output(self):
        result=self.render([{'name':'MATRIX_PREVIEW_PAIR_ENABLED','value':'true'},
             {'name':'GITHUB_TOKEN','value':'do-not-print-this-test-value'}])
        self.assertEqual(result.returncode,1)
        self.assertIn('Preview-pair deployment configuration is invalid',result.stderr)
        self.assertNotIn('do-not-print-this-test-value',result.stdout+result.stderr)

    def test_delimiter_cannot_inject_extra_deployment_environment(self):
        result=self.render([{'name':'MATRIX_PREVIEW_PAIR_CONTROL_ORIGIN','value':'https://example.test|BAD=true'}])
        self.assertEqual(result.returncode,1)
        self.assertIn('Preview-pair deployment configuration is invalid',result.stderr)
        self.assertEqual(result.stdout,'')

    def test_unknown_pair_setting_blocks_instead_of_silently_dropping_it(self):
        result=self.render([{'name':'MATRIX_PREVIEW_PAIR_FUTURE_SETTING','value':'keep-me'}])
        self.assertEqual(result.returncode,1)
        self.assertIn('Preview-pair deployment configuration is invalid',result.stderr)
        self.assertEqual(result.stdout,'')

if __name__=='__main__':
    unittest.main()
