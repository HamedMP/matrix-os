import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { AiProviderSnapshotV3, ProviderAccessSource, ProviderHarnessInstance } from '@matrix-os/contracts';
import { normalizeHermesRuntimeSnapshot } from '../../packages/gateway/src/agent-config/hermes-source.js';
import { projectHermesNativeCatalog } from '../../packages/gateway/src/ai-providers/hermes-native-catalog.js';
import { createGenericNativeWriter } from '../../packages/gateway/src/ai-providers/generic-native-writer.js';
import { createHermesAppCompletion } from '../../packages/gateway/src/app-ai/hermes-completion.js';

let home: string;
const abort = () => new AbortController().signal;
const fixtures = {
  'openai-api': { requested: 'gpt-4o-mini', resolved: 'gpt-4o-mini-2024-07-18', url: 'https://api.openai.com/v1/models/gpt-4o-mini' },
  anthropic: { requested: 'claude-3-5-sonnet-latest', resolved: 'claude-3-5-sonnet-20241022', url: 'https://api.anthropic.com/v1/models/claude-3-5-sonnet-latest' },
  openrouter: { requested: 'openai/gpt-4o-mini', resolved: 'openai/gpt-4o-mini-2024-07-18', url: 'https://openrouter.ai/api/v1/model/openai/gpt-4o-mini' },
} as const;
type Provider = keyof typeof fixtures;
async function selection(provider: Provider, model: string = fixtures[provider].requested) {
  await writeFile(join(home, '.hermes/config.yaml'), `model:\n  provider: ${provider}\n  default: ${model}\n`);
  await writeFile(join(home, '.hermes/.env'), 'OPENAI_API_KEY=synthetic-openai\nANTHROPIC_API_KEY=synthetic-anthropic\nOPENROUTER_API_KEY=synthetic-router\n');
  const snapshot = () => normalizeHermesRuntimeSnapshot({ observedAt: Date.now(), status: { gateway_running: true }, options: { provider, model, providers: [{ slug: provider, name: provider, authenticated: true, is_user_defined: false, auth_type: 'api_key', models: [model] }] } });
  const profile = projectHermesNativeCatalog(snapshot(), new Date()).profiles[0]!;
  const harness = { id: 'hermes_work', harness: 'hermes', enabled: true, configuredEnabled: true, installState: 'installed', selectedAccountId: null, accessSourceId: `harness_hermes_${provider}`, route: { kind: 'configurable', providerId: provider, modelId: `${provider}:${model}` } } as ProviderHarnessInstance;
  const source = { id: harness.accessSourceId, kind: 'harness_profile', harness: 'hermes', fundingKind: 'harness_owned', readiness: { state: 'unknown', checkedAt: null, staleAfter: null }, accountId: null, providerId: provider, eligibleModelIds: profile.models.map(m => m.id), localObservation: profile.localObservation } as ProviderAccessSource;
  return { harness, source, canonical: { nativeHarnessCatalog: { profiles: [profile], failures: [] } } as AiProviderSnapshotV3, signal: abort(), runtimeSource: vi.fn(async () => snapshot()) };
}
function metadata(provider: Provider, id: string = fixtures[provider].resolved) {
  return provider === 'anthropic' ? { type: 'model', id } : provider === 'openrouter' ? { data: { id, canonical_slug: id } } : { object: 'model', id, owned_by: 'openai' };
}
function answer(provider: Provider, model: string) {
  return Response.json(provider === 'anthropic' ? { model, stop_reason: 'end_turn', content: [{ type: 'text', text: 'only text' }] } : provider === 'openrouter' ? { model, choices: [{ finish_reason: 'stop', message: { content: 'only text' } }] } : { model, status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'only text' }] }] });
}
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'app-hermes-model-')); await mkdir(join(home, '.hermes')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); await rm(join(tmpdir(), '.matrix-private', basename(home)), { recursive: true, force: true }); });

