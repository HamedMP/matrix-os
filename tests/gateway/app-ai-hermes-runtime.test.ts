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
const MODEL = 'gpt-4o-mini-2024-07-18';
const modelMetadata = (url: unknown) => Response.json({ object: 'model', id: decodeURIComponent(String(url).split('/models/')[1]!), owned_by: 'openai' });
const route = { harnessId: 'hermes_work', accountId: null, accessSourceId: 'harness_hermes_openai-api', modelId: `openai-api:${MODEL}` };
const runtimeSource = () => Promise.resolve(normalizeHermesRuntimeSnapshot({ status: { gateway_running: true }, observedAt: Date.now(), options: { provider: 'openai-api', model: MODEL, providers: [{ slug: 'openai-api', authenticated: true, is_user_defined: false, auth_type: 'api_key', models: [MODEL, 'other'] }] } }));
async function snapshots() {
  const nativeHarnessCatalog = projectHermesNativeCatalog(await runtimeSource(), new Date(Date.now())); const profile = nativeHarnessCatalog.profiles[0]!;
  const settings = { harnesses: [{ ...route, id: route.harnessId, harness: 'hermes', displayName: 'Hermes', enabled: true, configuredEnabled: true, installState: 'installed', selectedAccountId: null, accessSourceId: route.accessSourceId, route: { kind: 'configurable', providerId: 'openai-api', modelId: route.modelId } }], accounts: [], modelProviders: [{ id: 'openai-api', displayName: 'OpenAI', models: profile.models }], accessSources: [{ id: route.accessSourceId, kind: 'harness_profile', harness: 'hermes', providerId: 'openai-api', accountId: null, fundingKind: 'harness_owned', eligibleModelIds: profile.models.map(model => model.id), localObservation: profile.localObservation, readiness: { state: 'unknown', checkedAt: null, staleAfter: null } }] } as ProviderSettingsSnapshot;
  const canonical = { nativeHarnessCatalog, accessSources: [], instances: [], models: [], active: { providerInstanceId: null, accessSourceId: null, modelId: null } } as AiProviderSnapshotV3;
  return { settings, canonical };
}
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'app-hermes-runtime-')); await mkdir(join(home, '.hermes')); await mkdir(join(home, 'system')); await writeFile(join(home, 'system/app-ai.json'), JSON.stringify({ apps: ['notes'] })); await writeFile(join(home, '.hermes/config.yaml'), 'model:\n  provider: openai-api\n  default: gpt-4o-mini-2024-07-18\n'); await writeFile(join(home, '.hermes/.env'), 'OPENAI_API_KEY=fixture-key'); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); await rm(join(tmpdir(), '.matrix-private', basename(home)), { recursive: true, force: true }); });
function mounted(completion?: ReturnType<typeof createHermesAppCompletion>, update?: (value: Awaited<ReturnType<typeof snapshots>>) => void, fundedCredentialProvider?: Parameters<typeof createRuntimeAppAiRoutes>[0]['fundedCredentialProvider']) {
  return createRuntimeAppAiRoutes({ homePath: home, ownerIds: ['owner'], hermesCompletion: completion, fundedCredentialProvider, providerSettingsReader: { getSnapshot: async () => { const value = await snapshots(); update?.(value); return value.settings; } }, providerSnapshotReader: { getSnapshot: async () => { const value = await snapshots(); update?.(value); return value.canonical; } } });
}
it('discovers exact Hermes native routes and executes actual HTTP POST without native agent fallback', async () => {
  const fetchImpl = vi.fn(async (url, request) => request?.method === 'GET' ? modelMetadata(url) : Response.json({ model: MODEL, status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Hermes text' }] }] }));
  const completion = createHermesAppCompletion({ homePath: home, runtimeSource, fetchImpl }); const api = mounted(completion);
  const discovery = await (await api.request('/routes?app=notes')).json(); expect(discovery.routes).toContainEqual(expect.objectContaining({ ...route, availability: 'available' }));
  const result = await api.request('/', { method: 'POST', body: JSON.stringify({ app: 'notes', prompt: 'text', route }) }); expect(result.status).toBe(200); expect(await result.json()).toEqual({ text: 'Hermes text' }); expect(fetchImpl.mock.calls.filter(([, request]) => request?.method === 'POST')).toHaveLength(1); await completion.close();
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
  const fetchImpl = vi.fn(async (url, request) => { if (request?.method === 'GET') return modelMetadata(url); await mkdir(join(home, 'system/ai-providers')); await writeFile(join(home, 'system/ai-providers/settings.json'), JSON.stringify({ schemaVersion: 1, revision: 2, harnesses: [], accountProfiles: [], gatewayPolicy: null, receipts: [] })); return Response.json({ model: MODEL, status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'withhold' }] }] }); });
  const completion = createHermesAppCompletion({ homePath: home, runtimeSource, fetchImpl }); const api = mounted(completion);
  expect((await api.request('/', { method: 'POST', body: JSON.stringify({ app: 'notes', prompt: 'text', route }) })).status).toBe(503); expect(fetchImpl.mock.calls.filter(([, request]) => request?.method === 'POST')).toHaveLength(1); await completion.close();
});
it('reuses exact Hermes profile/provider/model discovery across saved entries and filters fixed grants before probes', async () => {
  const probe = vi.fn(async (_input: Parameters<ReturnType<typeof createHermesAppCompletion>['probe']>[0]) => true); const completion = { probe, generate: vi.fn(), close: vi.fn() };
  const api = mounted(completion as never, value => { value.settings.harnesses.push({ ...value.settings.harnesses[0]!, id: 'hermes_second' }); });
  expect((await api.request('/routes?app=notes')).status).toBe(200); expect(probe).toHaveBeenCalledTimes(2);
  expect(probe.mock.calls.map(([input])=>input.harness.route.modelId)).toEqual([route.modelId,'openai-api:other']);
  await writeFile(join(home, 'system/app-ai.json'), JSON.stringify({ apps: ['notes'], route: { ...route, harnessId: 'different' } })); probe.mockClear(); expect((await api.request('/routes?app=notes')).status).toBe(200); expect(probe).not.toHaveBeenCalled();
});
it('renews Hermes snapshots when an unrelated Pi probe used the original five-second receipt window', async () => {
  let current=Date.now();const clock=vi.spyOn(Date,'now').mockImplementation(()=>current);
  try {
    const completion=createHermesAppCompletion({homePath:home,runtimeSource,fetchImpl:async(url,request)=>{if(request?.method!=='GET')throw Error('Unexpected inference');return modelMetadata(url);}});
    const pi={id:'pi_first',harness:'pi',displayName:'Pi',enabled:true,installState:'installed',authState:'authenticated',connectivity:'online',selectedAccountId:null,accessSourceId:'pi_openai',route:{kind:'configurable',providerId:'openai',modelId:'openai:fixture'}};
    const reader=async()=>{const value=await snapshots();value.settings.harnesses.unshift(pi as never);value.settings.accessSources.push({id:'pi_openai',kind:'harness_profile',harness:'pi',providerId:'openai',accountId:null,eligibleModelIds:['openai:fixture'],readiness:{state:'ready',staleAfter:null}} as never);value.settings.modelProviders.push({id:'openai',models:[{id:'openai:fixture',enabled:true}]} as never);return value.settings;};
    const api=createRuntimeAppAiRoutes({homePath:home,ownerIds:['owner'],hermesCompletion:completion,providerSettingsReader:{getSnapshot:reader},providerSnapshotReader:{getSnapshot:async()=>(await snapshots()).canonical},piSdkCompletion:{probe:async()=>{current+=6000;return['openai:fixture'];},generate:vi.fn(),close:vi.fn()} as never});
    const discovery=await(await api.request('/routes?app=notes')).json();expect(discovery.routes).toContainEqual(expect.objectContaining({...route,availability:'available'}));await completion.close();
  }finally{clock.mockRestore();}
});

