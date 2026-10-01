import { describe, it, expect } from 'vitest';
import { extractProviderDeviceCode } from '../../packages/gateway/src/ai-providers/provider-workflow-native.js';
describe('native device login extraction', () => {
  it('accepts only a known login URL and nearby code, never arbitrary native text', () => {
    expect(extractProviderDeviceCode('Open https://auth.openai.com/codex/device\nEnter code ABCD-EFGH')).toEqual({ authorizationUrl: 'https://auth.openai.com/codex/device', deviceCode: 'ABCD-EFGH' });
    expect(extractProviderDeviceCode('https://evil.example/ ABCD-EFGH sk-secret')).toBeNull();
    expect(extractProviderDeviceCode('https://auth.openai.com.evil.example/ ABCD-EFGH')).toBeNull();
  });
});

import { vi } from 'vitest';
import { createNativeProviderWorkflowAdapters } from '../../packages/gateway/src/ai-providers/provider-workflow-native.js';
import type { ProviderSettingsStoreWriter } from '../../packages/gateway/src/ai-providers/provider-settings-store.js';
import type { TerminalRuntimeSocketClient } from '@matrix-os/terminal-runtime';
const ref = { workspaceId: 'tws_11111111111111111111111111111111', tabId: 'tt_11111111111111111111111111111111' };
function nativeFixture(kind: 'codex' | 'hermes' = 'codex') {
  const row = { id: `harness_${kind}`, harness: kind, displayName: kind, installState: kind === 'codex' ? 'installed' : 'missing', authState: 'unknown', loginMethods: ['terminal'], selectedAccountId: null };
  const snapshot = { revision: 0, access: { mode: 'writable' }, harnesses: [row], harnessCatalog: [] };
  const store = { getSnapshot: vi.fn(async () => snapshot), mutate: vi.fn(async () => ({ kind: 'login_attempt', attempt: { action: { kind: 'open_terminal', terminalSessionId: `${ref.workspaceId}:${ref.tabId}` } } })) } as unknown as ProviderSettingsStoreWriter;
  let observer: Parameters<TerminalRuntimeSocketClient['attach']>[0];
  const close = vi.fn(); const order: string[] = [];
  const terminal = { ensureWorkspace: vi.fn(async () => ({ id: ref.workspaceId })), createTab: vi.fn(async () => ({ id: ref.tabId, workspaceId: ref.workspaceId, incarnation: 'ti_11111111111111111111111111111111' })), listWorkspaces: vi.fn(async () => [{ tabs: [{ id: ref.tabId, workspaceId: ref.workspaceId }] }]), terminateTab: vi.fn(async () => { order.push('terminate'); }), attach: vi.fn(input => { observer = input; return { close, send: vi.fn() }; }) } as unknown as Pick<TerminalRuntimeSocketClient, 'ensureWorkspace' | 'createTab' | 'listWorkspaces' | 'terminateTab' | 'attach'>;
  return { store, terminal, row, observer: () => observer, order };
}
describe('native workflow runtime wiring', () => {
  it('does not treat exit zero as verified authentication without exact credential observation', async () => {
    const f = nativeFixture(); const [adapter] = await createNativeProviderWorkflowAdapters({ store: f.store, terminal: f.terminal, hostControl: { available: false, run: vi.fn() } });
    const publish = vi.fn(); const running = await adapter!.start({ request: { harnessInstanceId: 'harness_codex', kind: 'login', method: 'device_code', idempotencyKey: 'exact' }, publish });
    expect(running.terminalSessionId).toBe(`${ref.workspaceId}:${ref.tabId}`);
    f.observer().onFrame({ type: 'exit', exitCode: 0, terminalRef: ref });
    await vi.waitFor(() => expect(publish).toHaveBeenCalledWith({ state: 'failed', safeFailure: 'unavailable' }));
  });
  it('stops the host cgroup on both sides of exact foreground tab reaping', async () => {
    const f = nativeFixture('hermes'); const [adapter] = await createNativeProviderWorkflowAdapters({ store: f.store, terminal: f.terminal, hostControl: { available: true, run: async () => { f.order.push('host-cancel'); } } });
    expect(adapter!.install).toBe(true);
    const running = await adapter!.start({ request: { harnessInstanceId: 'harness_hermes', kind: 'install', idempotencyKey: 'install' }, publish: vi.fn() });
    await running.cancel(); expect(f.order).toEqual(['host-cancel', 'terminate', 'host-cancel']);
  });
});

