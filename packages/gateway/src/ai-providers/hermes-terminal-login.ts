import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { relative, resolve } from 'node:path';
import { buildHermesNativeEnvironment } from '../hermes-native-environment.js';
import { resolveHermesPython } from '../chat/hermes-python-environment.js';
import { resolveHermesNativeRoot } from '../agent-config/hermes-native-credential-kind.js';
import { ProviderWorkflowNotStartedError } from './provider-workflows.js';
import type { HermesLoginProvider, HermesTerminalLoginRuntime } from './hermes-terminal-workflow.js';

export const HERMES_TERMINAL_AUTH_PROBE = `
import sys, os, socket, contextlib
socket.socket.connect = lambda *a, **k: (_ for _ in ()).throw(RuntimeError('Network unavailable'))
with open(os.devnull, 'w') as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
    from hermes_cli.auth_commands import auth_add_command, _OAUTH_ADD_SPECS
    from hermes_cli.subcommands.auth import build_auth_parser
    from hermes_cli.models import get_default_model_for_provider
    from hermes_cli.model_switch_providers import list_authenticated_providers
    assert all(callable(fn) for fn in [auth_add_command, build_auth_parser, get_default_model_for_provider, list_authenticated_providers])
    assert all(callable(_OAUTH_ADD_SPECS[p].login) for p in ['openai-codex', 'anthropic'])
print('supported')
`;
export const HERMES_TERMINAL_OAUTH_VERIFY = `
import sys, os, json, math, time, contextlib, socket
socket.socket.connect = lambda *a, **k: (_ for _ in ()).throw(RuntimeError('Network unavailable'))
try:
    with open(os.devnull, 'w') as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
        from hermes_cli.auth import read_credential_pool, get_anthropic_key
        provider = sys.argv[1]
        assert provider in ('anthropic', 'openai-codex')
        if provider == 'anthropic': assert not get_anthropic_key()
        rows = read_credential_pool(provider)
        assert isinstance(rows, list) and 0 < len(rows) <= 32
        for row in rows:
            assert isinstance(row, dict) and row.get('auth_type') == 'oauth'
            assert isinstance(row.get('access_token'), str) and row['access_token']
            assert isinstance(row.get('refresh_token'), str) and row['refresh_token']
            assert row.get('last_status') in (None, 'ok') and not row.get('model_cooldowns')
            assert not any(row.get(k) is not None for k in ['last_error_code','last_error_reason','last_error_message','last_error_reset_at'])
            if provider == 'anthropic':
                assert row.get('source') == 'manual:hermes_pkce' and row['access_token'].startswith('sk-ant-oat')
                assert row.get('base_url', '').rstrip('/') == 'https://api.anthropic.com'
                expiry = row.get('expires_at_ms')
                assert type(expiry) in (int, float) and math.isfinite(expiry) and expiry > time.time()*1000
            else:
                assert row.get('source') in ('manual:device_code', 'manual:loopback_pkce')
                assert row.get('base_url', '').rstrip('/') == 'https://chatgpt.com/backend-api/codex'
    print('verified')
except BaseException:
    sys.exit(1)
`;

/** Finish native selection from that provider's own advertised inventory only. */
export const HERMES_TERMINAL_CONFIGURE = `
import sys
from hermes_cli.auth import PROVIDER_REGISTRY, _update_config_for_provider
from hermes_cli.config import load_config_readonly
from hermes_cli.models import get_default_model_for_provider
from hermes_cli.model_switch_providers import list_authenticated_providers
provider = sys.argv[1]
assert provider in ('openai-codex', 'anthropic')
endpoint = PROVIDER_REGISTRY[provider].inference_base_url
assert endpoint.rstrip('/') == {'anthropic':'https://api.anthropic.com','openai-codex':'https://chatgpt.com/backend-api/codex'}[provider]
rows = [row for row in list_authenticated_providers(current_provider=provider, probe_custom_providers=False, non_blocking_catalogs=True) if row.get('slug') == provider]
assert len(rows) == 1 and rows[0].get('is_user_defined') is False
models = rows[0].get('models')
assert isinstance(models, list) and 0 < len(models) <= 512 and all(isinstance(model,str) and 0 < len(model) <= 160 for model in models)
config = load_config_readonly(); current = config.get('model', {})
current = current if isinstance(current, dict) else {}
preferred = get_default_model_for_provider(provider)
model = current.get('default') if current.get('provider') == provider else None
if model not in models: model = preferred if preferred in models else models[0]
_update_config_for_provider(provider, endpoint, default_model=model)
`;
export const HERMES_TERMINAL_LOGIN_COMMAND = `
import sys, os, contextlib
provider = sys.argv[1]
assert provider in ('openai-codex','anthropic')
sys.argv = ['hermes','auth','add',provider,'--type','oauth','--no-browser']
from hermes_cli.main import main
main()
sys.argv = ['hermes-native-login',provider]
with open(os.devnull,'w') as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
    exec(${JSON.stringify(HERMES_TERMINAL_OAUTH_VERIFY)})
${HERMES_TERMINAL_CONFIGURE}
`;

/** Credentials and OAuth prompts remain entirely in the owner's Terminal. */
export function createHermesTerminalLoginRuntime(options: {
 homePath: string;
 enableConnected(id: string, provider: HermesLoginProvider, key: string, expectedRevision: number): Promise<void>;
}): HermesTerminalLoginRuntime & {available(): Promise<boolean>} {
 const home=resolve(options.homePath);
 let capability: {at:number;value:boolean}|undefined; let probing: Promise<boolean>|undefined;
 const qualify=async()=>{
  const cwd=await resolveHermesNativeRoot(home);const python=await resolveHermesPython(cwd);
  const env=buildHermesNativeEnvironment(home,cwd);
  const {stdout}=await promisify(execFile)(python,['-c',HERMES_TERMINAL_AUTH_PROBE],{cwd,env,timeout:5000,maxBuffer:1024,killSignal:'SIGKILL'});
  if(stdout.trim() !== 'supported') throw new ProviderWorkflowNotStartedError();
  return {cwd,python,env};
 };
 return {
  async available(){
   if(capability && Date.now()-capability.at < 15000) return capability.value;
   probing ??= qualify().then(()=>true).catch(error=>{console.warn('[provider-workflow] Hermes terminal login unavailable:',error instanceof Error ? error.name : 'UnknownError');return false;}).then(value=>{capability={at:Date.now(),value};return value;});
   try{return await probing;}finally{probing=undefined;}
  },
  async prepare(provider){
   if(!['openai-codex','anthropic'].includes(provider)) throw new ProviderWorkflowNotStartedError();
   const {cwd,python,env}=await qualify();
   // Terminal resolves a home-relative cwd and enforces canonical containment.
   return {cwd:relative(home,cwd),command:['env','-i',...Object.entries(env).map(([key,value])=>`${key}=${value}`),python,'-c',HERMES_TERMINAL_LOGIN_COMMAND,provider]};
  },
  async complete(id,provider,revision,key,signal){
   signal.throwIfAborted();
   const {cwd,python,env}=await qualify();
   const {stdout}=await promisify(execFile)(python,['-c',HERMES_TERMINAL_OAUTH_VERIFY,provider],{cwd,env,timeout:5000,maxBuffer:1024,killSignal:'SIGKILL'});
   if(stdout.trim() !== 'verified') throw new ProviderWorkflowNotStartedError();
   signal.throwIfAborted();
   // Native observation supplies the credential origin; the existing atomic route
   // writer refuses absent/unverified profiles and concurrent owner changes.
   await options.enableConnected(id,provider,`hermes-terminal-${key}`,revision);
  },
 };
}
