import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createHermesNativeCredentialKindReader, HERMES_NATIVE_CREDENTIAL_KIND_SCRIPT, resolveHermesNativeRoot } from '../../packages/gateway/src/agent-config/hermes-native-credential-kind.js';
const prelude = `
import sys,types,os
os.environ['HERMES_HOME']='/synthetic/hermes'
for name in ['hermes_cli','hermes_cli.config','hermes_cli.auth','agent','agent.anthropic_credentials']:
    sys.modules[name]=types.ModuleType(name)
cfg=sys.modules['hermes_cli.config']; auth=sys.modules['hermes_cli.auth']; creds=sys.modules['agent.anthropic_credentials']
cfg.get_hermes_home=lambda:'/synthetic/hermes'
cfg.load_config_readonly=lambda:{'model':{'provider':'anthropic','default':'native-model'}}
auth.get_anthropic_key=lambda:'sk-ant-api03-synthetic-only'
auth.read_credential_pool=lambda provider:[]
creds.read_hermes_oauth_credentials=lambda:None
creds.read_claude_code_credentials=lambda:None
`;
function evaluate(extra='') {
 const result=spawnSync('python3',['-c',prelude+extra+HERMES_NATIVE_CREDENTIAL_KIND_SCRIPT],{encoding:'utf8',timeout:2000,maxBuffer:1024});
 expect(result.status).toBe(0);expect(result.stdout+result.stderr).not.toContain('sk-ant-api03-synthetic-only');
 return JSON.parse(result.stdout);
}
describe('Hermes credential kind metadata',()=>{
 it('resolves the managed bash launcher and rejects a modified launcher', async()=>{
  const home=await mkdtemp(join(await realpath(tmpdir()),'matrix-hermes-reader-'));
  try {
   const root=join(home,'.hermes/hermes-agent');
   await mkdir(join(home,'.local/bin'),{recursive:true});
   await mkdir(join(root,'venv/bin'),{recursive:true});
   await mkdir(join(root,'hermes_cli'));
   await writeFile(join(root,'venv/bin/python'),'python');
   await writeFile(join(root,'hermes'),'entry');
   for (const path of [root,join(root,'hermes_cli')]) await chmod(path,0o755);
   await chmod(join(root,'venv/bin/python'),0o755);
   const launcher=join(home,'.local/bin/hermes');
   await writeFile(launcher,`#!/usr/bin/env bash\nunset PYTHONPATH\nunset PYTHONHOME\nexec "${root}/venv/bin/python" "${root}/hermes" "$@"\n`);
   await chmod(launcher,0o755);
   expect(await resolveHermesNativeRoot(home)).toBe(root);
   await writeFile(launcher,`#!/usr/bin/env bash\nexec "${root}/venv/bin/python" "${root}/hermes" "$@"\n`);
   await expect(resolveHermesNativeRoot(home)).rejects.toThrow('Native installation unavailable');
   await rm(launcher);
   await writeFile(join(root,'venv/bin/hermes'),'entry');
   await chmod(join(root,'venv/bin/hermes'),0o755);
   await symlink(join(root,'venv/bin/hermes'),launcher);
   expect(await resolveHermesNativeRoot(home)).toBe(root);
  } finally { await rm(home,{recursive:true,force:true}); }
 });
 it('emits only an exact default model and API credential kind',()=>expect(evaluate()).toEqual({providerId:'anthropic',modelId:'native-model',credentialKind:'api_key'}));
 it.each([
 "auth.get_anthropic_key=lambda:'sk-ant-oat01-synthetic-oauth'\n",
 "auth.get_anthropic_key=lambda:''\n",
 "auth.get_anthropic_key=lambda:'arbitrary-token'\n",
 "auth.read_credential_pool=lambda provider:[{'api_key':'sk-ant-api03-synthetic-only'}]\n",
 "creds.read_claude_code_credentials=lambda:{'accessToken':'synthetic-oauth'}\n",
 "creds.read_hermes_oauth_credentials=lambda:{'accessToken':'synthetic-oauth'}\n",
 "cfg.load_config_readonly=lambda:{'model':{'provider':'anthropic','default':'native-model','api_key':'inline-key'}}\n",
 "cfg.get_hermes_home=lambda:'/different/profile'\n",
 "reads=iter(['sk-ant-api03-synthetic-only','sk-ant-api03-rotated']);auth.get_anthropic_key=lambda:next(reads)\n",
 ])('fails closed for ambiguous, absent, OAuth, inline, profile or rotating credentials',extra=>expect(evaluate(extra)).toBeNull());
 it('discards helper output and exception messages',()=>{
  expect(evaluate("def noisy():\n print('sk-ant-api03-synthetic-only')\n print('sk-ant-api03-synthetic-only',file=sys.stderr)\n return 'sk-ant-api03-synthetic-only'\nauth.get_anthropic_key=noisy\n")).toMatchObject({credentialKind:'api_key'});
  expect(evaluate("auth.get_anthropic_key=lambda:(_ for _ in ()).throw(RuntimeError('sk-ant-api03-synthetic-only'))\n")).toBeNull();
 });
 it('bounds async native subprocess output/time and coalesces overlapping reads',async()=>{
  let finish!:(value:{stdout:string})=>void;
  const probe=vi.fn(()=>new Promise<{stdout:string}>(resolve=>{finish=resolve;}));
  const execute=Object.assign(vi.fn(),{[promisify.custom]:probe}) as unknown as typeof execFile;
  const resolveRoot=vi.fn(async()=>'/opt/synthetic-hermes');
  const reader=createHermesNativeCredentialKindReader({homePath:'/runtime/home',execute,resolveRoot});
  const controller=new AbortController();const a=reader(controller.signal),b=reader(controller.signal);
  await vi.waitFor(()=>expect(probe).toHaveBeenCalledOnce());
  finish({stdout:JSON.stringify({providerId:'anthropic',modelId:'native-model',credentialKind:'api_key'})});
  expect(await a).toEqual(await b);
  expect(probe.mock.calls[0]?.[0]).toBe('/opt/synthetic-hermes/venv/bin/python');
  expect(probe.mock.calls[0]?.[2]).toMatchObject({timeout:1000,maxBuffer:1024,killSignal:'SIGKILL',env:{HERMES_HOME:'/runtime/home/.hermes'}});
 });
 it.each(['{"apiKey":"never-output"}','{"providerId":"anthropic","modelId":"native-model","credentialKind":"api_key","secret":"never-output"}'])('rejects unknown stdout without logging its content',async stdout=>{
  const probe=vi.fn(async()=>({stdout}));const warning=vi.fn();
  const execute=Object.assign(vi.fn(),{[promisify.custom]:probe}) as unknown as typeof execFile;
  const reader=createHermesNativeCredentialKindReader({homePath:'/runtime/home',execute,resolveRoot:async()=>'/opt/synthetic-hermes',logWarning:warning});
  expect(await reader(new AbortController().signal)).toBeNull();
  expect(JSON.stringify(warning.mock.calls)).not.toContain('never-output');
 });
});

