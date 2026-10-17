import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TerminalRuntimeSocketClient } from '@matrix-os/terminal-runtime';
import type { ProviderSettingsStoreWriter } from '../../packages/gateway/src/ai-providers/provider-settings-store.js';
import { createNativeProviderWorkflowAdapters } from '../../packages/gateway/src/ai-providers/provider-workflow-native.js';
import { createCodexSettingsLogin } from '../../packages/gateway/src/ai-providers/provider-workflow-codex-login.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
type Mode = 'success' | 'canonical-failure' | 'proof-refused' | 'missing-proof' | 'unsupported' | 'held-proof';
async function fixture(method: 'terminal' | 'device_code', mode: Mode = 'success') {
  const home = await mkdtemp(join(tmpdir(), 'codex-login-notification-'));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const script = join(home, 'synthetic-server.cjs');
  await writeFile(script, `const send=x=>console.log(JSON.stringify(x));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);
if(r.method==='initialize')send({id:r.id,result:{}});
if(r.method==='account/read')send({id:r.id,result:{account:null,requiresOpenaiAuth:true}});
if(r.method==='account/login/start'){
send({id:r.id,result:{type:'chatgptDeviceCode',loginId:'11111111-1111-4111-8111-111111111111',verificationUrl:'https://auth.openai.com/codex/device',userCode:'ABCD-EFGHI'}});
send({method:'account/login/completed',params:{loginId:'11111111-1111-4111-8111-111111111111',success:true}});}
if(r.method==='account/login/cancel')send({id:r.id,result:{status:'canceled'}});
});`);
  const order: string[] = [];
  const commit = deferred(), proofReady = deferred(), proofGate = deferred();
  cleanups.push(async () => { commit.resolve(); proofGate.resolve(); });
  const row = { id: 'harness_codex', harness: 'codex', displayName: 'Codex', installState: 'installed', loginMethods: ['terminal'], selectedAccountId: null };
  const snapshot = { revision: 0, access: { mode: 'writable' }, harnesses: [row], harnessCatalog: [] };
  const getSnapshot = vi.fn(async () => snapshot);
  const proof = vi.fn(async () => mode !== 'proof-refused');
  const complete = vi.fn(async (input: { verifyNativeAccount?: typeof proof }) => {
    await commit.promise;
    if (mode === 'canonical-failure' || input.verifyNativeAccount && !await input.verifyNativeAccount()) throw new Error('synthetic canonical refusal');
    order.push('canonical');
  });
  const ref = { workspaceId: 'tws_11111111111111111111111111111111', tabId: 'tt_11111111111111111111111111111111' };
  const incarnation = 'ti_11111111111111111111111111111111';
  const store = { getSnapshot, completeCodexNativeLogin: complete,
    mutate: vi.fn(async () => ({ kind: 'login_attempt', snapshot, attempt: { action: { kind: 'open_terminal', terminalSessionId: `${ref.workspaceId}:${ref.tabId}` } } })) } as unknown as ProviderSettingsStoreWriter;
  let exited = false;
  let observer!: Parameters<TerminalRuntimeSocketClient['attach']>[0];
  const terminal = {
    ensureWorkspace: vi.fn(), createTab: vi.fn(), terminateTab: vi.fn(async () => {}),
    listWorkspaces: async () => [{ tabs: [{ workspaceId: ref.workspaceId, id: ref.tabId, incarnation }] }],
    getCommandResult: async () => exited ? { state: 'exited', exitCode: 0 } : { state: 'running' },
    attach: (input: typeof observer) => { observer = input; return { close: vi.fn(), send: vi.fn() }; },
  } as unknown as Parameters<typeof createNativeProviderWorkflowAdapters>[0]['terminal'];
  const startSettings = createCodexSettingsLogin({ command: process.execPath, args: [script], cwd: home, env: { HOME: home },
    acquire: async () => vi.fn(), ...(mode === 'missing-proof' ? {} : { captureAccountProof: async () => {
      if (mode === 'held-proof') { proofReady.resolve(); await proofGate.promise; }
      return proof;
    } }) });
  const notify = vi.fn((harness: 'claude' | 'codex') => { order.push(`notify:${harness}`); });
  // The optional producer seam is deliberately supplied before it exists for RED.
  const options = { store, terminal, runtimePrefix: '/synthetic-runtime', onLoginSucceeded: notify,
    hostControl: { available: false, run: vi.fn() },
    codexSettingsConnection: { available: async () => mode !== 'unsupported', start: startSettings } };
  const [adapter] = await createNativeProviderWorkflowAdapters(options);
  const publish = vi.fn((value: { state?: string }) => { if (value.state === 'succeeded') order.push('publish'); });
  const start = async () => {
    const running = await adapter!.start({ request: { harnessInstanceId: row.id, kind: 'login', method, idempotencyKey: 'synthetic-notification' }, publish,
      registerCleanup: cancel => { cleanups.push(async () => { commit.resolve(); proofGate.resolve(); await cancel(); }); } });
    if (method === 'terminal') {
      exited = true;
      observer.onFrame({ type: 'exit', revision: 1, exitCode: 0, terminalRef: ref });
    }
    return running;
  };
  return { start, order, notify, publish, complete, commit, proof, proofReady, proofGate, getSnapshot, snapshot };
}

