import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { AiProviderSnapshotV3, ProviderAccessSource, ProviderHarnessInstance } from '@matrix-os/contracts';
import { normalizeHermesRuntimeSnapshot } from '../../packages/gateway/src/agent-config/hermes-source.js';
import { projectHermesNativeCatalog } from '../../packages/gateway/src/ai-providers/hermes-native-catalog.js';
import { createGenericNativeWriter } from '../../packages/gateway/src/ai-providers/generic-native-writer.js';
import { completeHermesHttp } from '../../packages/gateway/src/app-ai/hermes-http.js';
import { createHermesAppCompletion as createRawHermesAppCompletion } from '../../packages/gateway/src/app-ai/hermes-completion.js';
let home: string;
const now = () => Date.now();
const abort = () => new AbortController().signal;
const OPENAI_MODEL = 'gpt-4o-mini-2024-07-18';
const ALTERNATIVE_MODEL = 'gpt-4o-2024-08-06';
const nativeModel = (provider: string) => provider === 'anthropic' ? 'claude-sonnet-4-6' : provider === 'openrouter' ? 'openai/gpt-4o-mini' : provider === 'openai-codex' ? 'fixture' : OPENAI_MODEL;
// Existing transport/fence cases target paid POSTs; supply separate realistic
// provider metadata GET responses so their cancellation fixtures retain that scope.
function createHermesAppCompletion(options: Parameters<typeof createRawHermesAppCompletion>[0]) {
  return createRawHermesAppCompletion({ ...options, fetchImpl: async (url, request) => {
    if (request?.method === 'GET') {
      const parsed = new URL(String(url)); const model = decodeURIComponent(parsed.pathname.split('/models/')[1] ?? parsed.pathname.split('/model/')[1]!);
      return Response.json(parsed.hostname === 'api.anthropic.com' ? { type: 'model', id: model } : parsed.hostname === 'openrouter.ai' ? { data: { id: model, canonical_slug: model } } : { object: 'model', id: model, owned_by: 'openai' });
    }
    if (!options.fetchImpl) throw Error('Unexpected inference in transport fixture');
    return options.fetchImpl(url, request);
  } });
}
function fixture(provider = 'openai-api', model = nativeModel(provider)) {
  if (model === 'alternative') model = ALTERNATIVE_MODEL;
  const modelId = `${provider}:${model}`;
  const harness = { id: 'hermes_work', harness: 'hermes', enabled: true, configuredEnabled: true, installState: 'installed', selectedAccountId: null, accessSourceId: `harness_hermes_${provider}`, route: { kind: 'configurable', providerId: provider, modelId } } as ProviderHarnessInstance;
  const snapshot = () => normalizeHermesRuntimeSnapshot({ observedAt: now(), status: { gateway_running: true }, options: { provider, model: nativeModel(provider), providers: [{ slug: provider, name: provider, authenticated: true, is_user_defined: false, auth_type: provider === 'openai-codex' ? 'oauth' : 'api_key', models: [nativeModel(provider), ALTERNATIVE_MODEL] }] } });
  const profile = projectHermesNativeCatalog(snapshot(), new Date()).profiles[0]!;
  const source = { id: harness.accessSourceId, kind: 'harness_profile', harness: 'hermes', fundingKind: 'harness_owned', readiness: { state: 'unknown', checkedAt: null, staleAfter: null }, accountId: null, providerId: provider, eligibleModelIds: profile.models.map(m => m.id), localObservation: profile.localObservation } as ProviderAccessSource;
  const canonical = { nativeHarnessCatalog: { profiles: [profile], failures: [] } } as AiProviderSnapshotV3;
  return { harness, source, canonical, signal: abort(), runtimeSource: vi.fn(async () => snapshot()) };
}
async function profile(provider = 'openai-api', auth?: unknown) {
  await writeFile(join(home, '.hermes/config.yaml'), `model:\n  provider: ${provider}\n  default: ${nativeModel(provider)}\n`);
  await writeFile(join(home, '.hermes/.env'), 'OPENAI_API_KEY=fixture-key\nANTHROPIC_API_KEY=fixture-anthropic\nOPENROUTER_API_KEY=fixture-router\n');
  if (auth !== undefined) await writeFile(join(home, '.hermes/auth.json'), JSON.stringify(auth));
}
function token(exp = now() / 1000 + 1000, account = 'fixture-account') { return `${Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ exp, 'https://api.openai.com/auth': { chatgpt_account_id: account } })).toString('base64url')}.${Buffer.from('fixture signature').toString('base64url')}`; }
const response = (model = OPENAI_MODEL) => Response.json({ model: model === 'alternative' ? ALTERNATIVE_MODEL : model, status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'only text' }] }] });
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'app-hermes-')); await mkdir(join(home, '.hermes')); await profile(); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); await rm(join(tmpdir(), '.matrix-private', basename(home)), { recursive: true, force: true }); });
it('proves the exact app native route and executes fixed OpenAI Responses with no context/tools', async () => {
  const input = fixture(); const fetchImpl = vi.fn(async () => response());
  const completion = createHermesAppCompletion({ homePath: home, runtimeSource: input.runtimeSource, fetchImpl });
  expect(await completion.probe(input)).toBe(true);
  expect(await completion.generate({ ...input, prompt: 'only supplied text', revalidate: async () => true })).toEqual({ text: 'only text' });
  const [url, request] = fetchImpl.mock.calls[0]!;
  expect(url).toBe('https://api.openai.com/v1/responses');
  expect((request!.headers as Headers).get('authorization')).toBe('Bearer fixture-key');
  expect(JSON.parse(String(request!.body))).toEqual({ model: OPENAI_MODEL, stream: false, store: false, tools: [], tool_choice: 'none', max_output_tokens: 8192, instructions: expect.any(String), input: [{ role: 'user', content: 'only supplied text' }] });
  expect(request!.redirect).toBe('error'); expect(request!.signal).toBeInstanceOf(AbortSignal);
  await completion.close();
});
it('supports another exact eligible model without changing the Hermes default model', async () => {
  const input = fixture('openai-api', 'alternative'); const completion = createHermesAppCompletion({ homePath: home, runtimeSource: input.runtimeSource, fetchImpl: async () => response('alternative') });
  expect(await completion.probe(input)).toBe(true); expect(await completion.generate({ ...input, prompt: 'text', revalidate: async () => true })).toEqual({ text: 'only text' }); await completion.close();
});
it.each(['anthropic', 'openrouter'])('uses the exact static %s native key and no-tools protocol', async provider => {
  await profile(provider); const input = fixture(provider);
  const fetchImpl = vi.fn(async () => provider === 'anthropic' ? Response.json({ model: nativeModel(provider), stop_reason: 'end_turn', content: [{ type: 'text', text: 'only text' }] }) : Response.json({ model: nativeModel(provider), choices: [{ finish_reason: 'stop', message: { content: 'only text' } }] }));
  const completion = createHermesAppCompletion({ homePath: home, runtimeSource: input.runtimeSource, fetchImpl });
  expect(await completion.generate({ ...input, prompt: 'text', revalidate: async () => true })).toEqual({ text: 'only text' });
  const [url, request] = fetchImpl.mock.calls[0]!; const body = JSON.parse(String(request!.body));
  expect(url).toBe(provider === 'anthropic' ? 'https://api.anthropic.com/v1/messages' : 'https://openrouter.ai/api/v1/chat/completions');
  expect(body.model).toBe(nativeModel(provider)); expect(body.tools?.length ?? 0).toBe(0); expect(body.tool_choice ?? 'none').toBe('none');
  expect(JSON.stringify(body)).not.toMatch(/fixture-key|fixture-anthropic|fixture-router/); await completion.close();
});
it('denies Hermes ChatGPT OAuth before inference until native alias identity is attested', async () => {
  const access = token(); await profile('openai-codex', { active_provider: 'openai-codex', providers: { 'openai-codex': { tokens: { access_token: access, refresh_token: 'NEVER_SEND_REFRESH' } } } });
  const input = fixture('openai-codex'); const fetchImpl = vi.fn();
  const completion = createHermesAppCompletion({ homePath: home, runtimeSource: input.runtimeSource, fetchImpl });
  expect(await completion.probe(input)).toBe(false);
  await expect(completion.generate({ ...input, prompt: 'text', revalidate: async () => true })).rejects.toThrow();
  expect(fetchImpl).not.toHaveBeenCalled(); await completion.close();
});
it.each(['missing canonical', 'stale canonical', 'wrong source', 'wrong account', 'disabled', 'unknown model', 'named profile', 'credential pool', 'custom endpoint', 'executable key', 'symlink secret', 'oversize secret', 'provider differs'])('fails closed for %s', async kind => {
  const input = fixture();
  if (kind === 'missing canonical') input.canonical = {} as never;
  if (kind === 'stale canonical') input.canonical.nativeHarnessCatalog!.profiles[0]!.localObservation.staleAfter = '2000-01-01T00:00:00Z';
  if (kind === 'wrong source') input.source.id = 'another-profile';
  if (kind === 'wrong account') input.harness.selectedAccountId = 'another-account';
  if (kind === 'disabled') input.harness.enabled = input.harness.configuredEnabled = false;
  if (kind === 'unknown model') input.harness.route.modelId = 'openai-api:unknown';
  if (kind === 'named profile') await writeFile(join(home, '.hermes/active_profile'), 'work');
  if (kind === 'credential pool') await profile('openai-api', { credential_pool: { 'openai-api': [{ api_key: 'fixture-key' }] } });
  if (kind === 'custom endpoint') await writeFile(join(home, '.hermes/config.yaml'), 'model:\n  provider: openai-api\n  default: fixture\n  base_url: https://custom.invalid\n');
  if (kind === 'executable key') await writeFile(join(home, '.hermes/.env'), 'OPENAI_API_KEY=$(secret-helper)');
  if (kind === 'symlink secret') { await rm(join(home, '.hermes/.env')); await symlink('/not-allowed', join(home, '.hermes/.env')); }
  if (kind === 'oversize secret') await writeFile(join(home, '.hermes/.env'), 'X'.repeat(65537));
  if (kind === 'provider differs') await profile('openrouter');
  const fetchImpl = vi.fn(); const completion = createHermesAppCompletion({ homePath: home, runtimeSource: input.runtimeSource, fetchImpl });
  expect(await completion.probe(input)).toBe(false); await expect(completion.generate({ ...input, prompt: 'text', revalidate: async () => true })).rejects.toThrow(); expect(fetchImpl).not.toHaveBeenCalled(); await completion.close();
});
it.each(['expired', 'malformed', 'pool', 'other account active'])('rejects %s OAuth without refreshing or sending', async kind => {
  const access = kind === 'malformed' ? 'invalid' : token(kind === 'expired' ? 1 : undefined);
  await profile('openai-codex', { active_provider: kind === 'other account active' ? 'other' : 'openai-codex', providers: { 'openai-codex': { tokens: { access_token: access, refresh_token: 'never-use' } } }, ...(kind === 'pool' ? { credential_pool: { 'openai-codex': [{ access_token: access }] } } : {}) });
  const input = fixture('openai-codex'); const fetchImpl = vi.fn(); const completion = createHermesAppCompletion({ homePath: home, runtimeSource: input.runtimeSource, fetchImpl });
  expect(await completion.probe(input)).toBe(false); expect(fetchImpl).not.toHaveBeenCalled(); await completion.close();
});
it('shares the Hermes native writer fence with Settings and denies competing discovery/execution', async () => {
  const input = fixture(); const writer = createGenericNativeWriter(home); const release = await writer.acquire('hermes'); const fetchImpl = vi.fn();
  const completion = createHermesAppCompletion({ homePath: home, runtimeSource: input.runtimeSource, fetchImpl });
  expect(await completion.probe(input)).toBe(false); await expect(completion.generate({ ...input, prompt: 'text', revalidate: async () => true })).rejects.toThrow(); expect(fetchImpl).not.toHaveBeenCalled(); await release(); expect(await completion.probe(input)).toBe(true); await completion.close();
});
it.each(['before', 'after', 'key changed', 'config changed', 'active changed', 'auth changed'])('withholds text when %s authorization/proof changes', async kind => {
  const input = fixture(); let checks = 0;
  const fetchImpl = vi.fn(async () => {
    if (kind === 'key changed') await writeFile(join(home, '.hermes/.env'), 'OPENAI_API_KEY=replaced');
    if (kind === 'config changed') await profile('openrouter');
    if (kind === 'active changed') await writeFile(join(home, '.hermes/active_profile'), 'named');
    if (kind === 'auth changed') await writeFile(join(home, '.hermes/auth.json'), '{}');
    return response();
  });
  const completion = createHermesAppCompletion({ homePath: home, runtimeSource: input.runtimeSource, fetchImpl });
  const revalidate = async () => { checks++; return kind === 'before' ? false : kind === 'after' ? checks < 2 : true; };
  await expect(completion.generate({ ...input, prompt: 'text', revalidate })).rejects.toThrow(); expect(fetchImpl).toHaveBeenCalledTimes(kind === 'before' ? 0 : 1); await completion.close();
});
it.each(['model mismatch', 'tool output', 'incomplete', 'oversize', 'upstream failure'])('rejects %s response without fallback', async kind => {
  const input = fixture(); const fetchImpl = vi.fn(async () => kind === 'model mismatch' ? response('other') : kind === 'tool output' ? Response.json({ model: OPENAI_MODEL, status: 'completed', output: [{ type: 'function_call', name: 'read_file' }] }) : kind === 'incomplete' ? Response.json({ model: OPENAI_MODEL, status: 'incomplete', output: [] }) : kind === 'oversize' ? new Response(' '.repeat(256001)) : new Response('', { status: 401 }));
  const completion = createHermesAppCompletion({ homePath: home, runtimeSource: input.runtimeSource, fetchImpl });
  await expect(completion.generate({ ...input, prompt: 'text', revalidate: async () => true })).rejects.toThrow(); expect(fetchImpl).toHaveBeenCalledOnce(); await completion.close();
});
it('keeps an exact-one manual device-code profile unavailable without model attestation', async () => {
  const access = token(); await profile('openai-codex', { active_provider: 'openai-codex', credential_pool: { 'openai-codex': [{ access_token: access, refresh_token: 'never-transfer', auth_type: 'oauth', source: 'manual:device_code', base_url: 'https://chatgpt.com/backend-api/codex' }] } });
  const input = fixture('openai-codex'); const completion = createHermesAppCompletion({ homePath: home, runtimeSource: input.runtimeSource }); expect(await completion.probe(input)).toBe(false); await completion.close();
});
it.each(['ambiguous pool', 'singleton plus pool', 'wrong pool origin', 'wrong pool endpoint'])('rejects %s rather than selecting/rotating accounts', async kind => {
  const entry = { access_token: token(), refresh_token: 'never-transfer', auth_type: 'oauth', source: kind === 'wrong pool origin' ? 'imported' : 'manual:device_code', base_url: kind === 'wrong pool endpoint' ? 'https://custom.invalid' : 'https://chatgpt.com/backend-api/codex' };
  await profile('openai-codex', { active_provider: 'openai-codex', ...(kind === 'singleton plus pool' ? { providers: { 'openai-codex': { tokens: entry } } } : {}), credential_pool: { 'openai-codex': kind === 'ambiguous pool' ? [entry, entry] : [entry] } });
  const input = fixture('openai-codex'); const completion = createHermesAppCompletion({ homePath: home, runtimeSource: input.runtimeSource }); expect(await completion.probe(input)).toBe(false); await completion.close();
});
it('preserves the durable writer fence while cancelled HTTP ignores abort, then releases after real drain', async () => {
  const input = fixture(); const controller = new AbortController(); input.signal = controller.signal;
  let done!: (value: Response) => void; let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  const completion = createHermesAppCompletion({ homePath: home, runtimeSource: input.runtimeSource, fetchImpl: async () => { started(); return new Promise<Response>(resolve => { done = resolve; }); } });
  const pending = completion.generate({ ...input, prompt: 'text', revalidate: async () => true }); const failed = expect(pending).rejects.toThrow();
  await ready; controller.abort(); const other = createHermesAppCompletion({ homePath: home, runtimeSource: input.runtimeSource }); expect(await other.probe({ ...input, signal: abort() })).toBe(false);
  done(response()); await failed; expect(await other.probe({ ...input, signal: abort() })).toBe(true); await completion.close(); await other.close();
});
it('shutdown aborts active HTTP and denies new requests, releasing only after cancellation drains', async () => {
  const input = fixture(); let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  const completion = createHermesAppCompletion({ homePath: home, runtimeSource: input.runtimeSource, fetchImpl: async (_url, options) => { started(); return new Promise<Response>((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })); } });
  const pending = completion.generate({ ...input, prompt: 'text', revalidate: async () => true }); const failed = expect(pending).rejects.toThrow(); await ready; await completion.close(); await failed; expect(await completion.probe(input)).toBe(false);
});
it('requires the 30 second deadline even without caller cancellation', async () => {
  const input = fixture(); let captured: AbortSignal | undefined;
  const completion = createHermesAppCompletion({ homePath: home, runtimeSource: input.runtimeSource, fetchImpl: async (_url, options) => { captured = options!.signal!; return response(); } });
  const timeout = vi.spyOn(AbortSignal, 'timeout'); await completion.generate({ ...input, prompt: 'text', revalidate: async () => true }); expect(timeout).toHaveBeenCalledWith(30000); expect(captured).toBeInstanceOf(AbortSignal); timeout.mockRestore(); await completion.close();
});
it('renews live profile freshness after an inference lasting longer than the original five-second observation', async () => {
  let current = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => current);
  try {
    const input = fixture(); const completion = createHermesAppCompletion({ homePath: home, runtimeSource: input.runtimeSource, fetchImpl: async () => { current += 6000; return response(); } });
    expect(await completion.generate({ ...input, prompt: 'text', revalidate: async () => true })).toEqual({ text: 'only text' }); await completion.close();
  } finally { clock.mockRestore(); }
});
it('bounds empty response chunks and cancels rather than growing a buffer or starving the deadline', async () => {
  const input = fixture(); const cancel = vi.fn(); let pulls = 0;
  const body = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(new Uint8Array()); if (pulls === 20000) controller.close(); }, cancel });
  const completion = createHermesAppCompletion({ homePath: home, runtimeSource: input.runtimeSource, fetchImpl: async () => new Response(body) });
  await expect(completion.generate({ ...input, prompt: 'text', revalidate: async () => true })).rejects.toThrow(); expect(cancel).toHaveBeenCalledOnce(); expect(pulls).toBeLessThan(20000); await completion.close();
});
it('denies a retired alternative model in the fresh post-response catalog', async () => {
  const input = fixture('openai-api', 'alternative'); const original = input.runtimeSource; let calls = 0;
  const runtimeSource = vi.fn(async () => { const snapshot = await original(); if (++calls > 2) snapshot.providers[0]!.models = snapshot.providers[0]!.models.filter(model => model.id !== ALTERNATIVE_MODEL); return snapshot; });
  const completion = createHermesAppCompletion({ homePath: home, runtimeSource, fetchImpl: async () => response('alternative') }); await expect(completion.generate({ ...input, prompt: 'text', revalidate: async () => true })).rejects.toThrow(); await completion.close();
});
it('accepts only the sanctioned Anthropic configured base URL', async () => {
  await profile('anthropic'); await writeFile(join(home, '.hermes/config.yaml'), 'model:\n  provider: anthropic\n  default: fixture\n  base_url: https://api.anthropic.com\n');
  const input = fixture('anthropic'); const completion = createHermesAppCompletion({ homePath: home, runtimeSource: input.runtimeSource }); expect(await completion.probe(input)).toBe(true); await completion.close();
});
it.each(['empty header', 'empty signature', 'invalid header', 'none algorithm'])('rejects structurally malformed JWT %s', async kind => {
  const parts = token().split('.'); if (kind === 'empty header') parts[0] = ''; if (kind === 'empty signature') parts[2] = ''; if (kind === 'invalid header') parts[0] = 'invalid'; if (kind === 'none algorithm') parts[0] = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  await profile('openai-codex', { providers: { 'openai-codex': { tokens: { access_token: parts.join('.'), refresh_token: 'never-transfer' } } } });
  const input = fixture('openai-codex'); const completion = createHermesAppCompletion({ homePath: home, runtimeSource: input.runtimeSource }); expect(await completion.probe(input)).toBe(false); await completion.close();
});
it('rejects a native endpoint override in the selected profile environment', async () => {
  await writeFile(join(home, '.hermes/.env'), 'OPENAI_API_KEY=fixture-key\nOPENAI_BASE_URL=https://custom.invalid\n'); const input = fixture(); const completion = createHermesAppCompletion({ homePath: home, runtimeSource: input.runtimeSource }); expect(await completion.probe(input)).toBe(false); await completion.close();
});
it('keeps the writer fence until asynchronous body cancellation actually drains', async () => {
  const input = fixture(); const controller = new AbortController(); input.signal = controller.signal; let cancelDone!: () => void; let reading!: () => void;
  const ready = new Promise<void>(resolve => { reading = resolve; }); const body = new ReadableStream<Uint8Array>({ pull() { reading(); }, cancel() { return new Promise<void>(resolve => { cancelDone = resolve; }); } }, { highWaterMark: 0 });
  const completion = createHermesAppCompletion({ homePath: home, runtimeSource: input.runtimeSource, fetchImpl: async () => new Response(body) });
  const pending = completion.generate({ ...input, prompt: 'text', revalidate: async () => true }); const failed = expect(pending).rejects.toThrow(); await ready; controller.abort();
  await new Promise(resolve => setTimeout(resolve, 10)); const other = createHermesAppCompletion({ homePath: home, runtimeSource: input.runtimeSource }); expect(await other.probe({ ...input, signal: abort() })).toBe(false);
  cancelDone(); await failed; expect(await other.probe({ ...input, signal: abort() })).toBe(true); await completion.close(); await other.close();
});
it('retains the durable fence if transport body cancellation fails', async () => {
  const input = fixture(); const controller = new AbortController(); input.signal = controller.signal; let reading!: () => void; const ready = new Promise<void>(resolve => { reading = resolve; });
  const body = new ReadableStream<Uint8Array>({ pull() { reading(); }, cancel() { throw Error('unknown drain'); } }, { highWaterMark: 0 });
  const completion = createHermesAppCompletion({ homePath: home, runtimeSource: input.runtimeSource, fetchImpl: async () => new Response(body) });
  const pending = completion.generate({ ...input, prompt: 'text', revalidate: async () => true }); const failed = expect(pending).rejects.toThrow(); await ready; controller.abort(); await failed;
  const other = createHermesAppCompletion({ homePath: home, runtimeSource: input.runtimeSource }); expect(await other.probe({ ...input, signal: abort() })).toBe(false); await completion.close(); await other.close();
});
it('rejects completed reasoning-only output rather than claiming a text completion', async () => {
  const input = fixture(); const completion = createHermesAppCompletion({ homePath: home, runtimeSource: input.runtimeSource, fetchImpl: async () => Response.json({ model: OPENAI_MODEL, status: 'completed', output: [{ type: 'reasoning' }] }) }); await expect(completion.generate({ ...input, prompt: 'text', revalidate: async () => true })).rejects.toThrow(); await completion.close();
});
it.each(['chunked success', 'partial only', 'wrong model', 'tool item', 'tool frame', 'late error', 'wire overflow'])('validates low-level ChatGPT Codex SSE %s independently of unavailable Hermes routing', async kind => {
  await profile('openai-codex', { active_provider: 'openai-codex', providers: { 'openai-codex': { tokens: { access_token: token(), refresh_token: 'never-transfer' } } } });
  const completed = { type: 'response.completed', response: { model: kind === 'wrong model' ? 'other' : 'fixture', status: 'completed', output: kind === 'tool item' ? [{ type: 'function_call', name: 'read_file' }] : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'text café ☕' }] }] } };
  const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
  const wire = kind === 'partial only' ? frame({ type: 'response.output_text.delta', delta: 'partial' }) : kind === 'wire overflow' ? ' '.repeat(256001) : (kind === 'tool frame' ? frame({ type: 'response.output_item.added', item: { type: 'function_call' } }) : '') + frame(completed) + (kind === 'late error' ? frame({ type: 'error', error: { message: 'late failure' } }) : '');
  const bytes = Buffer.from(wire); let position = 0; const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ pull(controller) { if (position === bytes.length) { controller.close(); return; } const end = Math.min(bytes.length, position + (kind === 'wire overflow' ? 64000 : 17)); controller.enqueue(bytes.subarray(position, end)); position = end; }, cancel }, { highWaterMark: 0 });
  // This is a transport-only synthetic proof, never a native route authority.
  const proof = { provider:'openai-codex' as const,model:'fixture',responseModels:['fixture'],key:'synthetic-access',accountId:'synthetic-account',unchanged:async()=>{},live:async()=>{} };
  const result = completeHermesHttp({proof,prompt:'text',signal:abort(),fetchImpl:async()=>new Response(body,{headers:{'content-type':'text/event-stream; charset=utf-8'}})});
  if (kind === 'chunked success') expect(await result).toEqual({ text: 'text café ☕' }); else await expect(result).rejects.toThrow();
  if (kind === 'wire overflow') expect(cancel).toHaveBeenCalledOnce();
});
it('cancels a late live body after headers arrive for an already aborted request', async () => {
  const input = fixture(); const controller = new AbortController(); input.signal = controller.signal;
  let done!: (value: Response) => void; let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; }); const cancel = vi.fn();
  const completion = createHermesAppCompletion({ homePath: home, runtimeSource: input.runtimeSource, fetchImpl: async () => { started(); return new Promise<Response>(resolve => { done = resolve; }); } });
  const pending = completion.generate({ ...input, prompt: 'text', revalidate: async () => true }); const failed = expect(pending).rejects.toThrow(); await ready; controller.abort(); done(new Response(new ReadableStream({ cancel }, { highWaterMark: 0 }))); await failed; expect(cancel).toHaveBeenCalledOnce(); await completion.close();
});
it('retains the fence when cancellation of an upstream failure body cannot be proven', async () => {
  const input = fixture(); const completion = createHermesAppCompletion({ homePath: home, runtimeSource: input.runtimeSource, fetchImpl: async () => new Response(new ReadableStream({ cancel() { throw Error('unknown drain'); } }), { status: 401 }) });
  await expect(completion.generate({ ...input, prompt: 'text', revalidate: async () => true })).rejects.toThrow(); const other = createHermesAppCompletion({ homePath: home, runtimeSource: input.runtimeSource }); expect(await other.probe(input)).toBe(false); await completion.close(); await other.close();
});
it.each([401, 503])('releases the durable fence after an already-errored HTTP%s body and permits execution retry', async status => {
  const input = fixture(); const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('terminal HTTP error body')); }, cancel });
  const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(body, { status })).mockImplementation(async () => response());
  const completion = createHermesAppCompletion({ homePath: home, runtimeSource: input.runtimeSource, fetchImpl });
  try {
    await expect(completion.generate({ ...input, prompt: 'text', revalidate: async () => true })).rejects.toThrow();
    const release = await createGenericNativeWriter(home).acquire('hermes'); await release();
    expect(await completion.generate({ ...fixture(), prompt: 'retry text', revalidate: async () => true })).toEqual({ text: 'only text' });
    expect(fetchImpl).toHaveBeenCalledTimes(2); expect(cancel).not.toHaveBeenCalled();
  } finally { await completion.close(); }
});
it('retains a live HTTP failure fence until cancellation settles and keeps it when cancellation rejects', async () => {
  const input = fixture(); let cancelStarted!: () => void; let rejectCancel!: (error: Error) => void;
  const started = new Promise<void>(resolve => { cancelStarted = resolve; });
  const cancel = vi.fn(() => { cancelStarted(); return new Promise<void>((_resolve, reject) => { rejectCancel = reject; }); });
  const completion = createHermesAppCompletion({ homePath: home, runtimeSource: input.runtimeSource, fetchImpl: async () => new Response(new ReadableStream({ cancel }, { highWaterMark: 0 }), { status: 503 }) });
  const pending = completion.generate({ ...input, prompt: 'text', revalidate: async () => true }); const failure = expect(pending).rejects.toThrow();
  const writer = createGenericNativeWriter(home);
  try {
    await started; await expect(writer.acquire('hermes')).rejects.toThrow();
    rejectCancel(new Error('uncertain live response drain')); await failure;
    await expect(writer.acquire('hermes')).rejects.toThrow(); expect(cancel).toHaveBeenCalledOnce();
  } finally { await completion.close(); }
});
it('releases an already-errored successful body after cancellation before its first read and permits execution retry', async () => {
  const input = fixture(); const controller = new AbortController(); input.signal = controller.signal; const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(stream) { stream.error(new Error('terminal successful response body')); }, cancel });
  const fetchImpl = vi.fn().mockImplementationOnce(async () => { controller.abort(); return new Response(body); }).mockImplementation(async () => response());
  const completion = createHermesAppCompletion({ homePath: home, runtimeSource: input.runtimeSource, fetchImpl });
  try {
    await expect(completion.generate({ ...input, prompt: 'text', revalidate: async () => true })).rejects.toThrow();
    const release = await createGenericNativeWriter(home).acquire('hermes'); await release();
    expect(await completion.generate({ ...fixture(), prompt: 'retry text', revalidate: async () => true })).toEqual({ text: 'only text' });
    expect(fetchImpl).toHaveBeenCalledTimes(2); expect(cancel).not.toHaveBeenCalled();
  } finally { await completion.close(); }
});
it('keeps an already-cancelled successful live body fenced until drain settles and retains an uncertain drain', async () => {
  const input = fixture(); const controller = new AbortController(); input.signal = controller.signal;
  let cancelStarted!: () => void; let rejectCancel!: (error: Error) => void;
  const started = new Promise<void>(resolve => { cancelStarted = resolve; });
  const cancel = vi.fn(() => { cancelStarted(); return new Promise<void>((_resolve, reject) => { rejectCancel = reject; }); });
  const completion = createHermesAppCompletion({ homePath: home, runtimeSource: input.runtimeSource, fetchImpl: async () => { controller.abort(); return new Response(new ReadableStream({ cancel }, { highWaterMark: 0 })); } });
  const pending = completion.generate({ ...input, prompt: 'text', revalidate: async () => true }); const failure = expect(pending).rejects.toThrow();
  const writer = createGenericNativeWriter(home);
  try {
    await started; await expect(writer.acquire('hermes')).rejects.toThrow();
    rejectCancel(new Error('uncertain successful response drain')); await failure;
    await expect(writer.acquire('hermes')).rejects.toThrow(); expect(cancel).toHaveBeenCalledOnce();
  } finally { await completion.close(); }
});
it('releases the fence after a terminal HTTP stream error so a transient disconnect does not permanently block the profile', async () => {
  const input = fixture(); const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error('terminal socket failure')); } }, { highWaterMark: 0 });
  const completion = createHermesAppCompletion({ homePath: home, runtimeSource: input.runtimeSource, fetchImpl: async () => new Response(body) }); await expect(completion.generate({ ...input, prompt: 'text', revalidate: async () => true })).rejects.toThrow(); expect(await completion.probe(input)).toBe(true); await completion.close();
});
it('rejects whitespace-prefixed native endpoint overrides without evaluating the profile environment', async () => {
  await writeFile(join(home, '.hermes/.env'), 'OPENAI_API_KEY=fixture-key\n   export OPENAI_BASE_URL=https://custom.invalid\n'); const input=fixture();const completion=createHermesAppCompletion({homePath:home,runtimeSource:input.runtimeSource});expect(await completion.probe(input)).toBe(false);await completion.close();
});