it.each(['openai-api', 'anthropic', 'openrouter'] as const)('pins a live %s alias before any paid inference', async provider => {
  const input = await selection(provider); const calls: { url: string; request: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url, request) => { calls.push({ url: String(url), request: request! }); return request!.method === 'GET' ? Response.json(metadata(provider)) : answer(provider, fixtures[provider].resolved); }) as typeof fetch;
  const completion = createHermesAppCompletion({ homePath: home, runtimeSource: input.runtimeSource, fetchImpl });
  expect(await completion.probe(input)).toBe(true);
  expect(await completion.generate({ ...input, prompt: 'only supplied text', revalidate: async () => true })).toEqual({ text: 'only text' });
  expect(calls.map(c => c.request.method)).toEqual(['GET', 'GET', 'POST']);
  expect(calls[0]!.url).toBe(fixtures[provider].url); expect(calls[1]!.url).toBe(fixtures[provider].url);
  expect(JSON.parse(String(calls[2]!.request.body)).model).toBe(fixtures[provider].resolved);
  expect(calls[0]!.request.redirect).toBe('error'); expect(calls[0]!.request.signal).toBeInstanceOf(AbortSignal);
  expect(String(calls[0]!.request.body ?? '')).not.toContain('only supplied text');
  await completion.close();
});
it('preserves an exact OpenAI snapshot selection', async () => {
  const model = fixtures['openai-api'].resolved; const input = await selection('openai-api', model);
  const fetchImpl = vi.fn(async (_url, request) => request!.method === 'GET' ? Response.json(metadata('openai-api', model)) : answer('openai-api', model)) as typeof fetch;
  const completion = createHermesAppCompletion({ homePath: home, runtimeSource: input.runtimeSource, fetchImpl });
  expect(await completion.generate({ ...input, prompt: 'text', revalidate: async () => true })).toEqual({ text: 'only text' }); await completion.close();
});
it.each(['unresolved alias', 'wrong provider', 'missing id', 'retired', 'upstream failed', 'oversized'] as const)('denies %s metadata before paid inference and during discovery', async kind => {
  const input = await selection('openai-api');
  const fetchImpl = vi.fn(async (_url, request) => {
    if (request!.method !== 'GET') return answer('openai-api', fixtures['openai-api'].resolved);
    return kind === 'upstream failed' ? new Response('', { status: 404 }) : kind === 'oversized' ? new Response(' '.repeat(65537)) : Response.json(kind === 'missing id' ? { object: 'model' } : { ...metadata('openai-api', kind === 'unresolved alias' ? fixtures['openai-api'].requested : fixtures['openai-api'].resolved), ...(kind === 'wrong provider' ? { owned_by: 'other-provider' } : {}), ...(kind === 'retired' ? { shutdown_date: '2000-01-01' } : {}) });
  }) as typeof fetch;
  const completion = createHermesAppCompletion({ homePath: home, runtimeSource: input.runtimeSource, fetchImpl });
  expect(await completion.probe(input)).toBe(false); await expect(completion.generate({ ...input, prompt: 'text', revalidate: async () => true })).rejects.toThrow();
  expect(fetchImpl.mock.calls.every(([, request]) => request!.method === 'GET')).toBe(true); await completion.close();
});
it.each(['other', 'gpt-4o-mini-2024-07-18-extra'])('denies returned model %s despite a verified alias and never falls back', async returned => {
  const input = await selection('openai-api'); const fetchImpl = vi.fn(async (_url, request) => request!.method === 'GET' ? Response.json(metadata('openai-api')) : answer('openai-api', returned)) as typeof fetch;
  const completion = createHermesAppCompletion({ homePath: home, runtimeSource: input.runtimeSource, fetchImpl });
  await expect(completion.generate({ ...input, prompt: 'text', revalidate: async () => true })).rejects.toThrow(); expect(fetchImpl).toHaveBeenCalledTimes(2); await completion.close();
});
it('does not reuse stale mapping across discovery and generation', async () => {
  const input = await selection('openai-api'); let gets = 0;
  const fetchImpl = vi.fn(async (_url, request) => request!.method === 'GET' ? Response.json(metadata('openai-api', ++gets === 1 ? fixtures['openai-api'].resolved : fixtures['openai-api'].requested)) : answer('openai-api', fixtures['openai-api'].resolved)) as typeof fetch;
  const completion = createHermesAppCompletion({ homePath: home, runtimeSource: input.runtimeSource, fetchImpl });
  expect(await completion.probe(input)).toBe(true); await expect(completion.generate({ ...input, prompt: 'text', revalidate: async () => true })).rejects.toThrow(); expect(fetchImpl).toHaveBeenCalledTimes(2); await completion.close();
});
it('rechecks the exact native profile after metadata resolution before sending inference', async () => {
  const input = await selection('openai-api'); const fetchImpl = vi.fn(async () => { await writeFile(join(home, '.hermes/.env'), 'OPENAI_API_KEY=replaced'); return Response.json(metadata('openai-api')); }) as typeof fetch;
  const completion = createHermesAppCompletion({ homePath: home, runtimeSource: input.runtimeSource, fetchImpl });
  await expect(completion.generate({ ...input, prompt: 'text', revalidate: async () => true })).rejects.toThrow(); expect(fetchImpl).toHaveBeenCalledOnce(); await completion.close();
});
it('holds the writer fence until failed metadata cancellation actually drains', async () => {
  const input = await selection('openai-api'); let finish!: () => void; let cancelling!: () => void;
  const ready = new Promise<void>(resolve => { cancelling = resolve; });
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelling(); return new Promise<void>(resolve => { finish = resolve; }); } });
  const completion = createHermesAppCompletion({ homePath: home, runtimeSource: input.runtimeSource, fetchImpl: async () => new Response(body, { status: 404 }) });
  const pending = completion.generate({ ...input, prompt: 'text', revalidate: async () => true }); const failed = expect(pending).rejects.toThrow(); await ready;
  const writer = createGenericNativeWriter(home); await expect(writer.acquire('hermes')).rejects.toThrow(); finish(); await failed;
  const release = await writer.acquire('hermes'); await release(); await completion.close();
});
it('retains an uncertain metadata cancellation fence and never starts inference', async () => {
  const input = await selection('openai-api');
  const fetchImpl = vi.fn(async () => new Response(new ReadableStream({ cancel() { throw Error('Uncertain metadata drain'); } }), { status: 503 }));
  const completion = createHermesAppCompletion({ homePath: home, runtimeSource: input.runtimeSource, fetchImpl });
  expect(await completion.probe(input)).toBe(false); await expect(completion.generate({ ...input, prompt: 'text', revalidate: async () => true })).rejects.toThrow();
  expect(fetchImpl).toHaveBeenCalledOnce(); await completion.close();
});
it('bounds metadata chunks including empty chunks and cancels overflow before inference', async () => {
  const input = await selection('openai-api'); let pulls = 0; const cancel = vi.fn();
  const fetchImpl = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(new Uint8Array()); if(pulls === 2000) controller.close(); }, cancel })));
  const completion = createHermesAppCompletion({ homePath: home, runtimeSource: input.runtimeSource, fetchImpl });
  expect(await completion.probe(input)).toBe(false); expect(pulls).toBeLessThan(2000); expect(cancel).toHaveBeenCalledOnce(); expect(fetchImpl).toHaveBeenCalledOnce(); await completion.close();
});
it.each(['openrouter/auto', 'openrouter/fusion'])('fails closed for rotating router %s without even requesting metadata', async model => {
  const input = await selection('openrouter', model); const fetchImpl = vi.fn();
  const completion = createHermesAppCompletion({ homePath: home, runtimeSource: input.runtimeSource, fetchImpl });
  expect(await completion.probe(input)).toBe(false); expect(fetchImpl).not.toHaveBeenCalled(); await completion.close();
});
it.each(['wrong author', 'variant changed'])('rejects OpenRouter %s metadata before inference', async kind => {
  const input = await selection('openrouter'); const fetchImpl = vi.fn(async () => Response.json({ data: { id: kind === 'variant changed' ? 'openai/gpt-4o-mini:free' : 'other/gpt-4o-mini', canonical_slug: 'openai/gpt-4o-mini' } }));
  const completion = createHermesAppCompletion({ homePath: home, runtimeSource: input.runtimeSource, fetchImpl });
  expect(await completion.probe(input)).toBe(false); expect(fetchImpl).toHaveBeenCalledOnce(); await completion.close();
});
it.each(['', ':free'])('denies a moving OpenRouter alias%s before paid inference', async variant => {
  const selected = `openai/gpt-4o-mini${variant}`; const canonical = `openai/gpt-4o-mini-2024-07-18${variant}`;
  const input = await selection('openrouter', selected);
  const fetchImpl = vi.fn(async (_url, request) => request?.method === 'GET'
    ? Response.json({ data: { id: selected, canonical_slug: canonical } }) : answer('openrouter', canonical)) as typeof fetch;
  const completion = createHermesAppCompletion({ homePath: home, runtimeSource: input.runtimeSource, fetchImpl });
  expect(await completion.probe(input)).toBe(false);
  await expect(completion.generate({ ...input, prompt: 'text', revalidate: async () => true })).rejects.toThrow();
  expect(fetchImpl.mock.calls.every(([, request]) => request!.method === 'GET')).toBe(true);
  await completion.close();
});
it('preserves an attested permanent OpenRouter catalog variant without inventing or dropping its suffix', async () => {
  const selected = 'openai/gpt-4o-mini-2024-07-18:free'; const input = await selection('openrouter', selected); const calls: RequestInit[] = [];
  const fetchImpl: typeof fetch = async (_url, request) => { calls.push(request!); return request?.method === 'GET'
    ? Response.json({ data: { id: selected, canonical_slug: selected } }) : answer('openrouter', selected); };
  const completion = createHermesAppCompletion({ homePath: home, runtimeSource: input.runtimeSource, fetchImpl });
  expect(await completion.generate({ ...input, prompt: 'text', revalidate: async () => true })).toEqual({ text: 'only text' });
  expect(calls.map(c => c.method)).toEqual(['GET', 'POST']); expect(JSON.parse(String(calls[1]!.body)).model).toBe(selected);
  await completion.close();
});
it('renews native proof freshness after slow metadata and uses a bounded separate lookup deadline', async () => {
  let current = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => current); const timeout = vi.spyOn(AbortSignal, 'timeout');
  try {
    const input = await selection('openai-api'); const fetchImpl: typeof fetch = async (_url, request) => { if(request?.method === 'GET') { current += 6000; return Response.json(metadata('openai-api')); } return answer('openai-api', fixtures['openai-api'].resolved); };
    const completion = createHermesAppCompletion({ homePath: home, runtimeSource: input.runtimeSource, fetchImpl });
    expect(await completion.generate({ ...input, prompt: 'text', revalidate: async () => true })).toEqual({ text: 'only text' }); expect(timeout).toHaveBeenCalledWith(10000); expect(timeout).toHaveBeenCalledWith(30000); await completion.close();
  } finally { timeout.mockRestore(); clock.mockRestore(); }
});
