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
function nativeFixture(kind: 'codex' | 'claude' | 'hermes' | 'openclaw' = 'codex') {
  const row = { id: `harness_${kind}`, harness: kind, displayName: kind, installState: kind === 'codex' ? 'installed' : 'missing', authState: 'unknown', loginMethods: ['terminal'], selectedAccountId: null };
  const snapshot = { revision: 0, access: { mode: 'writable' }, harnesses: [row], harnessCatalog: [] };
  const store = { getSnapshot: vi.fn(async () => snapshot), mutate: vi.fn(async () => ({ kind: 'login_attempt', attempt: { action: { kind: 'open_terminal', terminalSessionId: `${ref.workspaceId}:${ref.tabId}` } } })) } as unknown as ProviderSettingsStoreWriter;
  let observer: Parameters<TerminalRuntimeSocketClient['attach']>[0];
  const close = vi.fn(); const order: string[] = [];
  const terminal = { ensureWorkspace: vi.fn(async () => ({ id: ref.workspaceId })), createTab: vi.fn(async () => ({ id: ref.tabId, workspaceId: ref.workspaceId, incarnation: 'ti_11111111111111111111111111111111' })), listWorkspaces: vi.fn(async () => [{ tabs: [{ id: ref.tabId, workspaceId: ref.workspaceId }] }]), terminateTab: vi.fn(async () => { order.push('terminate'); }), attach: vi.fn(input => { observer = input; return { close, send: vi.fn() }; }) } as unknown as Pick<TerminalRuntimeSocketClient, 'ensureWorkspace' | 'createTab' | 'listWorkspaces' | 'terminateTab' | 'attach'>;
  return { store, terminal, row, observer: () => observer, order };
}
it('uses native Codex account RPC in Settings without a Terminal login mutation', async () => {
  const f = nativeFixture();
  const cancel = vi.fn(async () => {});
  const login = vi.fn(async ({ onSuccess }) => {
    expect(f.store.mutate).not.toHaveBeenCalled();
    f.row.authState = 'authenticated';
    await onSuccess(); return { cancel };
  });
  const [adapter] = await createNativeProviderWorkflowAdapters({ store: f.store, terminal: f.terminal,
    codexSettingsLogin: login, hostControl: { available: false, run: vi.fn() } });
  const result = await adapter!.start({ request: { harnessInstanceId: 'harness_codex', kind: 'login', method: 'device_code', idempotencyKey: 'rpc-connect' }, publish: vi.fn() });
  expect(login).toHaveBeenCalledOnce(); expect(result.terminalSessionId).toBeUndefined();
  expect(f.terminal.attach).not.toHaveBeenCalled();
  expect(f.store.mutate).toHaveBeenCalledWith(expect.objectContaining({ type: 'set_harness_enabled', enabled: true }));
});
describe('native workflow runtime wiring', () => {
  it('does not treat exit zero as verified authentication without exact credential observation', async () => {
    const f = nativeFixture(); const [adapter] = await createNativeProviderWorkflowAdapters({ store: f.store, terminal: f.terminal, hostControl: { available: false, run: vi.fn() } });
    const publish = vi.fn(); const running = await adapter!.start({ request: { harnessInstanceId: 'harness_codex', kind: 'login', method: 'terminal', idempotencyKey: 'exact' }, publish });
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
  await expect(adapter!.start({ request: { harnessInstanceId: 'harness_codex', kind: 'login', method: 'terminal', idempotencyKey: 'lookup-failure' }, publish: vi.fn() })).rejects.toThrow();
  expect(f.terminal.terminateTab).toHaveBeenCalledWith(ref, undefined);
});
it('retains deadline cleanup after a transient stream cleanup failure', async () => {
  vi.useFakeTimers();
  try {
    const f = nativeFixture();
    vi.mocked(f.terminal.terminateTab).mockRejectedValueOnce(new Error('synthetic transport failure'));
    const [adapter] = await createNativeProviderWorkflowAdapters({ store: f.store, terminal: f.terminal, hostControl: { available: false, run: vi.fn() } });
    const publish = vi.fn();
    await adapter!.start({ request: { harnessInstanceId: 'harness_codex', kind: 'login', method: 'terminal', idempotencyKey: 'cleanup-retry' }, publish });
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
    await adapter!.start({ request: { harnessInstanceId: 'harness_codex', kind: 'login', method: 'terminal', idempotencyKey: 'expiry-retry' }, publish });
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

it('deliberate successful login enables the exact saved harness before reporting success', async () => {
  const f = nativeFixture();
  Object.assign(f.row, { enabled: false, authState: 'authenticated' });
  const [adapter] = await createNativeProviderWorkflowAdapters({ store: f.store, terminal: f.terminal, hostControl: { available: false, run: vi.fn() } });
  const publish = vi.fn();
  await adapter!.start({ request: { harnessInstanceId: 'harness_codex', kind: 'login', method: 'terminal', idempotencyKey: 'connect-off' }, publish });
  f.observer().onFrame({ type: 'exit', exitCode: 0, terminalRef: ref });
  await vi.waitFor(() => expect(publish).toHaveBeenCalledWith({ state: 'succeeded', safeFailure: null }));
  expect(f.store.mutate).toHaveBeenCalledWith(expect.objectContaining({ type: 'set_harness_enabled', harnessInstanceId: 'harness_codex', enabled: true, expectedRevision: 0 }));
});
it('a verified key deliberately enables an Off harness, while rejected keys leave it Off', async () => {
  const f = nativeFixture(); Object.assign(f.row, { enabled: false });
  const verify = vi.fn().mockRejectedValueOnce(new Error('rejected')).mockResolvedValueOnce(undefined);
  const [adapter] = await createNativeProviderWorkflowAdapters({ store: f.store, terminal: f.terminal, hostControl: { available: false, run: vi.fn() }, verifyKeys: { codex: verify } });
  const key = { harnessInstanceId: 'harness_codex', providerId: 'openai' as const, apiKey: 'synthetic-test' };
  await expect(adapter!.verifyKey!(key)).rejects.toThrow();
  expect(f.store.mutate).not.toHaveBeenCalled();
  await adapter!.verifyKey!(key);
  expect(f.store.mutate).toHaveBeenCalledWith(expect.objectContaining({ type: 'set_harness_enabled', enabled: true }));
});

it('Hermes uses the official owner-native Codex import with atomic exact route enablement', async () => {
  const f = nativeFixture('hermes'); f.row.installState = 'installed';
  const original = await f.store.getSnapshot();
  Object.assign(f.row, { route: { kind: 'configurable', providerId: 'anthropic', modelId: 'previous' } });
  Object.assign(original, { supportedActions: ['set_route', 'set_harness_enabled'], accessSources: [{ id: 'hermes-codex', kind: 'harness_profile', harness: 'hermes', providerId: 'openai-codex', localObservation: { state: 'present_unverified' }, eligibleModelIds: ['openai-codex:gpt-test'] }], modelProviders: [{ id: 'openai-codex', models: [{ id: 'openai-codex:gpt-test', enabled: true }] }] });
  const reuse = vi.fn(); const publish = vi.fn();
  const [adapter] = await createNativeProviderWorkflowAdapters({ store: f.store, terminal: f.terminal, hermesCodexReuse: reuse, hostControl: { available: false, run: vi.fn() } });
  expect(adapter!.loginMethods).toEqual(['existing_codex']);
  await adapter!.start({ request: { harnessInstanceId: 'harness_hermes', kind: 'login', method: 'existing_codex', idempotencyKey: 'reuse' }, publish });
  expect(reuse).toHaveBeenCalledOnce();
  expect(f.store.mutate).toHaveBeenCalledWith(expect.objectContaining({ type: 'set_route', harnessInstanceId: 'harness_hermes', accessSourceId: 'hermes-codex', enableHarness: true, expectedRevision: 0 }));
  expect(publish).toHaveBeenCalledWith({ state: 'succeeded', safeFailure: null });
  expect(f.terminal.createTab).not.toHaveBeenCalled();
});
it('Hermes reuse fails safely without an eligible exact native route and does not enable', async () => {
  const f = nativeFixture('hermes'); f.row.installState = 'installed';
  Object.assign(await f.store.getSnapshot(), { accessSources: [], modelProviders: [] });
  const [adapter] = await createNativeProviderWorkflowAdapters({ store: f.store, terminal: f.terminal, hermesCodexReuse: vi.fn(), hostControl: { available: false, run: vi.fn() } });
  await expect(adapter!.start({ request: { harnessInstanceId: 'harness_hermes', kind: 'login', method: 'existing_codex', idempotencyKey: 'missing' }, publish: vi.fn() })).rejects.toThrow('unavailable');
  expect(f.store.mutate).not.toHaveBeenCalled();
});

it('advertises and delegates Pi Settings auth only after exact-runtime capability discovery', async () => {
  const f = nativeFixture('pi'); f.row.installState = 'installed';
  const piConnection = { capabilities: vi.fn().mockResolvedValue({ login: true, apiKey: true }), start: vi.fn().mockResolvedValue({ cancel: vi.fn() }), verifyKey: vi.fn(), close: vi.fn() };
  const [adapter] = await createNativeProviderWorkflowAdapters({ store: f.store, terminal: f.terminal, piConnection, hostControl: { available: false, run: vi.fn() } });
  expect(adapter!.loginMethods).toEqual(['device_code']); expect(adapter!.apiKeyProviders).toEqual(['openai']);
  const input = { request: { harnessInstanceId: 'harness_pi', kind: 'login' as const, method: 'device_code' as const, idempotencyKey: 'pi-settings' }, publish: vi.fn() };
  await adapter!.start(input); expect(piConnection.start).toHaveBeenCalledWith(input); expect(f.terminal.createTab).not.toHaveBeenCalled();
  piConnection.capabilities.mockRejectedValueOnce(new Error('unsupported version'));
  const [unsupported] = await createNativeProviderWorkflowAdapters({ store: f.store, terminal: f.terminal, piConnection, hostControl: { available: false, run: vi.fn() } });
  expect(unsupported!.loginMethods).toEqual([]); expect(unsupported!.apiKeyProviders).toEqual([]);
});

it('does not advertise OpenClaw key auth until installed, then uses supported Settings capability', async () => {
  const f = nativeFixture('openclaw');
  const connection = { capabilities: vi.fn(async () => ({ login: false, apiKey: true })), verifyKey: vi.fn(async () => {}) };
  const create = () => createNativeProviderWorkflowAdapters({ store: f.store, terminal: f.terminal, openclawConnection: connection, hostControl: { available: true, run: vi.fn() } });
  const [missing] = await create(); expect(missing.apiKeyProviders).toEqual([]); expect(missing.install).toBe(true); expect(connection.capabilities).not.toHaveBeenCalled();
  f.row.installState = 'installed';
  const [installed] = await create(); expect(installed.apiKeyProviders).toEqual(['openai']); expect(installed.loginMethods).toEqual([]);
  expect(installed.verifyKey).toBe(connection.verifyKey);
});

it('advertises the wired Claude browser flow so Settings never falls back to Terminal', async () => {
  const f = nativeFixture('claude'); f.row.installState = 'installed';
  const claudeBrowserLogin = vi.fn(async () => ({ cancel: vi.fn() }));
  const [adapter] = await createNativeProviderWorkflowAdapters({ store: f.store, terminal: f.terminal, hostControl: { available: false, run: vi.fn() }, claudeBrowserLogin });
  expect(adapter!.loginMethods).toEqual(['browser', 'terminal']);
  await adapter!.start({ request: { harnessInstanceId: 'harness_claude', kind: 'login', method: 'browser', idempotencyKey: 'settings-browser' }, publish: vi.fn() });
  expect(claudeBrowserLogin).toHaveBeenCalledOnce();
  expect(f.terminal.createTab).not.toHaveBeenCalled();
});

it('does not advertise or fall back from Settings device login when native Codex RPC is missing', async () => {
  const f = nativeFixture();
  const [adapter] = await createNativeProviderWorkflowAdapters({ store: f.store, terminal: f.terminal, hostControl: { available: false, run: vi.fn() } });
  expect(adapter!.loginMethods).toEqual(['terminal']);
  await expect(adapter!.start({ request: { harnessInstanceId: 'harness_codex', kind: 'login', method: 'device_code', idempotencyKey: 'no-rpc' }, publish: vi.fn() })).rejects.toThrow('unavailable');
  expect(f.store.mutate).not.toHaveBeenCalled();
  expect(f.terminal.createTab).not.toHaveBeenCalled();
});

describe('Codex native completion with independent execution readiness', () => {
  it.each(['selected', 'unrelated', 'unknown', 'failed', 'wrong-source', 'wrong-source-account'] as const)(
    'accepts only the exact authenticated selected account: %s', async mode => {
      const f = nativeFixture();
      Object.assign(f.row, {enabled: false, selectedAccountId: 'owner_codex', accessSourceId: 'owner_openai_profile', route: {kind: 'fixed', providerId: 'openai', modelId: 'gpt-test'}});
      const current = await f.store.getSnapshot();
      Object.assign(current, {
        accounts: [{id: mode === 'unrelated' ? 'other_account' : 'owner_codex', providerId: 'openai', authState: mode === 'unknown' ? 'unknown' : mode === 'failed' ? 'failed' : 'authenticated', accessSourceId: mode === 'wrong-source' ? 'other_source' : 'owner_openai_profile'}],
        accessSources: [{id: 'owner_openai_profile', providerId: 'openai', accountId: mode === 'wrong-source-account' ? 'other_account' : 'owner_codex', readiness: {state: 'unknown'}}],
      });
      vi.mocked(f.store.getSnapshot).mockImplementation(async options => ({...current,
        accounts: current.accounts.map(account => ({...account,
          authState: options?.includeNativeAccountMetadata ? account.authState : 'unknown',
        })),
      }));
      const login = vi.fn(async ({onSuccess}) => { await onSuccess(); return {cancel: vi.fn()}; });
      const [adapter] = await createNativeProviderWorkflowAdapters({store: f.store, terminal: f.terminal, codexSettingsLogin: login, hostControl: {available: false, run: vi.fn()}});
      const result = adapter!.start({request: {harnessInstanceId: 'harness_codex', kind: 'login', method: 'device_code', idempotencyKey: 'exact-account-connect'}, publish: vi.fn()});
      if (mode === 'selected') {
        await expect(result).resolves.toMatchObject({cancel: expect.any(Function)});
        expect(f.store.mutate).toHaveBeenCalledWith(expect.objectContaining({type: 'set_harness_enabled', harnessInstanceId: 'harness_codex', enabled: true, expectedRevision: current.revision}));
        expect(f.row.authState).toBe('unknown');
        expect(f.store.getSnapshot).toHaveBeenCalledWith({refresh: true, includeNativeAccountMetadata: true});
      } else {
        await expect(result).rejects.toMatchObject({message: 'unavailable'});
        expect(f.store.mutate).not.toHaveBeenCalled();
      }
    },
  );
});

it.each(['authenticated', 'native-profile', 'missing-profile'] as const)('reconciles simulated successful Claude CLI consent with exact refreshed credential observation: %s', async mode => {
  const f = nativeFixture('claude');
  Object.assign(f.row, { installState: 'installed', enabled: false,
    authState: mode === 'authenticated' ? 'authenticated' : 'unknown',
    ...(mode === 'native-profile' ? { localObservation: { state: 'present_unverified' } } : {}),
  });
  const login = vi.fn(async ({ onSuccess }) => { await onSuccess(); return { cancel: vi.fn() }; });
  const [adapter] = await createNativeProviderWorkflowAdapters({ store: f.store, terminal: f.terminal, claudeBrowserLogin: login, hostControl: { available: false, run: vi.fn() } });
  const pending = adapter!.start({ request: { harnessInstanceId: 'harness_claude', kind: 'login', method: 'browser', idempotencyKey: 'synthetic-claude-connect' }, publish: vi.fn() });
  if (mode === 'missing-profile') {
    await expect(pending).rejects.toThrow('unavailable');
    expect(f.store.mutate).not.toHaveBeenCalled();
  } else {
    await expect(pending).resolves.toMatchObject({ cancel: expect.any(Function) });
    expect(f.store.mutate).toHaveBeenCalledWith(expect.objectContaining({ type: 'set_harness_enabled', harnessInstanceId: 'harness_claude', enabled: true, expectedRevision: 0 }));
    expect(f.store.getSnapshot).toHaveBeenCalledWith({ refresh: true });
    expect(f.row.authState).toBe(mode === 'authenticated' ? 'authenticated' : 'unknown');
  }
  expect(f.terminal.createTab).not.toHaveBeenCalled();
});
