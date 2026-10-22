import { afterEach, describe, expect, it, vi } from 'vitest';
import { BotRuntimeRegistry, type ManagedPiRuntimeBinding } from '../../packages/gateway/src/bots/runtime-registry.js';
import { createGoogleManagedBrokerTransport } from '../../packages/gateway/src/google-data/managed/broker.js';
import { loadGoogleDataPilotConfig } from '../../packages/gateway/src/google-data/runtime/pilot-config.js';
import { googleManagedInferenceIdentity } from '../../packages/gateway/src/google-data/managed/identity.js';
import { forwardBotInference } from '../../packages/gateway/src/bots/broker-inference.js';
import { qualifiedRouteFixture, qualifiedIdentity, qualifiedModel as model } from '../helpers/google-qualified-funded-fixture.js';
const binding: ManagedPiRuntimeBinding = { kind: 'managed_chat', runtimeHandle: `runtime_${'a'.repeat(32)}`, executionGeneration: '1', ownerId: qualifiedIdentity.ownerId,
  chatId: 'chat_one', runId: 'run_one', workspace: { kind: 'chat_workspace' }, rootFingerprint: 'c'.repeat(64), route: { api: 'openai-completions', modelId: model, input: ['text'], contextWindow: 128000, maxOutputTokens: 8192 },
  accessSourceId: 'matrix_included', capabilities: ['artifact.read'], requestClass: 'interactive' };