it('does not advertise an unresolved alias merely because another model shares its proved Hermes profile', async () => {
  const fetchImpl = vi.fn(async (url, request) => { if(request?.method !== 'GET') throw Error('Unexpected inference'); return modelMetadata(url); });
  const completion = createHermesAppCompletion({homePath: home, runtimeSource, fetchImpl});
  const discovery = await (await mounted(completion).request('/routes?app=notes')).json();
  expect(discovery.routes).toContainEqual(expect.objectContaining({...route, availability:'available'}));
  expect(discovery.routes).toContainEqual(expect.objectContaining({...route, modelId:'openai-api:other', availability:'unavailable'}));
  await completion.close();
});
it('preserves the exact V3 active Hermes model beyond 128 preceding eligible models and reuses its proof across entries', async () => {
  const models = Array.from({length:129},(_,i)=>({id:`openai-api:synthetic-${i}-2026-10-09`,displayName:`Synthetic ${i}`,enabled:true}));
  const selected = {...route,harnessId:'hermes_active',modelId:models[128]!.id};
  const probe = vi.fn(async (_input: Parameters<ReturnType<typeof createHermesAppCompletion>['probe']>[0])=>true);
  const api = mounted({probe,generate:vi.fn(),close:vi.fn()} as never,value=>{
    const first=value.settings.harnesses[0]!;first.route.modelId=models[0]!.id;
    value.settings.harnesses.push({...first,id:selected.harnessId,route:{...first.route,modelId:selected.modelId}});
    value.settings.accessSources[0]!.eligibleModelIds=models.map(m=>m.id);value.settings.modelProviders[0]!.models=models as never;
    value.canonical.nativeHarnessCatalog!.profiles[0]!.models=models;
    value.canonical.instances=[{id:'active-hermes',driverId:'hermes',accountId:null}] as never;
    value.canonical.active={providerInstanceId:'active-hermes',accessSourceId:route.accessSourceId,modelId:selected.modelId};
  });
  const discovery=await(await api.request('/routes?app=notes')).json();
  expect(discovery.routes).toHaveLength(128);expect(discovery.defaultRoute).toEqual(selected);
  expect(discovery.routes).toContainEqual(expect.objectContaining({...selected,availability:'available'}));expect(probe).toHaveBeenCalledTimes(129);
});
it('preserves unrelated managed route readiness when Hermes model proof fails', async()=>{
  const api=mounted({probe:vi.fn(async()=>false),generate:vi.fn(),close:vi.fn()} as never,value=>{
    value.canonical.accessSources=[{id:'matrix_cloudflare',state:'ready',checkedAt:new Date().toISOString(),staleAfter:new Date(Date.now()+30000).toISOString(),eligibleModelIds:['managed-text']}] as never;
    value.canonical.models=[{id:'managed-text',status:'ready',eligibleAccessSourceIds:['matrix_cloudflare']}] as never;
  },{enabled:true} as never);
  const discovery=await(await api.request('/routes?app=notes')).json();
  expect(discovery.routes.filter((entry:{harnessId:string})=>entry.harnessId.startsWith('hermes')).every((entry:{availability:string})=>entry.availability==='unavailable')).toBe(true);
  expect(discovery.routes).toContainEqual(expect.objectContaining({harnessId:'matrix_ai',modelId:'managed-text',availability:'available',reason:null}));
});

