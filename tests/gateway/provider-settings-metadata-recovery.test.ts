import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiProviderSnapshotV3Schema } from '@matrix-os/contracts';
import { ProviderSettingsStore } from '../../packages/gateway/src/ai-providers/provider-settings-store.js';
import { projectProviderSettings } from '../../packages/gateway/src/ai-providers/provider-settings-projector.js';
import { initialProviderSettingsConfiguration } from '../../packages/gateway/src/ai-providers/provider-settings-persistence.js';
import { providerSettingsCanonicalFixture, PROVIDER_SETTINGS_NOW as now } from './provider-settings-test-support.js';
import type { CodexNativeAccountMetadata } from '../../packages/gateway/src/ai-providers/codex-native-account-metadata.js';
function codexFixture() {
  const canonical = providerSettingsCanonicalFixture();
  canonical.accessSources.push({ ...canonical.accessSources[1]!, id: 'owner_openai_profile', vendor: 'openai', accountLabel: 'Codex', state: 'unknown', action: 'retry', safeReason: 'unknown' });
  canonical.accounts.push({ ...canonical.accounts[0]!, id: 'owner_openai', vendor: 'openai', accountLabel: 'Codex', state: 'unknown', action: 'retry', safeReason: 'unknown' });
  canonical.instances.push({ ...canonical.instances[1]!, id: 'codex_owner', accountId: 'owner_openai', accessSourceId: 'owner_openai_profile', vendor: 'openai' });
  canonical.drivers.push({ ...canonical.drivers[1]!, id: 'codex', installState: 'installed' });
  canonical.models.push({ ...canonical.models[0]!, id: 'codex-model', vendor: 'openai', eligibleAccessSourceIds: ['owner_openai_profile'], dataPolicies: [{ accessSourceId: 'owner_openai_profile', route: 'owner_direct', disclosureKey: 'owner-openai' }] });
  canonical.accessSources.at(-1)!.eligibleModelIds = ['codex-model'];
  canonical.instances.at(-1)!.modelIds = ['codex-model'];
  canonical.instances.at(-1)!.defaultModelId = 'codex-model';
  canonical.instances.at(-1)!.driverId = 'codex';
  return AiProviderSnapshotV3Schema.parse(canonical);
}
const metadata: CodexNativeAccountMetadata = { accountLabel: 'old@example.test', authMethod: 'terminal', checkedAt: now.toISOString(), staleAfter: new Date(now.getTime() + 30000).toISOString() };
const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
describe('metadata recovery boundaries', () => {
  it('wires the same selected CODEX_HOME as canonical observation', async () => {
    const server = await readFile(new URL('../../packages/gateway/src/server.ts', import.meta.url), 'utf8');
    expect(server).toMatch(/createCodexNativeAccountMetadataReader\(\{[\s\S]*?environment: \{[\s\S]*?CODEX_HOME: process\.env\.CODEX_HOME/);
  });
  it('reconciles only exact native API-key presentation without changing canonical authority', async () => {
    const canonical = codexFixture();
    const original = structuredClone(canonical);
    const snapshot = await projectProviderSettings({ canonical, config: initialProviderSettingsConfiguration(canonical), now, supportedActions: [], codexNativeAccountMetadata: { ...metadata, accountLabel: 'API key', authMethod: 'api_key' } });
    expect(snapshot.accounts.find(a => a.id === 'owner_openai')).toMatchObject({ displayName: 'API key', authMethod: 'api_key', authState: 'authenticated' });
    expect(snapshot.accessSources.find(s => s.id === 'owner_openai_profile')).toMatchObject({ fundingKind: 'owner_api_key', readiness: { state: 'unknown' }, usage: { kind: 'unavailable' } });
    expect(canonical).toEqual(original);
  });
  it('allows route mutation to finish while metadata waits, then discards pre-mutation identity', async () => {
    const homePath = await mkdtemp(join(tmpdir(), 'metadata-recovery-')); homes.push(homePath);
    const canonical = codexFixture();
    let resolveMetadata!: (value: CodexNativeAccountMetadata) => void;
    let started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const native = vi.fn(() => { started(); return new Promise<CodexNativeAccountMetadata>(resolve => { resolveMetadata = resolve; }); });
    const store = new ProviderSettingsStore({ homePath, now: () => now,
      providerSnapshotReader: { getSnapshot: async () => structuredClone(canonical) }, codexNativeAccountMetadataReader: native,
      runtimeCoordinator: { supportedActions: ['set_harness_enabled'], reconcilePending: async () => undefined, isRecoveryReady: () => true,
        applyConfiguration: async () => undefined, rollbackConfiguration: async () => undefined } });
    const initial = await store.getSnapshot();
    const pending = store.getSnapshot({ includeNativeAccountMetadata: true });
    await began;
    const mutation = store.mutate({ type: 'set_harness_enabled', harnessInstanceId: initial.harnesses[0]!.id, enabled: false, expectedRevision: initial.revision, idempotencyKey: 'route-change' });
    const settled = await Promise.race([mutation.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100))]);
    resolveMetadata(metadata);
    await mutation;
    const final = await pending;
    expect(settled).toBe(true);
    expect(final.accounts.find(a => a.id === 'owner_openai')?.displayName).not.toBe(metadata.accountLabel);
    expect(final.revision).toBe(initial.revision + 1);
  });
  it('revalidates out-of-band canonical profile changes before returning identity', async () => {
    const homePath = await mkdtemp(join(tmpdir(), 'metadata-recovery-')); homes.push(homePath);
    const canonical = codexFixture();
    let resolveMetadata!: (value: CodexNativeAccountMetadata) => void;
    let started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const store = new ProviderSettingsStore({ homePath, now: () => now,
      providerSnapshotReader: { getSnapshot: async () => structuredClone(canonical) },
      codexNativeAccountMetadataReader: () => { started(); return new Promise(resolve => { resolveMetadata = resolve; }); } });
    const pending = store.getSnapshot({ includeNativeAccountMetadata: true });
    await began;
    canonical.accounts.find(account => account.id === 'owner_openai')!.accountLabel = 'New profile';
    resolveMetadata(metadata);
    expect((await pending).accounts.find(account => account.id === 'owner_openai')?.displayName).toBe('New profile');
  });
  it('absent optional metadata preserves canonical readiness and account state', async () => {
    const canonical = codexFixture();
    const input = { canonical, config: initialProviderSettingsConfiguration(canonical), now, supportedActions: [] };
    const before = await projectProviderSettings(input);
    expect(await projectProviderSettings({ ...input, codexNativeAccountMetadata: null, hermesNativeAccountMetadata: null })).toEqual(before);
  });
  it('does not launch metadata readers for uninstalled native harnesses', async () => {
    const homePath = await mkdtemp(join(tmpdir(), 'metadata-recovery-')); homes.push(homePath);
    const native = vi.fn(async () => metadata);
    const canonical = providerSettingsCanonicalFixture();
    const store = new ProviderSettingsStore({ homePath, now: () => now, providerSnapshotReader: { getSnapshot: async () => canonical }, hermesNativeAccountMetadataReader: native, codexNativeAccountMetadataReader: native });
    await store.getSnapshot({ includeNativeAccountMetadata: true });
    expect(native).not.toHaveBeenCalled();
  });
});