const registries: BotRuntimeRegistry[] = []; afterEach(() => { for (const registry of registries.splice(0)) registry.shutdown(); });
function setup() {
  const registry = new BotRuntimeRegistry(); registry.bind(binding); registries.push(registry);
  const token = `sk-matrix-google-funded-token_one.${'s'.repeat(43)}`;
  const credentials = { identity: qualifiedIdentity, resolveRoute: vi.fn(async () => qualifiedRouteFixture()), getCredential: vi.fn(async () => ({ token, tokenId: 'token_one', expiresAt: '2026-10-22T12:15:00.000Z',
    relayBaseUrl: qualifiedRouteFixture().relayBaseUrl, maxRunMs: 60000, requestClass: 'interactive' as const, binding: { ...qualifiedRouteFixture(), requestClass: 'interactive' as const } })), invalidate: vi.fn(), close: vi.fn(async () => undefined) };
  const inspect = vi.fn(async () => null as any); const transport = createGoogleManagedBrokerTransport({ registry, contexts: { inspect }, credentials, lifetime: new AbortController().signal });
  return { registry, credentials, inspect, transport, token };
}
describe('explicit host Google pilot admission', () => {
  it('defaults off and requires exact existing server runtime owner for opt-in', () => {
    expect(loadGoogleDataPilotConfig({}, undefined)).toEqual({ enabled: false });
    expect(loadGoogleDataPilotConfig({ MATRIX_GOOGLE_DATA_PILOT_ENABLED: 'true', MATRIX_USER_ID: 'owner_one' }, 'owner_one')).toEqual({ enabled: true, ownerId: 'owner_one' });
    for (const env of [{ MATRIX_GOOGLE_DATA_PILOT_ENABLED: 'yes' }, { MATRIX_GOOGLE_DATA_PILOT_ENABLED: 'true' },
      { MATRIX_GOOGLE_DATA_PILOT_ENABLED: 'true', MATRIX_USER_ID: 'other' }]) expect(() => loadGoogleDataPilotConfig(env, 'owner_one')).toThrow('Google pilot unavailable');
  });
});
describe('trusted managed broker route selection', () => {
  it('classifies only live durable context presence; no client flag or birth inference', async () => {
    const f = setup(); expect(await f.transport.required(binding, new AbortController().signal)).toBe(false);
    f.inspect.mockResolvedValue({ ownerId: binding.ownerId, chatId: binding.chatId, availability: 'purge-pending' });
    expect(await f.transport.required(binding, new AbortController().signal)).toBe(true); f.registry.cancelInference(binding);
    await expect(f.transport.required(binding, new AbortController().signal)).rejects.toThrow('Inference unavailable');
  });
  it('supplies stable identity separately from the exact token/class/API/model lease', async () => {
    const f = setup(); const result = await f.transport.acquire(binding, new AbortController().signal);
    expect(result.identity).toEqual(googleManagedInferenceIdentity(binding, qualifiedRouteFixture())); expect(JSON.stringify(result.identity)).not.toContain(f.token);
    expect(f.credentials.getCredential).toHaveBeenCalledWith({ api: binding.route.api, canonicalModelId: model, requestClass: binding.requestClass, signal: expect.any(AbortSignal) });
  });
  it('denies missing manager or owner mismatch and rechecks cancellation after credential await', async () => {
    const f = setup(); f.credentials.identity = { ...qualifiedIdentity, ownerId: 'other' };
    await expect(f.transport.acquire(binding, new AbortController().signal)).rejects.toThrow('Inference unavailable');
    f.credentials.identity = qualifiedIdentity; f.credentials.getCredential.mockImplementation(async () => { f.registry.cancelInference(binding); return {} as never; });
    await expect(f.transport.acquire(binding, new AbortController().signal)).rejects.toThrow('Inference unavailable');
  });
  it('never downgrades to a legacy credential when qualified acquisition fails', async () => {
    const f = setup(); f.inspect.mockResolvedValue({ ownerId: binding.ownerId, chatId: binding.chatId }); f.credentials.getCredential.mockRejectedValue(new Error('synthetic unavailable'));
    const legacy = vi.fn(), fetch = vi.fn(); const result = await forwardBotInference({ version: 1, requestId: '018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1', runtimeHandle: binding.runtimeHandle, executionGeneration: '1',
      action: 'inference.chat_completions', method: 'POST', path: '/v1/chat/completions', headers: {}, body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: 'synthetic' }] }) }, binding,
      () => ({ allowed: true, accessSourceId: 'matrix_included', allowedModelIds: [model], allowedEgressOrigins: [] }), { homePath: '/tmp', lifetime: new AbortController().signal,
        googleData: { authorize: async () => ({ allowed: true, googleOrigin: true }), managed: f.transport }, resolveCredentials: legacy, fetchImpl: fetch });
    expect(result.ok).toBe(false); expect(legacy).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it('checks current owner policy after the last token wait and before content send', async () => {
    const f = setup(); f.inspect.mockResolvedValue({ ownerId: binding.ownerId, chatId: binding.chatId }); let granted = true;
    const original = f.credentials.getCredential.getMockImplementation()!; let calls = 0;
    f.credentials.getCredential.mockImplementation(async () => { const value = await original(); if (++calls === 2) granted = false; return value; });
    const fetch = vi.fn(); const result = await forwardBotInference({ version: 1, requestId: '018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1', runtimeHandle: binding.runtimeHandle, executionGeneration: '1',
      action: 'inference.chat_completions', method: 'POST', path: '/v1/chat/completions', headers: {}, body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: 'synthetic' }] }) }, binding,
      () => ({ allowed: true, accessSourceId: 'matrix_included', allowedModelIds: [model], allowedEgressOrigins: [] }), { homePath: '/tmp', lifetime: new AbortController().signal,
        googleData: { authorize: async () => granted ? { allowed: true, googleOrigin: true } : { allowed: false }, managed: f.transport }, fetchImpl: fetch });
    expect(result).toMatchObject({ ok: false, error: 'action_denied' }); expect(fetch).not.toHaveBeenCalled();
  });
  it('uses no legacy resolver for Google managed sends, refreshes after queue waits and checks owner policy after token waits', async () => {
    const f = setup(); f.inspect.mockResolvedValue({ ownerId: binding.ownerId, chatId: binding.chatId }); const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('synthetic result', { headers: { 'content-type': 'text/event-stream' } }));
    const legacy = vi.fn(), authorize = vi.fn(async (input: any) => ({ allowed: true, googleOrigin: true }));
    const result = await forwardBotInference({ version: 1, requestId: '018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1', runtimeHandle: binding.runtimeHandle, executionGeneration: '1',
      action: 'inference.chat_completions', method: 'POST', path: '/v1/chat/completions', headers: {}, body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: 'synthetic Google text' }] }) }, binding,
      () => ({ allowed: true, accessSourceId: 'matrix_included', allowedModelIds: [model], allowedEgressOrigins: [] }), { homePath: '/tmp', lifetime: new AbortController().signal,
        runSignal: f.registry.inferenceSignal(binding)!, googleData: { authorize, managed: f.transport }, resolveCredentials: legacy, fetchImpl: fetch });
    expect(result.ok).toBe(true); expect(legacy).not.toHaveBeenCalled(); expect(f.credentials.getCredential).toHaveBeenCalledTimes(2);
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get('authorization')).toBe(`Bearer ${f.token}`);
    expect(authorize.mock.calls.every(([input]) => input.identity.credential.fingerprint === qualifiedRouteFixture().descriptor.credential.fingerprint)).toBe(true);
  });
});
