import { randomUUID } from 'node:crypto';
import type { TerminalRef } from '@matrix-os/contracts';
import { TerminalRuntimeRequestSchema, type TerminalRuntimeSocketClient } from '@matrix-os/terminal-runtime';
import type { createGenericNativeWriter } from './generic-native-writer.js';
import type { ProviderSettingsStoreWriter } from './provider-settings-store.js';
import { observeNativeCommandCompletion } from './native-command-completion.js';
import { ProviderWorkflowError, ProviderWorkflowNotStartedError, type ProviderWorkflowAdapter } from './provider-workflows.js';
export type HermesLoginProvider = 'openai-codex' | 'anthropic';
export type HermesTerminalLoginRuntime = {
  prepare(provider: HermesLoginProvider): Promise<{ command: string[]; cwd: string }>;
  complete(id: string, provider: HermesLoginProvider, revision: number, key: string, signal: AbortSignal): Promise<void>;
};
/** Only the inner command receipt can settle OAuth; viewer/attachment exits cannot. */
export function createHermesTerminalWorkflow(input: {
  harnessInstanceId: string; runtime: HermesTerminalLoginRuntime;
  terminal: Pick<TerminalRuntimeSocketClient, 'ensureWorkspace'|'createTab'|'terminateTab'|'listWorkspaces'> & Partial<Pick<TerminalRuntimeSocketClient, 'getCommandResult'>>;
  writer: ReturnType<typeof createGenericNativeWriter>; store: ProviderSettingsStoreWriter;
}): ProviderWorkflowAdapter['start'] {
 return async ({request, connectionOption: option, publish, registerCleanup}) => {
  if (request.harnessInstanceId !== input.harnessInstanceId || request.kind !== 'login' || request.method !== 'terminal'
    || !option || !['openai', 'anthropic'].includes(option.providerId) || option.id !== `${option.providerId}_terminal`
    || option.method !== 'terminal' || option.authKind !== 'subscription' || option.billingKind !== 'subscription'
    || option.executionKind !== 'native' || option.availability !== 'available' || typeof input.terminal.getCommandResult !== 'function') throw new ProviderWorkflowNotStartedError();
  const provider: HermesLoginProvider = option.providerId === 'openai' ? 'openai-codex' : 'anthropic';
  const snapshot = await input.store.getSnapshot({refresh:true});
  if (snapshot.access.mode !== 'writable' || !snapshot.harnesses.some(row=>row.id === input.harnessInstanceId && row.harness === 'hermes' && row.installState === 'installed')) throw new ProviderWorkflowNotStartedError();
  let releaseProfile: (()=>Promise<void>) | undefined; let releasing: Promise<void> | undefined;
  const release=()=>{
   if(!releaseProfile) return Promise.resolve();
   releasing ??= releaseProfile().then(()=>{releaseProfile=undefined;}).finally(()=>{releasing=undefined;});
   return releasing;
  };
  const abort = new AbortController();
  const name = `provider-workflow-native-hermes-login-${randomUUID()}`;
  let ref: TerminalRef | undefined; let incarnation: string | undefined;
  let launched = false; let stopped = false; let cancelling = false;
  let finishTask: Promise<void> | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
  let observer: ReturnType<typeof observeNativeCommandCompletion> | undefined;
  const stop = () => { stopped=true; clearTimeout(timer); observer?.stop(); };
  const cleanup = async () => {
   cancelling=true; abort.abort(); observer?.stop();
   try {
    if (finishTask) { try { await finishTask; } finally { await release(); } return; }
    if (stopped) { await release(); return; }
    if (!ref && launched) {
     const tab=(await input.terminal.listWorkspaces()).flatMap(workspace=>workspace.tabs).find(tab=>tab.name === name);
     // A lost launch reply plus an absent tab does not prove the command never started.
     if (!tab) throw new ProviderWorkflowError('unavailable');
     ref={workspaceId:tab.workspaceId,tabId:tab.id};incarnation=tab.incarnation;
    }
    if (ref) await input.terminal.terminateTab(ref,incarnation);
    stop();await release();
   } finally { cancelling=false; }
  };
  registerCleanup(cleanup);
  const finish = async (code: number) => {
   if (stopped || cancelling) return;
   // Exact command is drained. Keep admission through native proof + atomic route selection.
   observer?.stop();clearTimeout(timer);
   try {
    if (code !== 0) {publish({state:'failed',safeFailure:'rejected'});return;}
    await input.runtime.complete(input.harnessInstanceId,provider,snapshot.revision,request.idempotencyKey,abort.signal);
    publish({state:'succeeded',safeFailure:null});
   } catch(error) {
    console.warn('[provider-workflow] Hermes login completion unavailable:',error instanceof Error ? error.name : 'UnknownError');
    publish({state:'failed',safeFailure:'unavailable'});
   } finally {stop();await release();}
  };
  try {
   releaseProfile=await input.writer.acquire('hermes');
   if(stopped || cancelling) throw new ProviderWorkflowNotStartedError();
   const launch=await input.runtime.prepare(provider);
   if(stopped || cancelling) throw new ProviderWorkflowNotStartedError();
   const workspace=await input.terminal.ensureWorkspace();
   if (stopped || cancelling) throw new ProviderWorkflowError('unavailable');
   const tabInput={name,cwd:launch.cwd,command:launch.command};
   // A local schema rejection proves no command was sent. Keep uncertain transport
   // failures fenced, but release admission when the complete payload cannot launch.
   if(!TerminalRuntimeRequestSchema.safeParse({version:1,requestId:`req_${randomUUID().replaceAll('-','')}`,
    operation:'CreateTab',input:{workspaceId:workspace.id,...tabInput}}).success) throw new ProviderWorkflowNotStartedError();
   launched=true;
   const tab=await input.terminal.createTab(workspace.id,tabInput);
   ref={workspaceId:tab.workspaceId,tabId:tab.id};incarnation=tab.incarnation;
   if (stopped || cancelling) throw new ProviderWorkflowError('unavailable');
   // OAuth may wait ten minutes; a passive output viewer expires much sooner.
   // Observe the exact inner receipt without acquiring an output attachment, so
   // viewer reclamation cannot cancel a still-running login or consume its code.
   observer=observeNativeCommandCompletion({read:()=>input.terminal.getCommandResult!(ref!,incarnation!),active:()=>!stopped && !cancelling,
    async onExited(code){finishTask ??= finish(code);await finishTask;}});
   const expire=()=>{
    if(stopped || finishTask) return;
    if(cancelling){timer=setTimeout(expire,30000);timer.unref();return;}
    void cleanup().then(()=>publish({state:'expired',safeFailure:'expired'})).catch(error=>{
     console.warn('[provider-workflow] Hermes login expiry cleanup unavailable:',error instanceof Error ? error.name : 'UnknownError');
     timer=setTimeout(expire,30000);timer.unref();
    });
   };
   timer=setTimeout(expire,600000);timer.unref();
   return {terminalSessionId:`${ref.workspaceId}:${ref.tabId}`,cancel:cleanup};
  } catch(error) {
   try{await cleanup();}catch(cleanupError){console.warn('[provider-workflow] Hermes ambiguous launch retained:',cleanupError instanceof Error ? cleanupError.name : 'UnknownError');}
   throw error;
  }
 };
}
