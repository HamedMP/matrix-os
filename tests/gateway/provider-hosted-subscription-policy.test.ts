import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AiProviderSnapshotV3Schema } from '@matrix-os/contracts';
import { nativeWorkflowConnectionOptions } from '../../packages/gateway/src/ai-providers/native-workflow-options.js';
import { createNativeProviderWorkflowAdapters } from '../../packages/gateway/src/ai-providers/provider-workflow-native.js';
import { createProviderWorkflowService } from '../../packages/gateway/src/ai-providers/provider-workflows.js';
import { createProviderTerminalLoginCoordinator } from '../../packages/gateway/src/ai-providers/provider-terminal-login-coordinator.js';
import { ProviderSettingsStore } from '../../packages/gateway/src/ai-providers/provider-settings-store.js';
import { providerSettingsCanonicalFixture, PROVIDER_SETTINGS_NOW } from './provider-settings-test-support.js';

const methods = ['browser', 'device_code', 'terminal', 'existing_codex'] as const;
function nativeFixture() {
  const row = { id: 'harness_codex', harness: 'codex', displayName: 'Codex', installState: 'installed', enabled: true,
    authState: 'authenticated', loginMethods: ['terminal'], selectedAccountId: 'owner_openai',
    route: { kind: 'fixed', providerId: 'openai', modelId: 'gpt-test' } };
  const snapshot = { revision: 0, access: { mode: 'writable' }, harnesses: [row], harnessCatalog: [] };
  const store = { getSnapshot: vi.fn(async () => snapshot), mutate: vi.fn() };
  const terminal = { ensureWorkspace: vi.fn(), createTab: vi.fn(), terminateTab: vi.fn(), attach: vi.fn(), listWorkspaces: vi.fn() };
  const verify = vi.fn(async () => {});
  return { row, store, terminal, verify };
}
function registryFixture() {
  return { create: vi.fn(), get: vi.fn(), delete: vi.fn(), rename: vi.fn(), observeAgentLiveness: vi.fn() };
}
describe('hosted Codex subscription exclusion', () => {
  it('does not turn stale registry methods into subscription options; API keys remain available', () => {
    expect(nativeWorkflowConnectionOptions({ harness: 'codex', methods: [...methods], keyProviders: ['openai'] }))
      .toEqual([expect.objectContaining({ id: 'openai_api_key', authKind: 'api_key', availability: 'available' })]);
  });
  it('retains existing native account state and API key verification while denying every login entry point', async () => {
    const f = nativeFixture();
    const legacyLogin = vi.fn();
    const legacyOptions = { store: f.store as never, terminal: f.terminal as never, codexSettingsLogin: legacyLogin,
      hostControl: { available: false, run: vi.fn() }, verifyKeys: { codex: f.verify } };
    const [adapter] = await createNativeProviderWorkflowAdapters(legacyOptions);
    expect(adapter!.loginMethods).toEqual([]);
    expect(adapter!.connectionOptions).toEqual([expect.objectContaining({ authKind: 'api_key' })]);
    expect(f.row.authState).toBe('authenticated');
    const service = createProviderWorkflowService({ ownerId: 'owner', adapters: async () => [adapter!] });
    try {
      for (const method of methods) {
        const request = { harnessInstanceId: f.row.id, kind: 'login' as const, method, idempotencyKey: `deny-${method}` };
        await expect(service.start('owner', request)).rejects.toThrow('unavailable');
        await expect(service.startV2('owner', { harnessInstanceId: f.row.id, optionId: `openai_${method}`, idempotencyKey: `v2-${method}` })).rejects.toThrow('unavailable');
        await expect(adapter!.start({ request, publish: vi.fn(), registerCleanup: vi.fn(),
          connectionOption: { id: `forged-${method}`, providerId: 'openai', authKind: 'subscription', method,
            billingKind: 'subscription', executionKind: 'native', availability: 'available' } })).rejects.toThrow('unavailable');
      }
      expect(f.store.mutate).not.toHaveBeenCalled();
      expect(f.terminal.createTab).not.toHaveBeenCalled();
      expect(f.terminal.attach).not.toHaveBeenCalled();
      expect(legacyLogin).not.toHaveBeenCalled();
      await expect(service.verifyKeyV2('owner', { harnessInstanceId: f.row.id, optionId: 'openai_api_key', apiKey: 'synthetic-test' })).resolves.toEqual({ verified: true });
      expect(f.verify).toHaveBeenCalledOnce();
    } finally { await service.close(); }
  });
  it('denies direct coordinator login even when legacy startup enables Codex, before native effects', async () => {
    const homePath = await mkdtemp(join(tmpdir(), 'hosted-codex-login-'));
    const registry = registryFixture();
    const acquire = vi.fn();
    const run = vi.fn();
    try {
      const login = createProviderTerminalLoginCoordinator({ homePath, registry: registry as never, enabledHarnesses: ['codex', 'claude'], profileGuard: { acquire, run } as never });
      const harness = { id: 'harness_codex', driverId: 'codex', harness: 'codex' as const, installState: 'installed' as const, providerId: 'openai', modelId: 'gpt-test' };
      expect(login.supportedMethods(harness)).toEqual([]);
      await expect(login.startLogin({ harness, mutation: { type: 'start_login', harnessInstanceId: harness.id, accountId: null, method: 'terminal', expectedRevision: 0, idempotencyKey: 'legacy' } })).rejects.toMatchObject({ code: 'lifecycle_unavailable' });
      expect(registry.create).not.toHaveBeenCalled();
      expect(registry.get).not.toHaveBeenCalled();
      expect(acquire).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    } finally { await rm(homePath, { recursive: true, force: true }); }
  });
  it('rejects provider-settings start_login mutations independently of workflow capabilities', async () => {
    const homePath = await mkdtemp(join(tmpdir(), 'hosted-codex-settings-'));
    const registry = registryFixture();
    try {
      const base = providerSettingsCanonicalFixture();
      const canonical = AiProviderSnapshotV3Schema.parse(JSON.parse(JSON.stringify(base).replaceAll('anthropic', 'openai').replaceAll('claude_code', 'codex')));
      const login = createProviderTerminalLoginCoordinator({ homePath, registry: registry as never, enabledHarnesses: ['codex', 'claude'] });
      const store = new ProviderSettingsStore({ homePath, providerSnapshotReader: { getSnapshot: async () => canonical }, loginCoordinator: login, now: () => PROVIDER_SETTINGS_NOW });
      const snapshot = await store.getSnapshot();
      expect(snapshot.harnesses.find(row => row.id === 'harness_codex')?.loginMethods).toEqual([]);
      for (const method of ['terminal', 'oauth', 'device_code'] as const) {
        await expect(store.mutate({ type: 'start_login', harnessInstanceId: 'harness_codex', accountId: null, method,
          expectedRevision: snapshot.revision, idempotencyKey: `settings-${method}` })).rejects.toMatchObject({ code: method === 'device_code' ? 'invalid_request' : 'lifecycle_unavailable' });
      }
      expect(registry.create).not.toHaveBeenCalled();
    } finally { await rm(homePath, { recursive: true, force: true }); }
  });
  it('removes production subscription wiring while retaining the Codex API-key saver', async () => {
    const source = await readFile(new URL('../../packages/gateway/src/server/native-provider-workflow-runtime.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('createCodexSettingsLogin');
    expect(source).toContain('createCodexKeySaver({ homePath })');
  });
});
