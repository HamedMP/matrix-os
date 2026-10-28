import { afterEach, expect, it, vi } from 'vitest';
import { createHermesTerminalWorkflow } from '../../packages/gateway/src/ai-providers/hermes-terminal-workflow.js';
const option = (providerId: 'openai'|'anthropic') => ({id:`${providerId}_terminal`,providerId,method:'terminal' as const,authKind:'subscription' as const,billingKind:'subscription' as const,executionKind:'native' as const,availability:'available' as const});
afterEach(()=>vi.useRealTimers());
function fixture() {
 const ref={workspaceId:'tws_1',tabId:'tt_1'}; const incarnation='ti_11111111111111111111111111111111';
 let frame: (value: unknown)=>void = ()=>{};
 const release=vi.fn(async()=>{}); const complete=vi.fn(async()=>{});
 const terminal={ensureWorkspace:vi.fn(async()=>({id:ref.workspaceId})),createTab:vi.fn(async()=>({...ref,id:ref.tabId,incarnation})),listWorkspaces:vi.fn(async()=>[{tabs:[{...ref,id:ref.tabId,incarnation}]}]),terminateTab:vi.fn(async()=>{}),getCommandResult:vi.fn(async()=>({state:'running'})),attach:vi.fn(input=>{frame=input.onFrame;return {close:vi.fn(),send:vi.fn()};})};
 const runtime={prepare:vi.fn(async(provider: string)=>({command:['/qualified/python','-m','hermes_cli.main','auth','add',provider,'--type','oauth','--no-browser'],cwd:'/owner/.hermes/hermes-agent'})),complete};
 const snapshot={revision:7,access:{mode:'writable'},harnesses:[{id:'hermes',harness:'hermes',installState:'installed'}]};
 const store={getSnapshot:vi.fn(async()=>snapshot)};
 const start=createHermesTerminalWorkflow({terminal:terminal as never,store:store as never,runtime,writer:{acquire:vi.fn(async()=>release)} as never,harnessInstanceId:'hermes'});
 const publish=vi.fn();let cleanup:()=>Promise<void>=async()=>{};
 return {start,terminal,runtime,store,release,publish,frame:(exitCode:number)=>frame({type:'exit',revision:1,exitCode,terminalRef:ref}),run:(providerId:'openai'|'anthropic')=>start({request:{harnessInstanceId:'hermes',kind:'login',method:'terminal',idempotencyKey:'user-login'},connectionOption:option(providerId),publish,registerCleanup:fn=>{cleanup=fn;}}),cleanup:()=>cleanup()};
}
it.each([['openai','openai-codex'],['anthropic','anthropic']] as const)('binds %s login to its native provider and waits for the inner command result',async(provider,native)=>{
 vi.useFakeTimers();const f=fixture();const running=await f.run(provider);
 expect(running.terminalSessionId).toBe('tws_1:tt_1');expect(f.runtime.prepare).toHaveBeenCalledWith(native);
 f.frame(0);await vi.advanceTimersByTimeAsync(1);expect(f.runtime.complete).not.toHaveBeenCalled();expect(f.release).not.toHaveBeenCalled();
 f.terminal.getCommandResult.mockResolvedValue({state:'exited',exitCode:0} as never);await vi.advanceTimersByTimeAsync(1000);
 expect(f.runtime.complete).toHaveBeenCalledWith('hermes',native,7,'user-login',expect.any(AbortSignal));expect(f.publish).toHaveBeenCalledWith({state:'succeeded',safeFailure:null});expect(f.release).toHaveBeenCalledOnce();
});
it('rejects unbound/foreign provider options before acquiring or launching resources',async()=>{
 const f=fixture();await expect(f.start({request:{harnessInstanceId:'hermes',kind:'login',method:'terminal',idempotencyKey:'foreign'},connectionOption:{...option('openai'),providerId:'openrouter'},publish:f.publish,registerCleanup:()=>{}})).rejects.toThrow('unavailable');
 expect(f.terminal.createTab).not.toHaveBeenCalled();expect(f.runtime.prepare).not.toHaveBeenCalled();
});
it('reaps the exact incarnation before releasing cancellation admission',async()=>{
 const f=fixture();await f.run('openai');await f.cleanup();
 expect(f.terminal.terminateTab).toHaveBeenCalledWith({workspaceId:'tws_1',tabId:'tt_1'},'ti_11111111111111111111111111111111');expect(f.release).toHaveBeenCalledOnce();expect(f.runtime.complete).not.toHaveBeenCalled();
});
it('does not enable the route after failed login or failed native credential verification',async()=>{
 vi.useFakeTimers();const f=fixture();await f.run('anthropic');f.runtime.complete.mockRejectedValue(new Error('unavailable'));
 f.terminal.getCommandResult.mockResolvedValue({state:'exited',exitCode:0} as never);await vi.advanceTimersByTimeAsync(1);
 expect(f.publish).toHaveBeenCalledWith({state:'failed',safeFailure:'unavailable'});expect(f.publish).not.toHaveBeenCalledWith({state:'succeeded',safeFailure:null});
});
it('keeps the fence when Terminal cannot prove cancellation and retries only the same cleanup',async()=>{
 const f=fixture();await f.run('openai');f.terminal.terminateTab.mockRejectedValueOnce(new Error('transport unavailable'));
 await expect(f.cleanup()).rejects.toThrow();expect(f.release).not.toHaveBeenCalled();await f.cleanup();expect(f.release).toHaveBeenCalledOnce();expect(f.terminal.createTab).toHaveBeenCalledOnce();
});

