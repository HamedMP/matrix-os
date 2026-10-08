import { describe, expect, it } from 'vitest';
import { ProviderModelViewSchema } from '@matrix-os/contracts';
import { projectProviderSettings } from '../../packages/gateway/src/ai-providers/provider-settings-projector.js';
import { initialProviderSettingsConfiguration } from '../../packages/gateway/src/ai-providers/provider-settings-persistence.js';
import { createProviderSettingsRoutes } from '../../packages/gateway/src/ai-providers/provider-settings-routes.js';
import { providerSettingsCanonicalFixture, PROVIDER_SETTINGS_NOW as now } from './provider-settings-test-support.js';
async function projected() { const canonical = providerSettingsCanonicalFixture(); canonical.models[0]!.capabilities = ['tools', 'vision']; return projectProviderSettings({ canonical, config: initialProviderSettingsConfiguration(canonical), now, supportedActions: [] }); }
describe('authoritative model capabilities', () => {
  it('accepts historical models and only bounded known metadata', () => {
    const model = { id: 'model', displayName: 'Model', enabled: true };
    expect(ProviderModelViewSchema.safeParse(model).success).toBe(true);
    expect(ProviderModelViewSchema.safeParse({ ...model, capabilities: ['tools', 'vision'] }).success).toBe(true);
    expect(ProviderModelViewSchema.safeParse({ ...model, capabilities: ['coding'] }).success).toBe(false);
    expect(ProviderModelViewSchema.safeParse({ ...model, capabilities: ['tools', 'tools'] }).success).toBe(false);
  });
  it('projects canonical capabilities without inventing editorial badges', async () => {
    const snapshot = await projected(); const first = snapshot.modelProviders[0]!.models[0]!;
    expect(first.capabilities).toEqual(['tools', 'vision']);
  });
  it('leaves discovered models without authoritative metadata unbadged', async () => {
    const canonical = providerSettingsCanonicalFixture();
    const snapshot = await projectProviderSettings({ canonical, config: initialProviderSettingsConfiguration(canonical), now, supportedActions: [],
      genericModelCatalog: { providers: [{ id: 'custom', displayName: 'Custom', models: [{ id: 'custom-model', displayName: 'Custom model', enabled: true }] }], accessSources: [], failures: [] } });
    expect(snapshot.modelProviders.find(provider => provider.id === 'custom')!.models[0]).not.toHaveProperty('capabilities');
  });
  it('only exposes nested metadata after explicit version negotiation', async () => {
    const snapshot = await projected();
    const app = createProviderSettingsRoutes({ store: { getSnapshot: async () => snapshot, mutate: async () => { throw new Error('not exercised'); } }, getPrincipal: () => ({ userId: 'owner' }) });
    const historical = await (await app.request('/provider-settings?includeCapabilities=true')).json();
    expect(historical.modelProviders[0].models[0]).not.toHaveProperty('capabilities');
    const current = await (await app.request('/provider-settings?includeCapabilities=true&includeModelCapabilities=true')).json();
    expect(current.modelProviders[0].models[0].capabilities).toEqual(['tools', 'vision']);
  });
});