it('qualifies an inactive Hermes-owned Claude OAuth pool without accepting ambient API credentials',()=>{
 const oauth = `
auth.get_anthropic_key=lambda:''
row={'id':'owned','auth_type':'oauth','source':'manual:hermes_pkce','access_token':'sk-ant-oat01-owned-only','refresh_token':'refresh-owned','expires_at_ms':4102444800000,'base_url':'https://api.anthropic.com'}
auth.read_credential_pool=lambda provider:[dict(row)]
cfg.load_config_readonly=lambda:{'model':{'provider':'openai-codex','default':'other-model'}}
`;
 expect(evaluate(oauth)).toEqual({providerId:'anthropic',modelId:'other-model',credentialKind:'provider_profile'});
 expect(evaluate(oauth+"auth.get_anthropic_key=lambda:'sk-ant-api03-synthetic-only'\n")).toBeNull();
 expect(evaluate(oauth+"row['source']='claude_code'\n")).toBeNull();
 expect(evaluate(oauth+"row['expires_at_ms']=1\n")).toBeNull();
 expect(evaluate(oauth+"row['base_url']='https://untrusted.invalid'\n")).toBeNull();
});

it('resolves the exact official PM shell shim and committed Python when the legacy venv is absent',async()=>{
 const {createHash}=await import('node:crypto');const home=await mkdtemp(join(await realpath(tmpdir()),'hermes pm launcher '));
 try{
  const root=join(home,'.hermes/hermes-agent');await mkdir(join(root,'hermes_cli'),{recursive:true});await mkdir(join(home,'.local/bin'),{recursive:true});
  const key=createHash('sha256').update(await realpath(root)).digest('hex').slice(0,16);const state=join(home,'.hermes/installs',key);const generation=join(state,'environments/current');
  await mkdir(join(generation,'bin'),{recursive:true});await writeFile(join(generation,'pyvenv.cfg'),'fixture');await writeFile(join(generation,'bin/python'),'python',{mode:0o755});
  await writeFile(join(state,'facts.json'),JSON.stringify({packages:{venv:{environment:generation}}}));
  const quoted=spawnSync('python3',['-c','import sys,shlex;print(shlex.quote(sys.argv[1]))',join(root,'.hermes/bin/hermes')],{encoding:'utf8'}).stdout.trim();
  const launcher=join(home,'.local/bin/hermes');await writeFile(launcher,`#!/bin/sh\nexec ${quoted} "$@"\n`,{mode:0o755});
  expect(await resolveHermesNativeRoot(home)).toBe(root);
  await writeFile(join(state,'facts.json'),'{}');await expect(resolveHermesNativeRoot(home)).rejects.toThrow('Hermes runtime setup required');
 }finally{await rm(home,{recursive:true,force:true});}
});
