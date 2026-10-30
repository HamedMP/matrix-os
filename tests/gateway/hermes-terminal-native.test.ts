import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { HERMES_TERMINAL_OAUTH_VERIFY } from '../../packages/gateway/src/ai-providers/hermes-terminal-login.js';
const prelude=`import sys,types
for name in ['hermes_cli','hermes_cli.auth']:
 sys.modules[name]=types.ModuleType(name)
auth=sys.modules['hermes_cli.auth']
auth.get_anthropic_key=lambda:''
row={'auth_type':'oauth','source':'manual:hermes_pkce','access_token':'sk-ant-oat01-fixture','refresh_token':'fixture-refresh','base_url':'https://api.anthropic.com','expires_at_ms':4102444800000}
auth.read_credential_pool=lambda provider:[row]
`;
function verify(provider:string,extra=''){
 const result=spawnSync('python3',['-c',prelude+extra+HERMES_TERMINAL_OAUTH_VERIFY,provider],{encoding:'utf8',timeout:2000,maxBuffer:1024});
 expect(result.stdout+result.stderr).not.toMatch(/fixture-refresh|sk-ant-oat01-fixture/);
 return {code:result.status,stdout:result.stdout,stderr:result.stderr};
}
it('verifies a Hermes-owned Claude OAuth credential without emitting secrets',()=>expect(verify('anthropic')).toEqual({code:0,stdout:'verified\n',stderr:''}));
it.each(["row['auth_type']='api_key'\n","row['source']='claude_code'\n","auth.get_anthropic_key=lambda:'shadow-key'\n","row['expires_at_ms']=1\n","row['base_url']='https://outside.invalid'\n"] )('rejects an API, borrowed, shadowed, expired or custom origin: %s',extra=>expect(verify('anthropic',extra).code).toBe(1));
it('verifies only the selected ChatGPT device-code provider',()=>{
 const extra="row.update(source='manual:device_code',base_url='https://chatgpt.com/backend-api/codex')\n";
 expect(verify('openai-codex',extra).code).toBe(0);expect(verify('anthropic',extra).code).toBe(1);expect(verify('openrouter',extra).code).toBe(1);
});

// Keep the real pinned helper semantics; storage is memory-only and no login runs.
const configHelpers = readFileSync(new URL('../fixtures/hermes-v0220-config-helpers.py', import.meta.url), 'utf8');
const configurePrelude = `import sys,types,json,copy,contextlib,typing
for name in ['hermes_cli','hermes_cli.auth','hermes_cli.config','hermes_cli.models','hermes_cli.model_switch_providers']:sys.modules[name]=types.ModuleType(name)
auth=sys.modules['hermes_cli.auth'];cfg=sys.modules['hermes_cli.config']
provider=sys.argv[1];before=sys.argv[2];old_model=sys.argv[3]
chosen={'anthropic':'claude-opus-4-6','openai-codex':'gpt-5.4'}[provider]
document={'model':{'provider':before,'default':old_model,'temperature':0.25,'key_env':'OLD_KEY','api_key':'synthetic-only'},'agent':{'max_turns':17}}
writes=[];store={'untouched':'preserve'}
class NoWritePath:
 @property
 def parent(self):return self
 def mkdir(self,**kwargs):pass
 def __fspath__(self):return '/synthetic/config.yaml'
def replace(path,value):
 writes.append(copy.deepcopy(value));document.clear();document.update(copy.deepcopy(value))
def save_store(value):store.clear();store.update(value)
for module in [auth,cfg]:
 module.get_config_path=NoWritePath
 module.require_readable_config_before_write=lambda path:copy.deepcopy(document)
 module.read_raw_config=lambda:copy.deepcopy(document)
 module.atomic_config_replace=replace
cfg.load_config_readonly=lambda:copy.deepcopy(document)
auth._auth_store_lock=contextlib.nullcontext;auth._load_auth_store=lambda:dict(store);auth._save_auth_store=save_store
auth._nonempty_str=lambda value:isinstance(value,str) and bool(value.strip())
auth.PROVIDER_REGISTRY={p:types.SimpleNamespace(inference_base_url=u) for p,u in [('anthropic','https://api.anthropic.com'),('openai-codex','https://chatgpt.com/backend-api/codex')]}
namespace={'Optional':typing.Optional,'Any':typing.Any,'Path':NoWritePath}
exec(${JSON.stringify(configHelpers)},namespace)
cfg.clear_model_endpoint_credentials=namespace['clear_model_endpoint_credentials']
namespace.update(auth.__dict__);auth._update_config_for_provider=namespace['_update_config_for_provider']
sys.modules['hermes_cli.models'].get_default_model_for_provider=lambda p:chosen
sys.modules['hermes_cli.model_switch_providers'].list_authenticated_providers=lambda **kw:[{'slug':provider,'is_user_defined':False,'models':[chosen]}]
`;
it.each([
 ['anthropic','openai-codex','gpt-5.4','claude-opus-4-6'],
 ['openai-codex','anthropic','claude-opus-4-6','gpt-5.4'],
 ['anthropic','anthropic','claude-opus-4-6','claude-opus-4-6'],
 ['openai-codex','openai-codex','gpt-5.4','gpt-5.4'],
])('atomically selects advertised %s model from existing %s configuration',async(provider,before,oldModel,want)=>{
 const {HERMES_TERMINAL_CONFIGURE}=await import('../../packages/gateway/src/ai-providers/hermes-terminal-login.js');
 const result=spawnSync('python3',['-I','-B','-c',configurePrelude+'\nexec('+JSON.stringify(HERMES_TERMINAL_CONFIGURE)+',{})\nprint(json.dumps({"document":document,"writes":writes,"store":store}))',provider,before,oldModel],{encoding:'utf8',timeout:2000,maxBuffer:16384});
 expect(result.status,result.stderr).toBe(0);
 const value=JSON.parse(result.stdout);
 const expected={model:{provider,default:want,base_url:provider==='anthropic'?'https://api.anthropic.com':'https://chatgpt.com/backend-api/codex',temperature:0.25},agent:{max_turns:17}};
 expect(value.document).toEqual(expected);expect(value.writes).toEqual([expected]);
 expect(value.store).toEqual({untouched:'preserve',active_provider:provider});
});
it('refuses a missing provider inventory before changing native configuration',async()=>{
 const {HERMES_TERMINAL_CONFIGURE}=await import('../../packages/gateway/src/ai-providers/hermes-terminal-login.js');
 const code=configurePrelude+"sys.modules['hermes_cli.model_switch_providers'].list_authenticated_providers=lambda **kw:[]\ntry:\n"+HERMES_TERMINAL_CONFIGURE.split('\n').map(line=>' '+line).join('\n')+"\nexcept BaseException:pass\nprint(json.dumps({'writes':writes,'store':store,'document':document}))";
 const result=spawnSync('python3',['-I','-B','-c',code,'anthropic','openai-codex','gpt-5.4'],{encoding:'utf8',timeout:2000});
 expect(result.status,result.stderr).toBe(0);const value=JSON.parse(result.stdout);expect(value.writes).toEqual([]);expect(value.store).toEqual({untouched:'preserve'});expect(value.document.model.provider).toBe('openai-codex');
});