it.each(['explicit', 'active default', 'fixed policy'])('generates the %s Hermes model with six-second metadata and no unrelated probe', async selection => {
  let current = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => current);
  try {
    if (selection === 'fixed policy') await writeFile(join(home, 'system/app-ai.json'), JSON.stringify({ apps: ['notes'], route }));
    const fetchImpl = vi.fn(async (url, request) => {
      if (request?.method === 'GET') { current += 6000; return modelMetadata(url); }
      return Response.json({ model: MODEL, status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'slow model text' }] }] });
    });
    const completion = createHermesAppCompletion({ homePath: home, runtimeSource, fetchImpl });
    const probe = vi.spyOn(completion, 'probe');
    const api = mounted(completion, value => {
      value.canonical.instances = [{ id: 'active-hermes', driverId: 'hermes', accountId: null }] as never;
      value.canonical.active = { providerInstanceId: 'active-hermes', accessSourceId: route.accessSourceId, modelId: route.modelId };
    });
    const result = await api.request('/', { method: 'POST', body: JSON.stringify({ app: 'notes', prompt: 'text', ...(selection === 'explicit' ? { route } : {}) }) });
    expect(result.status).toBe(200); expect(await result.json()).toEqual({ text: 'slow model text' });
    expect(probe).not.toHaveBeenCalled(); expect(fetchImpl.mock.calls.map(([, request]) => request?.method)).toEqual(['GET', 'POST']);
    await completion.close();
  } finally { clock.mockRestore(); }
});