it('expires only after the exact command is reaped and retains its fence across a failed expiry cleanup',async()=>{
 vi.useFakeTimers();const f=fixture();await f.run('openai');f.terminal.terminateTab.mockRejectedValueOnce(new Error('temporary transport failure'));
 await vi.advanceTimersByTimeAsync(600000);expect(f.release).not.toHaveBeenCalled();expect(f.publish).not.toHaveBeenCalledWith({state:'expired',safeFailure:'expired'});
 await vi.advanceTimersByTimeAsync(30000);expect(f.release).toHaveBeenCalledOnce();expect(f.publish).toHaveBeenCalledWith({state:'expired',safeFailure:'expired'});
});
it('reconciles a lost launch reply by the unique tab name before releasing the writer',async()=>{
 const f=fixture();f.terminal.createTab.mockImplementationOnce(async(_workspace,tab)=>{
  f.terminal.listWorkspaces.mockResolvedValue([{tabs:[{workspaceId:'tws_1',id:'tt_1',incarnation:'ti_11111111111111111111111111111111',name:tab.name}]}] as never);
  throw new Error('reply lost');
 });
 await expect(f.run('anthropic')).rejects.toThrow('reply lost');expect(f.terminal.terminateTab).toHaveBeenCalledOnce();expect(f.release).toHaveBeenCalledOnce();
});
it('retains admission on an ambiguous launch whose tab cannot be found',async()=>{
 const f=fixture();f.terminal.createTab.mockRejectedValueOnce(new Error('reply lost'));f.terminal.listWorkspaces.mockResolvedValue([]);
 await expect(f.run('openai')).rejects.toThrow('reply lost');expect(f.release).not.toHaveBeenCalled();await expect(f.cleanup()).rejects.toThrow('unavailable');
});
it('does not finish a cancelled login from a late success receipt',async()=>{
 vi.useFakeTimers();const f=fixture();await f.run('anthropic');await f.cleanup();f.terminal.getCommandResult.mockResolvedValue({state:'exited',exitCode:0} as never);await vi.advanceTimersByTimeAsync(2000);
 expect(f.runtime.complete).not.toHaveBeenCalled();expect(f.publish).not.toHaveBeenCalledWith({state:'succeeded',safeFailure:null});
});
it('does not overwrite an owner setting changed while OAuth was open',async()=>{
 const {enableNativeSettingsConnectedRoute}=await import('../../packages/gateway/src/ai-providers/opencode-settings-auth.js');
 const mutate=vi.fn();const store={getSnapshot:async()=>({revision:8}),mutate};
 await expect(enableNativeSettingsConnectedRoute(store as never,'hermes','hermes','openai-codex','login',7)).rejects.toThrow('unavailable');expect(mutate).not.toHaveBeenCalled();
});
it('advertises and launches the provider-bound Hermes workflow through production adapter composition',async()=>{
 const {createNativeProviderWorkflowAdapters}=await import('../../packages/gateway/src/ai-providers/provider-workflow-native.js');
 const f=fixture();const snapshot=await f.store.getSnapshot();Object.assign(snapshot.harnesses[0]!,{displayName:'Hermes',loginMethods:[],selectedAccountId:null});
 const [adapter]=await createNativeProviderWorkflowAdapters({store:f.store as never,terminal:f.terminal as never,genericWriter:{acquire:async()=>f.release} as never,hermesTerminalLogin:{...f.runtime,available:async()=>true},hostControl:{available:false,run:vi.fn()}});
 expect(adapter?.connectionOptions?.map(option=>option.id)).toEqual(['openai_terminal','anthropic_terminal']);
 const running=await adapter!.start({request:{harnessInstanceId:'hermes',kind:'login',method:'terminal',idempotencyKey:'composed'},connectionOption:option('anthropic'),publish:f.publish,registerCleanup:()=>{}});
 expect(running.terminalSessionId).toBe('tws_1:tt_1');expect(f.runtime.prepare).toHaveBeenCalledWith('anthropic');await running.cancel();
});
it('cancels during native preparation without subsequently opening an OAuth Terminal',async()=>{
 const f=fixture();let ready!:()=>void;const wait=new Promise<void>(resolve=>{ready=resolve;});
 f.runtime.prepare.mockImplementationOnce(async()=>{await wait;return {command:['qualified'],cwd:'/owner'};});
 const started=f.run('openai');await vi.waitFor(()=>expect(f.runtime.prepare).toHaveBeenCalledOnce());await f.cleanup();ready();
 await expect(started).rejects.toThrow();expect(f.terminal.createTab).not.toHaveBeenCalled();expect(f.release).toHaveBeenCalledOnce();
});
