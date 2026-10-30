import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { HERMES_TERMINAL_LOGIN_COMMAND } from '../../packages/gateway/src/ai-providers/hermes-terminal-login';

// The real pinned relaunch producer + real exec boundary must preserve Matrix's
// continuation. OAuth and configuration storage are isolated fixture adapters.
it.each(['openai-codex', 'anthropic'])('selects %s after the native bootstrap replaces its interpreter', provider => {
  const root = mkdtempSync(join(tmpdir(), 'hermes-login-relaunch-'));
  try {
    mkdirSync(join(root, 'hermes_cli'));
    writeFileSync(join(root, 'hermes_cli/__init__.py'), '');
    writeFileSync(join(root, 'pinned_relaunch.py'), readFileSync(new URL('../fixtures/hermes-v0220-relaunch-command.py', import.meta.url)));
    writeFileSync(join(root, 'hermes_bootstrap.py'), `import os,sys
from pathlib import Path
from pinned_relaunch import relaunch_command
if not os.environ.get('FIXTURE_RELAUNCHED'):
 os.environ['FIXTURE_RELAUNCHED']='1'
 root=Path(os.environ['FIXTURE_ROOT'])
 command=relaunch_command(Path(sys.executable),root,sys.argv,sys.orig_argv,None)
 os.execv(sys.executable,command)
`);
    writeFileSync(join(root, 'hermes_cli/main.py'), `import hermes_bootstrap
import sys,os,json
from pathlib import Path
def main():
 assert sys.argv[1:]==['auth','add',${JSON.stringify(provider)},'--type','oauth','--no-browser']
 Path(os.environ['FIXTURE_ROOT'],'login.json').write_text(json.dumps({'provider':sys.argv[3]}))
`);
    // Exact entrypoint shape used when upstream sees argv[0] == 'hermes'.
    writeFileSync(join(root, 'hermes'), "if __name__=='__main__':\n from hermes_cli.main import main\n main()\n");
    const prelude = `import sys,types,os,json,contextlib,copy
from pathlib import Path
sys.path.insert(0,os.environ['FIXTURE_ROOT'])
for name in ['hermes_cli.auth','hermes_cli.config','hermes_cli.models','hermes_cli.model_switch_providers']:sys.modules[name]=types.ModuleType(name)
auth=sys.modules['hermes_cli.auth'];cfg=sys.modules['hermes_cli.config']
provider=sys.argv[1]
model='gpt-6.1-sol' if provider=='openai-codex' else 'claude-opus-4-6'
endpoint='https://chatgpt.com/backend-api/codex' if provider=='openai-codex' else 'https://api.anthropic.com'
row={'auth_type':'oauth','source':'manual:device_code' if provider=='openai-codex' else 'manual:hermes_pkce','access_token':'synthetic-access' if provider=='openai-codex' else 'sk-ant-oat-fixture','refresh_token':'synthetic-refresh','base_url':endpoint,'expires_at_ms':4102444800000}
auth.read_credential_pool=lambda p:[row] if Path(os.environ['FIXTURE_ROOT'],'login.json').exists() else []
auth.get_anthropic_key=lambda:''
auth.PROVIDER_REGISTRY={provider:types.SimpleNamespace(inference_base_url=endpoint)}
auth.get_config_path=lambda:Path(os.environ['FIXTURE_ROOT'],'config.json')
auth.require_readable_config_before_write=lambda path:None
auth.read_raw_config=lambda:{'model':{'provider':'auto','default':'anthropic/claude-opus-4.6'},'agent':{'max_turns':17}}
auth._auth_store_lock=contextlib.nullcontext;auth._load_auth_store=lambda:{}
auth._save_auth_store=lambda value:None
auth.atomic_config_replace=lambda path,value:path.write_text(json.dumps(value))
def clear(model):
 for key in ['api_key','key_env','api_key_env','api_mode']:model.pop(key,None)
cfg.clear_model_endpoint_credentials=clear
sys.modules['hermes_cli.models'].get_default_model_for_provider=lambda p:model
sys.modules['hermes_cli.model_switch_providers'].list_authenticated_providers=lambda **kw:[{'slug':provider,'is_user_defined':False,'models':[model]}]
`;
    const result = spawnSync('python3', ['-c', prelude + HERMES_TERMINAL_LOGIN_COMMAND, provider], {
      cwd: root, env: { PATH: process.env.PATH, HOME: root, FIXTURE_ROOT: root, PYTHONDONTWRITEBYTECODE: '1' },
      encoding: 'utf8', timeout: 5000, maxBuffer: 8192,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(root, 'login.json'), 'utf8'))).toEqual({ provider });
    expect(existsSync(join(root, 'config.json')), 'native login must continue into route configuration').toBe(true);
    const configuration = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
    expect(configuration).toEqual({
      model: { provider, default: provider === 'openai-codex' ? 'gpt-6.1-sol' : 'claude-opus-4-6', base_url: provider === 'openai-codex' ? 'https://chatgpt.com/backend-api/codex' : 'https://api.anthropic.com' },
      agent: { max_turns: 17 },
    });
    expect(result.stdout + result.stderr).not.toMatch(/synthetic-access|synthetic-refresh|sk-ant-oat-fixture/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
