import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { AiProviderSnapshotV3, ProviderSettingsSnapshot } from '@matrix-os/contracts';
import { normalizeHermesRuntimeSnapshot } from '../../packages/gateway/src/agent-config/hermes-source.js';
import { projectHermesNativeCatalog } from '../../packages/gateway/src/ai-providers/hermes-native-catalog.js';
import { createHermesAppCompletion } from '../../packages/gateway/src/app-ai/hermes-completion.js';
import { createRuntimeAppAiRoutes } from '../../packages/gateway/src/app-ai/runtime.js';
vi.mock('../../packages/gateway/src/request-principal.js', () => ({ requireRequestPrincipal: () => ({ userId: 'owner' }) }));
let home: string;
const route = { harnessId: 'hermes_work', accountId: null, accessSourceId: 'harness_hermes_openai-api', modelId: 'openai-api:fixture' };
const runtimeSource = () => Promise.resolve(normalizeHermesRuntimeSnapshot({ status: { gateway_running: true }, observedAt: Date.now(), options: { provider: 'openai-api', model: 'fixture', providers: [{ slug: 'openai-api', authenticated: true, is_user_defined: false, auth_type: 'api_key', models: ['fixture', 'other'] }] } }));
async function snapshots() {
  const nativeHarnessCatalog = projectHermesNativeCatalog(await runtimeSource(), new Date(Date.now())); const profile = nativeHarnessCatalog.profiles[0]!;
  const settings = { harnesses: [{ ...route, id: route.harnessId, harness: 'hermes', displayName: 'Hermes', enabled: true, configuredEnabled: true, installState: 'installed', selectedAccountId: null, accessSourceId: route.accessSourceId, route: { kind: 'configurable', providerId: 'openai-api', modelId: route.modelId } }], accounts: [], modelProviders: [{ id: 'openai-api', displayName: 'OpenAI', models: profile.models }], accessSources: [{ id: route.accessSourceId, kind: 'harness_profile', harness: 'hermes', providerId: 'openai-api', accountId: null, fundingKind: 'harness_owned', eligibleModelIds: profile.models.map(model => model.id), localObservation: profile.localObservation, readiness: { state: 'unknown', checkedAt: null, staleAfter: null } }] } as ProviderSettingsSnapshot;
  const canonical = { nativeHarnessCatalog, accessSources: [], instances: [], models: [], active: { providerInstanceId: null, accessSourceId: null, modelId: null } } as AiProviderSnapshotV3;
  return { settings, canonical };
}
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'app-hermes-runtime-')); await mkdir(join(home, '.hermes')); await mkdir(join(home, 'system')); await writeFile(join(home, 'system/app-ai.json'), JSON.stringify({ apps: ['notes'] })); await writeFile(join(home, '.hermes/config.yaml'), 'model:\n  provider: openai-api\n  default: fixture\n'); await writeFile(join(home, '.hermes/.env'), 'OPENAI_API_KEY=fixture-key'); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); await rm(join(tmpdir(), '.matrix-private', basename(home)), { recursive: true, force: true }); });
function mounted(completion?: ReturnType<typeof createHermesAppCompletion>, update?: (value: Awaited<ReturnType<typeof snapshots>>) => void) {
  return createRuntimeAppAiRoutes({ homePath: home, ownerIds: ['owner'], hermesCompletion: completion, providerSettingsReader: { getSnapshot: async () => { const value = await snapshots(); update?.(value); return value.settings; } }, providerSnapshotReader: { getSnapshot: async () => { const value = await snapshots(); update?.(value); return value.canonical; } } });
}
it('discovers exact Hermes native routes and executes actual HTTP POST without native agent fallback', async () => {
  const fetchImpl = vi.fn(async () => Response.json({ model: 'fixture', status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Hermes text' }] }] }));
  const completion = createHermesAppCompletion({ homePath: home, runtimeSource, fetchImpl }); const api = mounted(completion);
  const discovery = await (await api.request('/routes?app=notes')).json(); expect(discovery.routes).toContainEqual(expect.objectContaining({ ...route, availability: 'available' }));
  const result = await api.request('/', { method: 'POST', body: JSON.stringify({ app: 'notes', prompt: 'text', route }) }); expect(result.status).toBe(200); expect(await result.json()).toEqual({ text: 'Hermes text' }); expect(fetchImpl).toHaveBeenCalledOnce(); await completion.close();
});
it('does not advertise Hermes without the composed safe executor or exact canonical native catalog', async () => {
  const completion = createHermesAppCompletion({ homePath: home, runtimeSource });
  for (const api of [mounted(), mounted(completion, value => { value.canonical.nativeHarnessCatalog = undefined; })]) {
    const discovery = await (await api.request('/routes?app=notes')).json(); expect(discovery.routes.every((entry: { availability: string }) => entry.availability === 'unavailable')).toBe(true);
    expect((await api.request('/', { method: 'POST', body: JSON.stringify({ app: 'notes', prompt: 'text', route }) })).status).toBe(503);
  }
  await completion.close();
});
it('withholds completed text when a durable Settings entry is removed while the native lease is held', async () => {
  const fetchImpl = vi.fn(async () => { await mkdir(join(home, 'system/ai-providers')); await writeFile(join(home, 'system/ai-providers/settings.json'), JSON.stringify({ schemaVersion: 1, revision: 2, harnesses: [], accountProfiles: [], gatewayPolicy: null, receipts: [] })); return Response.json({ model: 'fixture', status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'withhold' }] }] }); });
  const completion = createHermesAppCompletion({ homePath: home, runtimeSource, fetchImpl }); const api = mounted(completion);
  expect((await api.request('/', { method: 'POST', body: JSON.stringify({ app: 'notes', prompt: 'text', route }) })).status).toBe(503); expect(fetchImpl).toHaveBeenCalledOnce(); await completion.close();
});
it('batches discovery by physical Hermes profile/provider and filters fixed grants before probes', async () => {
  const probe = vi.fn(async () => true); const completion = { probe, generate: vi.fn(), close: vi.fn() };
  const api = mounted(completion as never, value => { value.settings.harnesses.push({ ...value.settings.harnesses[0]!, id: 'hermes_second' }); });
  expect((await api.request('/routes?app=notes')).status).toBe(200); expect(probe).toHaveBeenCalledOnce();
  await writeFile(join(home, 'system/app-ai.json'), JSON.stringify({ apps: ['notes'], route: { ...route, harnessId: 'different' } })); probe.mockClear(); expect((await api.request('/routes?app=notes')).status).toBe(200); expect(probe).not.toHaveBeenCalled();
});
it('renews Hermes snapshots when an unrelated Pi probe used the original five-second receipt window', async () => {
  let current=Date.now();const clock=vi.spyOn(Date,'now').mockImplementation(()=>current);
  try {
    const completion=createHermesAppCompletion({homePath:home,runtimeSource});
    const pi={id:'pi_first',harness:'pi',displayName:'Pi',enabled:true,installState:'installed',authState:'authenticated',connectivity:'online',selectedAccountId:null,accessSourceId:'pi_openai',route:{kind:'configurable',providerId:'openai',modelId:'openai:fixture'}};
    const reader=async()=>{const value=await snapshots();value.settings.harnesses.unshift(pi as never);value.settings.accessSources.push({id:'pi_openai',kind:'harness_profile',harness:'pi',providerId:'openai',accountId:null,eligibleModelIds:['openai:fixture'],readiness:{state:'ready',staleAfter:null}} as never);value.settings.modelProviders.push({id:'openai',models:[{id:'openai:fixture',enabled:true}]} as never);return value.settings;};
    const api=createRuntimeAppAiRoutes({homePath:home,ownerIds:['owner'],hermesCompletion:completion,providerSettingsReader:{getSnapshot:reader},providerSnapshotReader:{getSnapshot:async()=>(await snapshots()).canonical},piSdkCompletion:{probe:async()=>{current+=6000;return['openai:fixture'];},generate:vi.fn(),close:vi.fn()} as never});
    const discovery=await(await api.request('/routes?app=notes')).json();expect(discovery.routes).toContainEqual(expect.objectContaining({...route,availability:'available'}));await completion.close();
  }finally{clock.mockRestore();}
});