describe('canonical Codex login success notification', () => {
  it.each(['terminal', 'device_code'] as const)('notifies once after %s canonical success and before public success', async method => {
    const f = await fixture(method); await f.start();
    await vi.waitFor(() => expect(f.complete).toHaveBeenCalledOnce(), { timeout: 2000 });
    expect(f.notify).not.toHaveBeenCalled(); expect(f.order).toEqual([]);
    f.commit.resolve();
    await vi.waitFor(() => expect(f.publish).toHaveBeenCalledWith({ state: 'succeeded', safeFailure: null }));
    expect(f.notify).toHaveBeenCalledExactlyOnceWith('codex');
    expect(f.order).toEqual(['canonical', 'notify:codex', 'publish']);
  });

  it.each(['terminal', 'device_code'] as const)('does not notify for rejected %s canonical completion', async method => {
    const f = await fixture(method, 'canonical-failure'); await f.start(); f.commit.resolve();
    await vi.waitFor(() => expect(f.publish).toHaveBeenCalledWith({ state: 'failed', safeFailure: 'unavailable' }));
    expect(f.complete).toHaveBeenCalledOnce(); expect(f.notify).not.toHaveBeenCalled();
  });

  it.each(['proof-refused', 'missing-proof'] as const)('does not notify when Settings private proof is %s', async mode => {
    const f = await fixture('device_code', mode); await f.start(); f.commit.resolve();
    await vi.waitFor(() => expect(f.publish).toHaveBeenCalledWith({ state: 'failed', safeFailure: 'unavailable' }));
    expect(f.notify).not.toHaveBeenCalled();
    if (mode === 'missing-proof') expect(f.complete).not.toHaveBeenCalled();
    else expect(f.proof).toHaveBeenCalledOnce();
  });

  it('does not notify for unsupported Settings authentication', async () => {
    const f = await fixture('device_code', 'unsupported');
    await expect(f.start()).rejects.toThrow('unavailable');
    expect(f.complete).not.toHaveBeenCalled(); expect(f.notify).not.toHaveBeenCalled();
  });

  it('does not notify when cancellation wins while Settings proof is pending', async () => {
    const f = await fixture('device_code', 'held-proof'); const running = await f.start();
    await f.proofReady.promise;
    const cancellation = running.cancel(); f.proofGate.resolve(); await cancellation;
    expect(f.complete).not.toHaveBeenCalled(); expect(f.notify).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'succeeded' }));
  });
});
