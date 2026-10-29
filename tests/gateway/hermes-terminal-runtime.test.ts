import { TerminalRuntimeRequestSchema } from '../../packages/terminal-runtime/src/socket-protocol.js';
import { expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { ZellijCliRuntimeAdapter } from '../../packages/terminal-runtime/src/zellij-adapter.js';
vi.mock('../../packages/gateway/src/agent-config/hermes-native-credential-kind.js',()=>({resolveHermesNativeRoot:async()=>'/owner/.hermes/hermes-agent'}));
vi.mock('../../packages/gateway/src/chat/hermes-python-environment.js',()=>({resolveHermesPython:async()=>'/owner/.hermes/installs/generation/bin/python'}));
vi.mock('node:child_process',async()=>{
 const actual=await vi.importActual<typeof import('node:child_process')>('node:child_process');
 return {...actual,execFile:Object.assign(vi.fn(),{[Symbol.for('nodejs.util.promisify.custom')]:vi.fn(async()=>({stdout:'supported\n'}))})};
});
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
