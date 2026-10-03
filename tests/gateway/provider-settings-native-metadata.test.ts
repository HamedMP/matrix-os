import { describe, expect, it, vi } from 'vitest';
import { ProviderAccountSchema } from '@matrix-os/contracts';
import { createProviderSettingsRoutes } from '../../packages/gateway/src/ai-providers/provider-settings-routes.js';
import { projectProviderSettings } from '../../packages/gateway/src/ai-providers/provider-settings-projector.js';
import { initialProviderSettingsConfiguration } from '../../packages/gateway/src/ai-providers/provider-settings-persistence.js';
import { providerSettingsCanonicalFixture, PROVIDER_SETTINGS_NOW as now } from './provider-settings-test-support.js';
import { normalizeCodexNativeAccountMetadata } from '../../packages/gateway/src/ai-providers/codex-native-account-metadata.js';
const metadata = normalizeCodexNativeAccountMetadata({ account: { type: 'chatgpt', email: 'owner@example.test', planType: 'pro' } }, { rateLimits: { primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: Math.floor(now.getTime() / 1000) + 3600 } } }, now)!;
describe('owner native account enrichment', () => {
  it('only trusted runtime owner reads request account metadata, regardless of query fields', async () => {
    const canonical = providerSettingsCanonicalFixture();
    const snapshot = await projectProviderSettings({ canonical, config: initialProviderSettingsConfiguration(canonical), now, supportedActions: [] });
    const getSnapshot = vi.fn(async () => structuredClone(snapshot));
    const owner = createProviderSettingsRoutes({ store: { getSnapshot, mutate: vi.fn() }, getPrincipal: () => ({ userId: 'owner' }), canReadNativeAccountMetadata: () => true });
    const response = await owner.request('/provider-settings');
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(getSnapshot).toHaveBeenLastCalledWith({ refresh: false, includeNativeAccountMetadata: true });
    const collaborator = createProviderSettingsRoutes({ store: { getSnapshot, mutate: vi.fn() }, getPrincipal: () => ({ userId: 'collaborator' }), canReadNativeAccountMetadata: () => false });
    expect((await collaborator.request('/provider-settings?includeNativeAccountMetadata=true')).status).toBe(200);
    expect(getSnapshot).toHaveBeenLastCalledWith({ refresh: false });
  });
  it('negotiates owner-only connection details without changing historical responses', async () => {
    const canonical = providerSettingsCanonicalFixture();
    const snapshot = await projectProviderSettings({ canonical, config: initialProviderSettingsConfiguration(canonical), now, supportedActions: [] });
    snapshot.accounts[0]!.connectionDetails = { email: 'owner@example.test', planName: 'ChatGPT Pro' };
    const store = { getSnapshot: vi.fn(async () => structuredClone(snapshot)), mutate: vi.fn() };
    const owner = createProviderSettingsRoutes({ store, getPrincipal: () => true, canReadNativeAccountMetadata: () => true });
    const historicalAccount = (await (await owner.request('/provider-settings')).json()).accounts[0];
    expect(historicalAccount.connectionDetails).toBeUndefined();
    expect(ProviderAccountSchema.omit({ connectionDetails: true }).safeParse(historicalAccount).success).toBe(true);
    expect((await (await owner.request('/provider-settings?includeAccountDetails=true')).json()).accounts[0].connectionDetails).toEqual(snapshot.accounts[0]!.connectionDetails);
    expect((await owner.request('/provider-settings?includeAccountDetails=bogus')).status).toBe(400);
    const collaborator = createProviderSettingsRoutes({ store, getPrincipal: () => true, canReadNativeAccountMetadata: () => false });
    expect((await (await collaborator.request('/provider-settings?includeAccountDetails=true')).json()).accounts[0].connectionDetails).toBeUndefined();
    const noOwnerResolver = createProviderSettingsRoutes({ store, getPrincipal: () => true });
    expect((await (await noOwnerResolver.request('/provider-settings?includeAccountDetails=true')).json()).accounts[0].connectionDetails).toBeUndefined();
  });
  it('does not opt in when no owner authority resolver exists', async () => {
    const canonical = providerSettingsCanonicalFixture();
    const snapshot = await projectProviderSettings({ canonical, config: initialProviderSettingsConfiguration(canonical), now, supportedActions: [] });
    const getSnapshot = vi.fn(async () => structuredClone(snapshot));
    expect((await createProviderSettingsRoutes({ store: { getSnapshot, mutate: vi.fn() }, getPrincipal: () => true }).request('/provider-settings')).status).toBe(200);
    expect(getSnapshot).toHaveBeenLastCalledWith({ refresh: false });
  });
  it('enriches exact Codex identity and allowance without claiming inference readiness', async () => {
    const canonical = providerSettingsCanonicalFixture();
    const original = canonical.accessSources[1]!;
    canonical.accessSources.push({ ...original, id: 'owner_openai_profile', vendor: 'openai', accountLabel: 'Codex', state: 'unknown', action: 'retry', safeReason: 'unknown' });
    canonical.accounts.push({ ...canonical.accounts[0]!, id: 'owner_openai', vendor: 'openai', accountLabel: 'Codex', state: 'unknown', action: 'retry', safeReason: 'unknown' });
    canonical.instances.push({ ...canonical.instances[1]!, id: 'codex_owner', accountId: 'owner_openai', accessSourceId: 'owner_openai_profile', vendor: 'openai' });
    canonical.models.push({ ...canonical.models[0]!, id: 'codex-model', vendor: 'openai' });
    canonical.accessSources.at(-1)!.eligibleModelIds = ['codex-model'];
    canonical.instances.at(-1)!.modelIds = ['codex-model'];
    const config = initialProviderSettingsConfiguration(canonical);
    const after = await projectProviderSettings({ canonical, config, now, supportedActions: [], codexNativeAccountMetadata: metadata });
    expect(after.accounts.find(account => account.id === 'owner_openai')?.displayName).toBe('owner@example.test');
    expect(after.accounts.find(account => account.id === 'owner_openai')?.connectionDetails).toEqual({ email: 'owner@example.test', planName: 'ChatGPT Pro' });
    expect(after.accessSources.find(source => source.id === 'owner_openai_profile')).toMatchObject({ readiness: { state: 'unknown' }, usage: { kind: 'subscription_allowance', usedBasisPoints: 2000 } });
    const expired = await projectProviderSettings({ canonical, config, now: new Date(now.getTime() + 31_000), supportedActions: [], codexNativeAccountMetadata: metadata });
    expect(expired.accounts.find(account => account.id === 'owner_openai')?.displayName).toBe('Codex');
    expect(expired.accounts.find(account => account.id === 'owner_openai')?.connectionDetails).toBeUndefined();
  });
  it('Hermes projects its own exact native metadata without borrowing standalone Codex', async () => {
    const canonical = providerSettingsCanonicalFixture();
    const config = initialProviderSettingsConfiguration(canonical);
    const source = { id: 'harness_hermes_openai-codex', kind: 'harness_profile' as const, harness: 'hermes' as const,
      fundingKind: 'owner_account' as const, providerId: 'openai-codex', accountId: null, displayName: 'Hermes account',
      readiness: { state: 'unknown' as const, checkedAt: null, staleAfter: null, action: 'retry' as const, safeReason: 'unknown' as const },
      localObservation: { state: 'present_unverified' as const, checkedAt: now.toISOString(), staleAfter: new Date(now.getTime() + 5000).toISOString() },
      eligibleModelIds: ['native-model'], usage: { kind: 'unavailable' as const, authority: 'unavailable' as const, state: 'unavailable' as const, scope: 'access_source' as const, reason: 'unknown' as const, asOf: null } };
    canonical.drivers.push({ ...canonical.drivers[0]!, id: "hermes", nativeRouteObservation: { providerId: "openai-codex", modelId: "native-model", credentialKind: "provider_profile", localObservation: source.localObservation } });
    const genericModelCatalog = { providers: [{ id: 'openai-codex', displayName: 'ChatGPT', models: [{ id: 'native-model', displayName: 'Native model', enabled: true }] }], accessSources: [source], failures: [] };
    const own = await projectProviderSettings({ canonical, config, now, supportedActions: [], genericModelCatalog, hermesNativeAccountMetadata: metadata });
    expect(own.accessSources.find(value => value.id === source.id)).toMatchObject({ displayName: 'owner@example.test', accountId: null, usage: { usedBasisPoints: 2000 } });
    const unrelated = await projectProviderSettings({ canonical, config, now, supportedActions: [], genericModelCatalog, codexNativeAccountMetadata: metadata });
    expect(unrelated.accessSources.find(value => value.id === source.id)?.displayName).toBe('Hermes account');
    canonical.drivers.at(-1)!.nativeRouteObservation!.providerId = 'anthropic';
    const inactive = await projectProviderSettings({ canonical, config, now, supportedActions: [], genericModelCatalog, hermesNativeAccountMetadata: metadata });
    expect(inactive.accessSources.find(value => value.id === source.id)?.displayName).toBe('Hermes account');
    const getSnapshot = vi.fn(async () => structuredClone(own));
    const response = await createProviderSettingsRoutes({ store: { getSnapshot, mutate: vi.fn() }, getPrincipal: () => true, canReadNativeAccountMetadata: () => false }).request('/provider-settings');
    const body = await response.json();
    expect(body.accessSources.find((value: { id: string }) => value.id === source.id).usage.reason).toBe('read_only');
    expect(JSON.stringify(body)).not.toContain('owner@example.test');
  });
  it('cannot enrich a different source or expired observation', async () => {
    const canonical = providerSettingsCanonicalFixture();
    const config = initialProviderSettingsConfiguration(canonical);
    const before = await projectProviderSettings({ canonical, config, now, supportedActions: [] });
    const after = await projectProviderSettings({ canonical, config, now, supportedActions: [], codexNativeAccountMetadata: metadata });
    expect(after).toEqual(before);
  });
});
