import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { AiProviderService } from '../../packages/gateway/src/ai-providers/service.js';
import { ProviderSettingsStore } from '../../packages/gateway/src/ai-providers/provider-settings-store.js';
import { createProviderGenericHarnessCoordinator } from '../../packages/gateway/src/ai-providers/provider-generic-harness-coordinator.js';
import { bindNativeAccountMetadata } from '../../packages/gateway/src/ai-providers/native-account-metadata-binding.js';
import { createCodexExecutionAdmission } from '../../packages/gateway/src/coding-agents/codex-execution-admission.js';

it.each(['stale', 'in-use', 'unsupported', 'invalid', 'eligible'] as const)('admits native removal before draining registered work: %s', async mode => {
  const homePath = await mkdtemp(join(tmpdir(), 'codex-removal-admission-'));
  let dependencies = 0;
  const stopSession = vi.fn(async () => {});
  const marker = join(homePath, 'system/ai-providers/codex-execution-revocation.json');
  const metadata = async () => bindNativeAccountMetadata({ accountLabel: 'owner@example.test', authMethod: 'terminal' as const,
    checkedAt: new Date().toISOString(), staleAfter: new Date(Date.now() + 30000).toISOString() }, async () => true, 'synthetic-native-principal');
  const service = new AiProviderService({ homePath, env: {}, driverInventory: async () => [{ id: 'codex', displayName: 'Codex', kind: 'cli', installState: 'installed', health: 'ready', setupActions: [], capabilities: ['tools'] }] });
  const runtime = createProviderGenericHarnessCoordinator({ homePath, enabledCodingHarnesses: [], runtimeController: { update: vi.fn() }, runtimeSource: vi.fn() });
  let store!: ProviderSettingsStore;
  let expectedRemovalRevision = 0;
  const admission = createCodexExecutionAdmission({ homePath, isOwner: id => id === 'owner', stopSession,
    getSnapshot: () => store.getSnapshot({ includeNativeAccountMetadata: true }), readNativeAccount: metadata });
  const remove = vi.fn(async () => {
    expect(stopSession).toHaveBeenCalledWith('sess_native_removal');
    expect(JSON.parse(await readFile(marker, 'utf8')).state).toBe('draining');
  });
  store = new ProviderSettingsStore({ homePath, providerSnapshotReader: service, runtimeCoordinator: runtime,
    codexNativeAccountMetadataReader: metadata, prepareNativeCodexRevocation: async () => {
      const release = await admission.prepareRevocation();
      return async () => {
        expect(JSON.parse(await readFile(marker, 'utf8')).state).toBe('draining');
        expect(JSON.parse(await readFile(store.configurationPath, 'utf8')).revision).toBe(expectedRemovalRevision);
        await release();
      };
    },
    accountLifecycle: { supportedActions: () => mode === 'unsupported' ? [] : ['remove_account'], logout: vi.fn(), remove },
    dependencyCoordinator: { getAccountDependencies: async () => ({ activeChatCount: dependencies, resumableChatCount: 0, harnessInstanceCount: 0 }), reassignDependencies: vi.fn() } });
  try {
    const initial = await store.getSnapshot();
    const harness = initial.harnesses.find(row => row.harness === 'codex')!;
    const complete = await store.completeCodexNativeLogin({ harnessInstanceId: harness.id, expectedRevision: initial.revision, idempotencyKey: 'native-consent' });
    await admission.start('owner', 'sess_native_removal');
    expectedRemovalRevision = complete.snapshot.revision + 1;
    dependencies = mode === 'stale' || mode === 'in-use' ? 1 : 0;
    const input = { type: 'remove_account' as const, confirmation: 'remove_account' as const, accountId: 'owner_codex', expectedRevision: complete.snapshot.revision,
      idempotencyKey: 'remove-dialog', dependencyGuard: { activeChatCount: mode === 'in-use' ? 1 : 0, resumableChatCount: 0, harnessInstanceCount: 0 } };
    if (mode === 'eligible') {
      await store.mutate(input);
      expect(remove).toHaveBeenCalledOnce();
      expect(stopSession).toHaveBeenCalledOnce();
      expect(JSON.parse(await readFile(store.configurationPath, 'utf8')).revision).toBe(complete.snapshot.revision + 1);
    } else {
      await expect(store.mutate(mode === 'invalid' ? { ...input, confirmation: 'invalid' } as never : input)).rejects.toMatchObject({ code: mode === 'stale' ? 'revision_conflict' : mode === 'in-use' ? 'account_in_use' : mode === 'invalid' ? 'invalid_request' : 'lifecycle_unavailable' });
      expect(remove).not.toHaveBeenCalled();
      expect(stopSession).not.toHaveBeenCalled();
      await expect(admission.validateLaunch('owner', 'sess_native_removal')).resolves.toBeDefined();
    }
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { service.close(); await rm(homePath, { recursive: true, force: true }); }
});