it('reaps the newly opened native login when terminal identity lookup fails', async () => {
  const f = nativeFixture();
  vi.mocked(f.terminal.listWorkspaces).mockRejectedValueOnce(new Error('synthetic lookup failure'));
  const [adapter] = await createNativeProviderWorkflowAdapters({ store: f.store, terminal: f.terminal, hostControl: { available: false, run: vi.fn() } });
  await expect(adapter!.start({ request: { harnessInstanceId: 'harness_codex', kind: 'login', method: 'device_code', idempotencyKey: 'lookup-failure' }, publish: vi.fn() })).rejects.toThrow();
  expect(f.terminal.terminateTab).toHaveBeenCalledWith(ref, undefined);
});
it('retains deadline cleanup after a transient stream cleanup failure', async () => {
  vi.useFakeTimers();
  try {
    const f = nativeFixture();
    vi.mocked(f.terminal.terminateTab).mockRejectedValueOnce(new Error('synthetic transport failure'));
    const [adapter] = await createNativeProviderWorkflowAdapters({ store: f.store, terminal: f.terminal, hostControl: { available: false, run: vi.fn() } });
    const publish = vi.fn();
    await adapter!.start({ request: { harnessInstanceId: 'harness_codex', kind: 'login', method: 'device_code', idempotencyKey: 'cleanup-retry' }, publish });
    f.observer().onError(new Error('synthetic stream failure'));
    await vi.advanceTimersByTimeAsync(600_000);
    expect(f.terminal.terminateTab).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledWith({ state: 'expired', safeFailure: 'expired' });
  } finally { vi.useRealTimers(); }
});
it('does not declare expiry until failed deadline cleanup is retried successfully', async () => {
  vi.useFakeTimers();
  try {
    const f = nativeFixture();
    vi.mocked(f.terminal.terminateTab).mockRejectedValueOnce(new Error('synthetic deadline failure'));
    const [adapter] = await createNativeProviderWorkflowAdapters({ store: f.store, terminal: f.terminal, hostControl: { available: false, run: vi.fn() } });
    const publish = vi.fn();
    await adapter!.start({ request: { harnessInstanceId: 'harness_codex', kind: 'login', method: 'device_code', idempotencyKey: 'expiry-retry' }, publish });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(publish).not.toHaveBeenCalledWith({ state: 'expired', safeFailure: 'expired' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.terminal.terminateTab).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledWith({ state: 'expired', safeFailure: 'expired' });
  } finally { vi.useRealTimers(); }
});

it('retains the native profile lease until observed exit or successful reaping, including failed deadline cleanup', async () => {
  vi.useFakeTimers();
  try {
    const f = nativeFixture(); f.row.installState = 'missing';
    const release = vi.fn(); const acquire = vi.fn(async () => release);
    const profileGuard = { acquire, run: vi.fn() };
    const [adapter] = await createNativeProviderWorkflowAdapters({ store: f.store, terminal: f.terminal, profileGuard, hostControl: { available: false, run: vi.fn() } });
    await adapter!.start({ request: { harnessInstanceId: 'harness_codex', kind: 'install', idempotencyKey: 'lease' }, publish: vi.fn() });
    expect(acquire).toHaveBeenCalledWith('codex', { kind: 'write' }); expect(release).not.toHaveBeenCalled();
    vi.mocked(f.terminal.terminateTab).mockRejectedValueOnce(new Error('synthetic reap failure'));
    await vi.advanceTimersByTimeAsync(600000); expect(release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30000); expect(release).toHaveBeenCalledOnce();
    expect(vi.mocked(f.terminal.createTab).mock.calls[0]![1]).toMatchObject({ agent: { providerId: 'codex' }, name: expect.stringMatching(/^provider-workflow-native-codex-install-/) });
  } finally { vi.useRealTimers(); }
});
it('releases a profile on observed native exit and reaps an ambiguous launch before releasing', async () => {
  const f = nativeFixture(); f.row.installState = 'missing';
  const release = vi.fn();
  const [adapter] = await createNativeProviderWorkflowAdapters({ store: f.store, terminal: f.terminal, profileGuard: { acquire: async () => release, run: vi.fn() }, hostControl: { available: false, run: vi.fn() } });
  await adapter!.start({ request: { harnessInstanceId: 'harness_codex', kind: 'install', idempotencyKey: 'exit-lease' }, publish: vi.fn() });
  f.observer().onFrame({ type: 'exit', exitCode: 1, terminalRef: ref }); expect(release).toHaveBeenCalledOnce();
  release.mockClear();
  vi.mocked(f.terminal.createTab).mockImplementationOnce(async (_workspace, input) => {
    vi.mocked(f.terminal.listWorkspaces).mockResolvedValueOnce([{ tabs: [{ ...ref, id: ref.tabId, name: input.name, incarnation: 'ti_11111111111111111111111111111111' }] }] as unknown as Awaited<ReturnType<typeof f.terminal.listWorkspaces>>);
    throw new Error('synthetic lost launch reply');
  });
  await expect(adapter!.start({ request: { harnessInstanceId: 'harness_codex', kind: 'install', idempotencyKey: 'lost-reply' }, publish: vi.fn() })).rejects.toThrow();
  expect(f.terminal.terminateTab).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledOnce();
});
