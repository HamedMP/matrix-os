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

it.each(['openai-codex','anthropic'] as const)('selects an advertised %s model after login instead of carrying over a foreign-provider model',async provider=>{
 const {HERMES_TERMINAL_CONFIGURE}=await import('../../packages/gateway/src/ai-providers/hermes-terminal-login.js');
 const code=`import sys,types,json
for name in ['hermes_cli','hermes_cli.auth','hermes_cli.config','hermes_cli.models','hermes_cli.model_switch_providers']:sys.modules[name]=types.ModuleType(name)
saved=[]
auth=sys.modules['hermes_cli.auth'];auth.PROVIDER_REGISTRY={p:types.SimpleNamespace(inference_base_url=u) for p,u in [('anthropic','https://api.anthropic.com'),('openai-codex','https://chatgpt.com/backend-api/codex')]}
auth._update_config_for_provider=lambda p,u,default_model:saved.append([p,u,default_model])
sys.modules['hermes_cli.config'].load_config_readonly=lambda:{'model':{'provider':'unrelated','default':'foreign/model'}}
sys.modules['hermes_cli.models'].get_default_model_for_provider=lambda p:'advertised-model'
sys.modules['hermes_cli.model_switch_providers'].list_authenticated_providers=lambda **kw:[{'slug':sys.argv[1],'is_user_defined':False,'models':['advertised-model']}]
`;
 const result=spawnSync('python3',['-c',code+HERMES_TERMINAL_CONFIGURE+'\nprint(json.dumps(saved))',provider],{encoding:'utf8',timeout:2000});
 expect(result.status).toBe(0);expect(JSON.parse(result.stdout)).toEqual([[provider,provider==='anthropic'?'https://api.anthropic.com':'https://chatgpt.com/backend-api/codex','advertised-model']]);
 const refused=spawnSync('python3',['-c',code+"sys.modules['hermes_cli.model_switch_providers'].list_authenticated_providers=lambda **kw:[]\n"+HERMES_TERMINAL_CONFIGURE,provider],{encoding:'utf8',timeout:2000});expect(refused.status).not.toBe(0);
});
