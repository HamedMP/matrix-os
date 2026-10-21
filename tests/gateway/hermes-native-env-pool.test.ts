import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { HERMES_NATIVE_CREDENTIAL_KIND_SCRIPT } from "../../packages/gateway/src/agent-config/hermes-native-credential-kind.js";

const prelude = `
import sys,types,os,hashlib,copy
os.environ['HERMES_HOME']='/synthetic/hermes'
for name in ['hermes_cli','hermes_cli.config','hermes_cli.auth','agent','agent.anthropic_credentials','agent.credential_persistence','agent.credential_pool']:
    sys.modules[name]=types.ModuleType(name)
cfg=sys.modules['hermes_cli.config'];auth=sys.modules['hermes_cli.auth'];creds=sys.modules['agent.anthropic_credentials'];persist=sys.modules['agent.credential_persistence'];native_pool=sys.modules['agent.credential_pool']
config={'model':{'provider':'anthropic','default':'native-model','base_url':'http://127.0.0.1:18670'}}
env={'ANTHROPIC_API_KEY':'sk-ant-api03-synthetic-only','ANTHROPIC_BASE_URL':'http://127.0.0.1:18670'}
cfg.get_hermes_home=lambda:'/synthetic/hermes'
cfg.load_config_readonly=lambda:config
persist.fingerprint_secret_value=lambda value:'sha256:'+hashlib.sha256(value.encode()).hexdigest()[:16]
entry={'id':'synthetic-id','label':'private-label','auth_type':'api_key','priority':0,'source':'env:ANTHROPIC_API_KEY','base_url':'http://127.0.0.1:18670','secret_fingerprint':persist.fingerprint_secret_value(env['ANTHROPIC_API_KEY'])}
pool=[entry]
auth.read_credential_pool=lambda provider:copy.deepcopy(pool)
auth.get_anthropic_key=lambda:env['ANTHROPIC_API_KEY']
auth.PROVIDER_REGISTRY={'anthropic':types.SimpleNamespace(auth_type='api_key',inference_base_url='https://api.anthropic.com')}
native_pool.get_env_prefer_dotenv=lambda name:env.get(name,'')
creds.read_hermes_oauth_credentials=lambda:None
creds.read_claude_code_credentials=lambda:None
`;
function evaluate(extra = "") {
  const result = spawnSync("python3", ["-c", prelude + extra + "\n" + HERMES_NATIVE_CREDENTIAL_KIND_SCRIPT], {
    encoding: "utf8", timeout: 2_000, maxBuffer: 1_024,
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).not.toMatch(/sk-ant-api03-synthetic-only|private-label|synthetic-id|secret_fingerprint|18670/);
  return JSON.parse(result.stdout);
}
const expected = { providerId: "anthropic", modelId: "native-model", credentialKind: "api_key" };
it("qualifies the native sanitized single env-reference API-key row without loading or changing the pool", () => {
  expect(evaluate("auth.write_credential_pool=lambda *a:(_ for _ in ()).throw(AssertionError('Must never write'))\nnative_pool.load_pool=lambda *a:(_ for _ in ()).throw(AssertionError('Must never seed'))")).toEqual(expected);
});
it("accepts bounded native bookkeeping fields without treating them as authentication", () => {
  expect(evaluate("entry.update({'request_count':1,'last_status':None,'last_status_at':None,'last_error_code':None,'last_error_reason':None,'last_error_message':None,'last_error_reset_at':None})")).toEqual(expected);
});
it("uses the native provider default endpoint when no endpoint override exists", () => {
  expect(evaluate("config['model'].pop('base_url');env.pop('ANTHROPIC_BASE_URL');entry['base_url']='https://api.anthropic.com/'")).toEqual(expected);
});
it("preserves empty-pool API-key qualification", () => expect(evaluate("pool=[]")).toEqual(expected));
it.each([
  "entry['auth_type']='oauth'",
  "entry.pop('auth_type')",
  "pool=[None]",
  "pool={}",
  "entry['source']='env:ANTHROPIC_TOKEN'",
  "entry.pop('secret_fingerprint')",
  "entry['secret_fingerprint']='sha256:'+'0'*16",
  "entry['secret_fingerprint']=True",
  "entry['access_token']='sk-ant-api03-synthetic-only'",
  "entry['refresh_token']=None",
  "entry['agent_key']='unknown'",
  "entry['unrecognized_selector']='unknown'",
  "entry['label']='x'*1025",
  "entry['id']='x'*257",
  "entry['priority']=True",
  "entry['request_count']=-1",
  "entry['last_status_at']=float('inf')",
  "entry['last_error_message']='unresolved failure'",
  "pool.append(copy.deepcopy(entry))",
  "entry['base_url']='https://other.example'",
  "config['model']['base_url']='https://other.example'",
  "env['ANTHROPIC_BASE_URL']='https://other.example'",
  "entry['last_status']='dead'",
  "entry['model_cooldowns']={'native-model':123}",
  "creds.read_hermes_oauth_credentials=lambda:{'accessToken':'synthetic-oauth'}",
  "creds.read_claude_code_credentials=lambda:{'accessToken':'synthetic-oauth'}",
  "auth.PROVIDER_REGISTRY['anthropic'].auth_type='oauth'",
  "env['ANTHROPIC_API_KEY']='sk-ant-oat01-synthetic-oauth'",
  "env['ANTHROPIC_TOKEN']='sk-ant-api03-alternative'",
  "env['CLAUDE_CODE_OAUTH_TOKEN']='sk-ant-oat01-synthetic-oauth'",
  "env['ANTHROPIC_API_KEY_2']='sk-ant-api03-alternative'",
  "env['ANTHROPIC_TOKEN_2']='sk-ant-api03-alternative'",
  "env['CLAUDE_CODE_OAUTH_TOKEN_2']='sk-ant-oat01-synthetic-oauth'",
])("keeps ambiguous, conflicting or alternative native sources closed: %s", extra => expect(evaluate(extra)).toBeNull());
it("rejects pool changes between the two read-only observations", () => {
  expect(evaluate("reads=0\ndef rotating(provider):\n global reads\n reads+=1\n result=copy.deepcopy(pool)\n if reads>1:result[0]['id']='changed'\n return result\nauth.read_credential_pool=rotating")).toBeNull();
});
it("discards native fingerprint output and exceptions", () => {
  expect(evaluate("def noisy(key):\n print(key)\n print('private-label',file=sys.stderr)\n return 'sha256:'+hashlib.sha256(key.encode()).hexdigest()[:16]\npersist.fingerprint_secret_value=noisy")).toEqual(expected);
  expect(evaluate("persist.fingerprint_secret_value=lambda key:(_ for _ in ()).throw(RuntimeError(key))")).toBeNull();
});