it.each(['managed', 'anthropic', 'pi'])('executes an explicit %s route without unrelated Hermes metadata during selection or revalidation', async kind => {
  const hermesProbe = vi.fn(async () => { throw Error('Unrelated slow Hermes metadata'); });
  const value = await snapshots(); const selected = kind === 'managed'
    ? { harnessId: 'matrix_ai', accountId: null, accessSourceId: 'matrix_cloudflare', modelId: 'managed-text' }
    : { harnessId: kind === 'pi' ? 'pi_work' : 'claude_work', accountId: null, accessSourceId: kind === 'pi' ? 'pi_openai' : 'owner_anthropic_key', modelId: kind === 'pi' ? 'openai:fixture' : 'claude-sonnet-4-6' };
  if (kind === 'managed') {
    value.canonical.accessSources = [{ id: selected.accessSourceId, state: 'ready', checkedAt: new Date().toISOString(), staleAfter: new Date(Date.now() + 30000).toISOString(), eligibleModelIds: [selected.modelId] }] as never;
    value.canonical.models = [{ id: selected.modelId, status: 'ready', eligibleAccessSourceIds: [selected.accessSourceId] }] as never;
  } else {
    const providerId = kind === 'pi' ? 'openai' : 'anthropic';
    value.settings.harnesses.push({ id: selected.harnessId, harness: kind === 'pi' ? 'pi' : 'claude', displayName: kind, enabled: true, installState: 'installed', authState: 'authenticated', connectivity: 'online', selectedAccountId: null, accessSourceId: selected.accessSourceId, route: { kind: 'configurable', providerId, modelId: selected.modelId } } as never);
    value.settings.accessSources.push({ id: selected.accessSourceId, kind: 'harness_profile', harness: kind === 'pi' ? 'pi' : 'claude', providerId, accountId: null, eligibleModelIds: [selected.modelId], readiness: { state: 'ready', staleAfter: null } } as never);
    value.settings.modelProviders.push({ id: providerId, models: [{ id: selected.modelId, enabled: true }] } as never);
    if (kind === 'anthropic') await writeFile(join(home, 'system/config.json'), JSON.stringify({ kernel: { anthropicApiKey: 'synthetic-owner-key' } }));
  }
  const piProbe = vi.fn(async () => [selected.modelId]);
  const piGenerate = vi.fn(async (input: { revalidate: () => Promise<boolean> }) => { expect(await input.revalidate()).toBe(true); return { text: 'selected text' }; });
  const fetchImpl = vi.fn(async () => Response.json(kind === 'managed' ? { choices: [{ finish_reason: 'stop', message: { content: 'selected text' } }] } : { stop_reason: 'end_turn', content: [{ type: 'text', text: 'selected text' }] }));
  const api = createRuntimeAppAiRoutes({ homePath: home, ownerIds: ['owner'], providerSettingsReader: { getSnapshot: async () => value.settings }, providerSnapshotReader: { getSnapshot: async () => value.canonical }, hermesCompletion: { probe: hermesProbe, generate: vi.fn(), close: vi.fn() } as never, piSdkCompletion: { probe: piProbe, generate: piGenerate, close: vi.fn() } as never, fundedCredentialProvider: { enabled: true, getCredential: async () => ({ token: 'synthetic', relayBaseUrl: 'https://relay.example.test' }) } as never, fetchImpl });
  const response = await api.request('/', { method: 'POST', body: JSON.stringify({ app: 'notes', prompt: 'text', route: selected }) });
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ text: 'selected text' }); expect(hermesProbe).not.toHaveBeenCalled();
  expect(piProbe).toHaveBeenCalledTimes(kind === 'pi' ? 1 : 0);
});

it.each(['grant revoked', 'native credential changed', 'fixed policy changed', 'active route changed'])('denies selected Hermes execution when %s during metadata and never starts paid inference', async change => {
  let activeChanged = false;
  const fetchImpl = vi.fn(async url => {
    if (change === 'grant revoked') await writeFile(join(home, 'system/app-ai.json'), JSON.stringify({ apps: [] }));
    else if (change === 'native credential changed') await writeFile(join(home, '.hermes/.env'), 'OPENAI_API_KEY=replaced-owner-key');
    else if (change === 'fixed policy changed') await writeFile(join(home, 'system/app-ai.json'), JSON.stringify({ apps: ['notes'], route: { ...route, modelId: 'openai-api:other' } }));
    else activeChanged = true;
    return modelMetadata(url);
  });
  const completion = createHermesAppCompletion({ homePath: home, runtimeSource, fetchImpl });
  const api = mounted(completion, value => {
    value.canonical.instances = [{ id: 'active-hermes', driverId: 'hermes', accountId: null }] as never;
    value.canonical.active = { providerInstanceId: 'active-hermes', accessSourceId: route.accessSourceId, modelId: activeChanged ? 'openai-api:other' : route.modelId };
  });
  const response = await api.request('/', { method: 'POST', body: JSON.stringify({ app: 'notes', prompt: 'text', ...(change === 'active route changed' ? {} : { route }) }) });
  expect(response.status).toBe(503); expect(fetchImpl).toHaveBeenCalledOnce(); await completion.close();
});
