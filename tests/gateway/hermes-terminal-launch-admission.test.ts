import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TerminalRuntimeRequestSchema } from '../../packages/terminal-runtime/src/socket-protocol.js';
import { createGenericNativeWriter } from '../../packages/gateway/src/ai-providers/generic-native-writer.js';
import { createHermesTerminalWorkflow } from '../../packages/gateway/src/ai-providers/hermes-terminal-workflow.js';
import { ProviderWorkflowNotStartedError } from '../../packages/gateway/src/ai-providers/provider-workflows.js';
vi.mock('../../packages/gateway/src/agent-config/hermes-native-credential-kind.js',()=>({resolveHermesNativeRoot:async(home:string)=>join(home,'.hermes/hermes-agent')}));
vi.mock('../../packages/gateway/src/chat/hermes-python-environment.js',()=>({resolveHermesPython:async(root:string)=>join(root,'venv/bin/python')}));
vi.mock('node:child_process',async()=>({
 ...await vi.importActual<typeof import('node:child_process')>('node:child_process'),
 execFile:Object.assign(vi.fn(),{[Symbol.for('nodejs.util.promisify.custom')]:vi.fn(async()=>({stdout:'supported\n'}))}),
}));
import { createHermesTerminalLoginRuntime } from '../../packages/gateway/src/ai-providers/hermes-terminal-login.js';
const roots:string[]=[];
afterEach(async()=>{vi.unstubAllEnvs();vi.restoreAllMocks();await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'hermes-terminal-admission-'));roots.push(root);
 const home=join(root,'owner');await mkdir(home,{mode:0o700});
 const workspaceId='tws_'+ '1'.repeat(32),tabId='tt_'+ '2'.repeat(32),incarnation='ti_'+ '3'.repeat(32);
 const writer=createGenericNativeWriter(home),complete=vi.fn();
 const runtime=createHermesTerminalLoginRuntime({homePath:home,enableConnected:complete});
 const terminal={ensureWorkspace:vi.fn(async()=>({id:workspaceId})),
  createTab:vi.fn(async(workspaceId:string,input:Record<string,unknown>)=>{
   // Exercise the actual receiver's bounds, not a local copy of its policy.
   TerminalRuntimeRequestSchema.parse({version:1,requestId:'req_'+ '4'.repeat(32),operation:'CreateTab',input:{workspaceId,...input}});
   return {workspaceId,id:tabId,incarnation};
  }),listWorkspaces:vi.fn(async()=>[]),terminateTab:vi.fn(async()=>{}),getCommandResult:vi.fn(async()=>({state:'running'})),attach:vi.fn(()=>({close:vi.fn(),send:vi.fn()}))};
 const start=createHermesTerminalWorkflow({harnessInstanceId:'hermes',runtime,terminal:terminal as never,writer,
  store:{getSnapshot:async()=>({revision:7,access:{mode:'writable'},harnesses:[{id:'hermes',harness:'hermes',installState:'installed'}]})} as never});
 let cleanup=async()=>{};
 const run=()=>start({request:{harnessInstanceId:'hermes',kind:'login',method:'terminal',idempotencyKey:'admission-test'},
  connectionOption:{id:'openai_terminal',providerId:'openai',method:'terminal',authKind:'subscription',billingKind:'subscription',executionKind:'native',availability:'available'},
  publish:vi.fn(),registerCleanup:fn=>{cleanup=fn;}});
 return {home,writer,runtime,terminal,run,cleanup:()=>cleanup(),complete};
}
it('rejects an accepted 4096-character proxy before Terminal launch and releases the durable writer across restart',async()=>{
 vi.stubEnv('NO_PROXY','x'.repeat(4096));const f=await fixture();
 const launch=await f.runtime.prepare('openai-codex');expect(launch.command).toContain('NO_PROXY='+ 'x'.repeat(4096));
 const error=await f.run().catch(error=>error);
 expect.soft(error).toBeInstanceOf(ProviderWorkflowNotStartedError);
 expect.soft(f.terminal.createTab).not.toHaveBeenCalled();expect.soft(f.terminal.listWorkspaces).not.toHaveBeenCalled();expect.soft(f.complete).not.toHaveBeenCalled();
 await expect(createGenericNativeWriter(f.home).run('hermes',async()=> 'next settings write')).resolves.toBe('next settings write');
});
it('preserves a boundary-sized proxy and keeps its writer until the exact live Terminal is cancelled',async()=>{
 vi.stubEnv('NO_PROXY','x'.repeat(4096-'NO_PROXY='.length));const f=await fixture();const running=await f.run();
 expect(f.terminal.createTab).toHaveBeenCalledOnce();expect(f.terminal.createTab.mock.calls[0]![1].command).toContain('NO_PROXY='+ 'x'.repeat(4087));
 await expect(createGenericNativeWriter(f.home).acquire('hermes')).rejects.toThrow();
 await running.cancel();expect(f.terminal.terminateTab).toHaveBeenCalledOnce();
 const release=await createGenericNativeWriter(f.home).acquire('hermes');await release();
});
it.each(['argument_count','empty_argument','cwd_length'] as const)('rejects malformed prepared %s through the canonical schema without retaining admission',async(kind)=>{
 const f=await fixture(),prepare=f.runtime.prepare.bind(f.runtime);
 vi.spyOn(f.runtime,'prepare').mockImplementation(async provider=>{
  const launch=await prepare(provider);
  return kind==='cwd_length'?{...launch,cwd:'x'.repeat(4097)}:{...launch,command:kind==='empty_argument'?[...launch.command,'']:Array.from({length:129},()=>'/qualified')};
 });
 await expect(f.run()).rejects.toBeInstanceOf(ProviderWorkflowNotStartedError);expect(f.terminal.createTab).not.toHaveBeenCalled();
 const release=await createGenericNativeWriter(f.home).acquire('hermes');await release();
});
