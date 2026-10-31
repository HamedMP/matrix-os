import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { TerminalRuntimeRequestSchema } from '../../packages/terminal-runtime/src/socket-protocol.js';
import { expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { ZellijCliRuntimeAdapter } from '../../packages/terminal-runtime/src/zellij-adapter.js';
vi.mock('../../packages/gateway/src/agent-config/hermes-native-credential-kind.js',()=>({resolveHermesNativeRoot:vi.fn(async()=>'/owner/.hermes/hermes-agent')}));
vi.mock('../../packages/gateway/src/chat/hermes-python-environment.js',()=>({resolveHermesPython:async()=>'/owner/.hermes/installs/generation/bin/python'}));
vi.mock('node:child_process',async()=>{
 const actual=await vi.importActual<typeof import('node:child_process')>('node:child_process');
 return {...actual,execFile:Object.assign(vi.fn(),{[Symbol.for('nodejs.util.promisify.custom')]:vi.fn(async()=>({stdout:'supported\n'}))})};
});
import { resolveHermesNativeRoot } from '../../packages/gateway/src/agent-config/hermes-native-credential-kind.js';
import { createHermesTerminalLoginRuntime } from '../../packages/gateway/src/ai-providers/hermes-terminal-login.js';
it('opens the prepared Hermes login through the real Terminal cwd contract without permitting absolute paths',async()=>{
 const runtime=createHermesTerminalLoginRuntime({homePath:'/owner',enableConnected:vi.fn()});
 const launch=await runtime.prepare('openai-codex');
 expect(TerminalRuntimeRequestSchema.safeParse({version:1,requestId:'req_0123456789abcdef0123456789abcdef',operation:'CreateTab',input:{workspaceId:'tws_0123456789abcdef0123456789abcdef',name:'Hermes login',...launch}}).success).toBe(true);
 const run=vi.fn(async(args:string[])=>{
  if(args.includes('list-tabs'))return '[]';
  if(args.includes('new-tab'))return '7';
  if(args.includes('list-panes'))return JSON.stringify([{id:12,is_plugin:false,tab_id:7}]);
  return '';
 });
 const terminal=new ZellijCliRuntimeAdapter({homePath:'/owner',run,resolveRealpath:async path=>resolve(path)});
 const target={internalName:'matrix-tab-0123456789abcdef0123456789abcdef',...launch};
 await expect(terminal.createTab('matrix-w-0123456789abcdef0123456789abcdef',target)).resolves.toEqual({tabId:7,paneId:'terminal_12'});
 expect(launch.cwd).toBe('.hermes/hermes-agent');
 expect(run.mock.calls.find(([args])=>args.includes('new-tab'))?.[0]).toContain('/owner/.hermes/hermes-agent');
 await expect(terminal.createTab('matrix-w-0123456789abcdef0123456789abcdef',{...target,cwd:'/outside'})).rejects.toThrow();
});

it('launches a trusted external checkout from owner home without sending a rejected traversal cwd',async()=>{
 const root=vi.mocked(resolveHermesNativeRoot);
 root.mockResolvedValueOnce('/opt/trusted-hermes').mockResolvedValueOnce('/opt/trusted-hermes');
 const runtime=createHermesTerminalLoginRuntime({homePath:'/owner',enableConnected:vi.fn()});
 expect(await runtime.available()).toBe(true);
 const launch=await runtime.prepare('anthropic');
 const run=vi.fn(async(args:string[])=>{
  if(args.includes('list-tabs'))return '[]';
  if(args.includes('new-tab'))return '7';
  if(args.includes('list-panes'))return JSON.stringify([{id:12,is_plugin:false,tab_id:7}]);
  return '';
 });
 const terminal=new ZellijCliRuntimeAdapter({homePath:'/owner',run,resolveRealpath:async path=>resolve(path)});
 await expect(terminal.createTab('matrix-w-0123456789abcdef0123456789abcdef',{internalName:'matrix-tab-0123456789abcdef0123456789abcdef',...launch})).resolves.toEqual({tabId:7,paneId:'terminal_12'});
 expect(launch.cwd).toBe('');
 expect(launch.command).toContain('PYTHONPATH=/opt/trusted-hermes');
 expect(launch.command).toContain('/owner/.hermes/installs/generation/bin/python');
 expect(run.mock.calls.find(([args])=>args.includes('new-tab'))?.[0]).toContain('/owner');
 await expect(terminal.createTab('matrix-w-0123456789abcdef0123456789abcdef',{internalName:'matrix-tab-0123456789abcdef0123456789abcdef',...launch,cwd:'../opt/trusted-hermes'})).rejects.toThrow();
});

it('imports only the qualified external source when owner home has a same-name Python package',async()=>{
 const base=await mkdtemp(join(tmpdir(),'hermes-login-import-'));
 try{
  const home=join(base,'owner'),source=join(base,'installed');
  for(const [directory,label] of [[home,'cwd-shadow'],[source,'qualified']]){
   await mkdir(join(directory,'hermes_cli'),{recursive:true});
   await writeFile(join(directory,'hermes_cli/__init__.py'),`ORIGIN=${JSON.stringify(label)}\n`);
  }
  vi.mocked(resolveHermesNativeRoot).mockResolvedValueOnce(source);
  const runtime=createHermesTerminalLoginRuntime({homePath:home,enableConnected:vi.fn()});
  const launch=await runtime.prepare('anthropic');
  const safe=launch.command.find(value=>value.startsWith('PYTHONSAFEPATH='))?.slice('PYTHONSAFEPATH='.length);
  const result=spawnSync('python3',['-I','-c','import sys; assert sys.version_info >= (3,11)'],{encoding:'utf8',timeout:2000});
  expect(result.status,result.stderr).toBe(0);
  const imported=spawnSync('python3',['-c','import hermes_cli; print(hermes_cli.ORIGIN)'],{cwd:home,env:{PATH:process.env.PATH,PYTHONPATH:source,PYTHONSAFEPATH:safe},encoding:'utf8',timeout:2000});
  expect(imported.status,imported.stderr).toBe(0);expect(imported.stdout).toBe('qualified\n');
 }finally{await rm(base,{recursive:true,force:true});}
});
