import { bindNativeAccountMetadata, verifyNativeAccountMetadata } from "../../packages/gateway/src/ai-providers/native-account-metadata-binding.js";
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
  it('does not copy private verification authority through a cloned public observation', async () => {
    const observed = bindNativeAccountMetadata({ ...metadata }, async () => true);
    expect(await verifyNativeAccountMetadata(observed)).toBe(observed);
    expect(await verifyNativeAccountMetadata(structuredClone(observed))).toBeNull();
    expect(Object.getOwnPropertySymbols(observed)).toEqual([]);
    expect(Object.keys(observed).sort()).toEqual(Object.keys(metadata).sort());
  });
  it('drops a hung verifier at its outer deadline and does not publish late success', async () => {
    vi.useFakeTimers();
    try {
      let complete!: (value: boolean) => void;
      const observed = bindNativeAccountMetadata({ ...metadata }, () => new Promise(resolve => { complete = resolve; }));
      const pending = verifyNativeAccountMetadata(observed);
      await vi.advanceTimersByTimeAsync(8000);
      expect(await pending).toBeNull();
      complete(true);
      await Promise.resolve();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('fails closed on verifier rejection without logging the exception message', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const observed = bindNativeAccountMetadata({ ...metadata }, async () => { throw new Error('fixture-private-principal'); });
      expect(await verifyNativeAccountMetadata(observed)).toBeNull();
      expect(JSON.stringify(warning.mock.calls)).not.toContain('fixture-private-principal');
    } finally { warning.mockRestore(); }
  });
  it('wires the same selected CODEX_HOME as canonical observation', async () => {
    const server = await readFile(new URL('../../packages/gateway/src/server.ts', import.meta.url), 'utf8');
    expect(server).toMatch(/createCodexNativeAccountMetadataReader\(\{[\s\S]*?environment: \{[\s\S]*?CODEX_HOME: process\.env\.CODEX_HOME/);
  });
  it('reconciles only exact native API-key presentation without changing canonical authority', async () => {
    const canonical = codexFixture();
    const original = structuredClone(canonical);
    const snapshot = await projectProviderSettings({ canonical, config: initialProviderSettingsConfiguration(canonical), now, supportedActions: [], codexNativeAccountMetadata: { ...metadata, accountLabel: 'API key', authMethod: 'api_key' } });
    expect(snapshot.accounts.find(a => a.id === 'owner_openai')).toMatchObject({ displayName: 'API key', authMethod: 'api_key', authState: 'unknown' });
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
  it('does not repeat canonical probing when metadata is absent or cooling down', async () => {
    const homePath = await mkdtemp(join(tmpdir(), 'metadata-recovery-')); homes.push(homePath);
    const canonicalReader = vi.fn(async () => codexFixture());
    const store = new ProviderSettingsStore({ homePath, now: () => now, providerSnapshotReader: { getSnapshot: canonicalReader }, codexNativeAccountMetadataReader: async () => null });
    await store.getSnapshot({ includeNativeAccountMetadata: true });
    expect(canonicalReader).toHaveBeenCalledTimes(1);
  });
  it('rejects identity without current native principal proof despite identical canonical presentation', async () => {
    const homePath = await mkdtemp(join(tmpdir(), 'metadata-recovery-')); homes.push(homePath);
    const store = new ProviderSettingsStore({ homePath, now: () => now, providerSnapshotReader: { getSnapshot: async () => codexFixture() }, codexNativeAccountMetadataReader: async () => metadata });
    const snapshot = await store.getSnapshot({ includeNativeAccountMetadata: true });
    expect(snapshot.accounts.find(a => a.id === 'owner_openai')?.displayName).not.toBe(metadata.accountLabel);
  });

  it('discards an observation when the native principal switches after reader completion', async () => {
    const homePath = await mkdtemp(join(tmpdir(), 'metadata-recovery-')); homes.push(homePath);
    let current = 'old-principal';
    const observed = bindNativeAccountMetadata({ ...metadata }, async () => current === 'old-principal');
    let probes = 0;
    const store = new ProviderSettingsStore({ homePath, now: () => now,
      providerSnapshotReader: { getSnapshot: async () => { if (++probes === 2) current = 'new-principal'; return codexFixture(); } },
      codexNativeAccountMetadataReader: async () => observed });
    const snapshot = await store.getSnapshot({ includeNativeAccountMetadata: true });
    expect(snapshot.accounts.find(a => a.id === 'owner_openai')?.displayName).not.toBe(metadata.accountLabel);
    expect(JSON.stringify(snapshot)).not.toContain('principal');
  });
  it('publishes fresh funding policy paired with fresh canonical revalidation', async () => {
    const homePath = await mkdtemp(join(tmpdir(), 'metadata-recovery-')); homes.push(homePath);
    let enabled = true; let current = 'old'; let fundingReads = 0;
    const funding = { asOf: now.toISOString(), periodStart: '2026-08-01T00:00:00.000Z', monthlyBudgetMicrousd: 100,
      settledThisMonthMicrousd: 0, reservedMicrousd: 0, reservedThisMonthMicrousd: 0, promotionalBalanceMicrousd: 100, addonBalanceMicrousd: 0,
      creditBalanceMicrousd: 100, fundingShortfallMicrousd: 0, remainingBalanceMicrousd: 100, remainingBudgetMicrousd: 100 };
    const reader = vi.fn(async () => { if (++fundingReads === 2) current = 'new'; return ({ funding, policy: { enabled, globalRevision: enabled ? 1 : 2, runtimeRevision: 1,
      allowedModelIds: enabled ? ['anthropic/claude-sonnet-5'] : [], monthlyBudgetMicrousd: 100, checkedAt: now.toISOString(), staleAfter: new Date(now.getTime() + 60000).toISOString() } }); });
    const store = new ProviderSettingsStore({ homePath, now: () => now, providerSnapshotReader: { getSnapshot: async () => codexFixture() },
      fundingSummaryReader: { getFundingSummary: reader }, codexNativeAccountMetadataReader: async () => { enabled = false; return bindNativeAccountMetadata({ ...metadata }, async () => current === 'old'); } });
    const snapshot = await store.getSnapshot({ includeNativeAccountMetadata: true });
    expect(snapshot.gatewayPolicy?.allowedModelIds).toEqual([]);
    expect(snapshot.accessSources.find(source => source.id === 'matrix_included')?.eligibleModelIds).toEqual([]);
    expect(reader).toHaveBeenCalledTimes(2);
    expect(snapshot.accounts.find(a => a.id === 'owner_openai')?.displayName).not.toBe(metadata.accountLabel);
  });
  it('allows route writes while a necessary full revalidation is blocked', async () => {
    const homePath = await mkdtemp(join(tmpdir(), 'metadata-recovery-')); homes.push(homePath);
    let unblock!: () => void; let started!: () => void;
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    const began = new Promise<void>(resolve => { started = resolve; });
    let reads = 0;
    const store = new ProviderSettingsStore({ homePath, now: () => now,
      providerSnapshotReader: { getSnapshot: async () => { if (++reads === 3) { started(); await blocked; } return codexFixture(); } },
      codexNativeAccountMetadataReader: async () => bindNativeAccountMetadata({ ...metadata }, async () => true),
      runtimeCoordinator: { supportedActions: ['set_harness_enabled'], reconcilePending: async () => undefined, isRecoveryReady: () => true,
        applyConfiguration: async () => undefined, rollbackConfiguration: async () => undefined } });
    const initial = await store.getSnapshot();
    const pending = store.getSnapshot({ includeNativeAccountMetadata: true }); await began;
    const mutation = store.mutate({ type: 'set_harness_enabled', harnessInstanceId: initial.harnesses[0]!.id, enabled: false, expectedRevision: initial.revision, idempotencyKey: 'revalidation-route' });
    const settled = await Promise.race([mutation.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100))]);
    unblock(); await mutation;
    const snapshot = await pending;
    expect(settled).toBe(true);
    expect(snapshot.revision).toBe(initial.revision + 1);
    expect(snapshot.accounts.find(a => a.id === 'owner_openai')?.displayName).not.toBe(metadata.accountLabel);
  });

  it('keeps mutation admission open while bounded principal verification waits', async () => {
    const homePath = await mkdtemp(join(tmpdir(), 'metadata-recovery-')); homes.push(homePath);
    let resolveVerification!: (value: boolean) => void; let started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const observed = bindNativeAccountMetadata({ ...metadata }, () => { started(); return new Promise(resolve => { resolveVerification = resolve; }); });
    const store = new ProviderSettingsStore({ homePath, now: () => now, providerSnapshotReader: { getSnapshot: async () => codexFixture() },
      codexNativeAccountMetadataReader: async () => observed,
      runtimeCoordinator: { supportedActions: ['set_harness_enabled'], reconcilePending: async () => undefined, isRecoveryReady: () => true,
        applyConfiguration: async () => undefined, rollbackConfiguration: async () => undefined } });
    const initial = await store.getSnapshot(); const pending = store.getSnapshot({ includeNativeAccountMetadata: true }); await began;
    const mutation = store.mutate({ type: 'set_harness_enabled', harnessInstanceId: initial.harnesses[0]!.id, enabled: false, expectedRevision: initial.revision, idempotencyKey: 'profile-verification-route' });
    const settled = await Promise.race([mutation.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100))]);
    resolveVerification(true); await mutation;
    expect(settled).toBe(true);
    expect((await pending).revision).toBe(initial.revision + 1);
  });

  it('preserves proved native account and allowance without promoting canonical readiness', async () => {
    const homePath = await mkdtemp(join(tmpdir(), 'metadata-recovery-')); homes.push(homePath);
    const observed = bindNativeAccountMetadata({ ...metadata, connectionDetails: { email: metadata.accountLabel, planName: 'ChatGPT Plus' },
      usage: { kind: 'subscription_allowance', authority: 'provider_allowance', state: 'current', scope: 'account', usedBasisPoints: 2500, resetsAt: null, asOf: now.toISOString() } }, async () => true);
    const store = new ProviderSettingsStore({ homePath, now: () => now, providerSnapshotReader: { getSnapshot: async () => codexFixture() }, codexNativeAccountMetadataReader: async () => observed });
    const snapshot = await store.getSnapshot({ includeNativeAccountMetadata: true });
    expect(snapshot.accounts.find(a => a.id === 'owner_openai')).toMatchObject({ displayName: metadata.accountLabel, connectionDetails: { planName: 'ChatGPT Plus' } });
    expect(snapshot.accessSources.find(source => source.id === 'owner_openai_profile')).toMatchObject({ readiness: { state: 'unknown' }, usage: { kind: 'subscription_allowance', usedBasisPoints: 2500 } });
    expect(JSON.stringify(snapshot)).not.toContain('verifyCurrent');
  });

});
