import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalRuntimeSocketClient } from '@matrix-os/terminal-runtime';
import type { ProviderSettingsStoreWriter } from '../../packages/gateway/src/ai-providers/provider-settings-store.js';
import { createNativeProviderWorkflowAdapters } from '../../packages/gateway/src/ai-providers/provider-workflow-native.js';

const ref = { workspaceId: 'tws_11111111111111111111111111111111', tabId: 'tt_11111111111111111111111111111111' };
const incarnation = 'ti_11111111111111111111111111111111';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(readOnly = false) {
  const row = { id: 'harness_codex', harness: 'codex', displayName: 'Codex', installState: 'missing', loginMethods: [], selectedAccountId: null };
  const snapshot = { revision: 0, access: { mode: readOnly ? 'read_only' : 'writable' }, harnesses: [row], harnessCatalog: [] };
  const getSnapshot = vi.fn(async () => snapshot);
  const mutate = vi.fn();
  const completeCodexNativeLogin = vi.fn();
  const store = { getSnapshot, mutate, completeCodexNativeLogin } as unknown as ProviderSettingsStoreWriter;
  const releaseGate = deferred();
  const release = vi.fn(() => releaseGate.promise);
  const acquire = vi.fn(async () => release);
  let observer!: Parameters<TerminalRuntimeSocketClient['attach']>[0];
  const close = vi.fn();
  const terminateTab = vi.fn(async () => {});
  const terminal = {
    ensureWorkspace: vi.fn(async () => ({ id: ref.workspaceId })),
    createTab: vi.fn(async () => ({ workspaceId: ref.workspaceId, id: ref.tabId, incarnation })),
    listWorkspaces: vi.fn(async () => []),
    terminateTab,
    attach: vi.fn((input: Parameters<TerminalRuntimeSocketClient['attach']>[0]) => {
      observer = input;
      return { close, send: vi.fn() };
    }),
  } as unknown as Parameters<typeof createNativeProviderWorkflowAdapters>[0]['terminal'];
  const adapters = await createNativeProviderWorkflowAdapters({
    store, terminal, runtimePrefix: '/synthetic-native-runtime',
    profileGuard: { acquire, run: vi.fn() }, hostControl: { available: false, run: vi.fn() },
  });
  const publish = vi.fn();
  let cleanup!: () => Promise<void>;
  const start = () => adapters[0]!.start({
    request: { harnessInstanceId: row.id, kind: 'install', idempotencyKey: 'synthetic-completion-cleanup' },
    publish, registerCleanup: cancel => { cleanup = cancel; },
  });
  const exit = (exitCode: number) => observer.onFrame({ type: 'exit', revision: 1, exitCode, terminalRef: ref });
  return { adapters, start, exit, close, publish, release, releaseGate, acquire, terminal,
    terminateTab, getSnapshot, mutate, completeCodexNativeLogin, row,
    cleanup: () => cleanup(), lateClose: () => observer.onClose?.(),
    lateOutput: () => observer.onFrame({ type: 'output', revision: 2, data: 'late synthetic output', terminalRef: ref }) };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('native completion cleanup during cancellation', () => {
  it.each([
    [0, 'returned'], [9, 'returned'], [0, 'registered'], [9, 'registered'],
  ] as const)('drains exit %i after pending lease release through %s cancellation', async (exitCode, entry) => {
    const f = await fixture();
    const running = await f.start();
    expect(f.acquire).toHaveBeenCalledWith('codex', { kind: 'write', durable: true });
    expect(vi.getTimerCount()).toBe(1);
    f.exit(exitCode);
    expect(f.release).toHaveBeenCalledOnce();
    let cancelled = false;
    const cancellation = (entry === 'returned' ? running.cancel() : f.cleanup()).then(() => { cancelled = true; });
    await Promise.resolve();
    expect(cancelled).toBe(false);
    expect(f.close).not.toHaveBeenCalled();
    expect(f.terminateTab).not.toHaveBeenCalled();

    f.releaseGate.resolve();
    await cancellation;
    expect.soft(f.close).toHaveBeenCalledOnce();
    expect.soft(vi.getTimerCount()).toBe(0);
    f.lateOutput(); f.exit(0); f.lateClose();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.getSnapshot).toHaveBeenCalledOnce();
    expect(f.mutate).not.toHaveBeenCalled();
    expect(f.completeCodexNativeLogin).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.terminateTab).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, 9])('preserves an already settled exit %i without double close or termination', async exitCode => {
    const f = await fixture();
    const running = await f.start();
    Object.assign(f.row, { installState: 'installed' });
    f.releaseGate.resolve(); f.exit(exitCode);
    await vi.advanceTimersByTimeAsync(0);
    const outcome = exitCode === 0 ? { state: 'succeeded', safeFailure: null } : { state: 'failed', safeFailure: 'rejected' };
    expect(f.publish).toHaveBeenCalledExactlyOnceWith(outcome);
    await running.cancel(); await f.cleanup();
    f.lateClose(); f.exit(0);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(f.publish).toHaveBeenCalledExactlyOnceWith(outcome);
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.terminateTab).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not admit native resources for read-only access', async () => {
    const f = await fixture(true);
    expect(f.adapters).toEqual([]);
    expect(f.acquire).not.toHaveBeenCalled();
    expect(f.terminal.createTab).not.toHaveBeenCalled();
    expect(f.terminal.attach).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
