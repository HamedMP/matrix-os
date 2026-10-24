import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { BotRuntimeRegistry, type ManagedPiRuntimeBinding } from '../../../packages/gateway/src/bots/runtime-registry.js';
import { forwardBotInference } from '../../../packages/gateway/src/bots/broker-inference.js';
import { googleInferenceIdentity } from '../../../packages/gateway/src/google-data/runtime/inference-policy.js';
import { matchesGoogleObservedRoute } from '../../../packages/gateway/src/google-data/runtime/profile-resolution.js';
import type { ScopeRuntimeBotInferenceRequest } from '@matrix-os/scope-runtime/broker-protocol';
const generation = 'e16625fe-cad7-4983-a9db-e808bbf104cc';
function binding(api: 'openai-completions' | 'openai-responses'): ManagedPiRuntimeBinding {
  return { kind: 'managed_chat', ownerId: 'owner', chatId: 'chat_api', runId: 'run_api', runtimeHandle: `runtime_${'a'.repeat(32)}`,
    executionGeneration: '1', rootFingerprint: 'b'.repeat(64), workspace: { kind: 'chat_workspace' }, requestClass: 'interactive', capabilities: ['artifact.read'],
    accessSourceId: 'owner_openai_key', openaiApi: { connectionRevision: 3, credentialGeneration: generation },
    route: { api, modelId: 'gpt-4.1', input: ['text'], contextWindow: 128000, maxOutputTokens: 8192 } } as ManagedPiRuntimeBinding;
}
function fixture(api: 'openai-completions' | 'openai-responses') {
  const candidate = binding(api), registry = new BotRuntimeRegistry();
  const request: ScopeRuntimeBotInferenceRequest = { version: 1, requestId: generation, runtimeHandle: candidate.runtimeHandle, executionGeneration: '1',
    action: api === 'openai-responses' ? 'inference.responses' : 'inference.chat_completions', method: 'POST', path: api === 'openai-responses' ? '/v1/responses' : '/v1/chat/completions', headers: {},
    body: JSON.stringify({ model: 'gpt-4.1', stream: true, ...(api === 'openai-responses' ? { input: [{ role: 'user', content: [{ type: 'input_text', text: 'synthetic' }] }] } : { messages: [{ role: 'user', content: 'synthetic' }] }) }) };
  const credential = vi.fn(async () => 'explicit-owner-api-key'); const revalidate = vi.fn(async () => true);
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response('data: {}\n\n', { headers: { 'content-type': 'text/event-stream' } }));
  const fallback = vi.fn(async () => { throw new Error('No ambient or funded credential fallback'); });
  const policy = vi.fn(async (_input: { identity: ReturnType<typeof googleInferenceIdentity> | null }) => ({ allowed: true as const, googleOrigin: true }));
  const deps = { homePath: '/unused', lifetime: new AbortController().signal, fetchImpl, resolveCredentials: fallback,
    matrixOpenAi: { credential, revalidate }, googleData: { authorize: policy } };
  const run = () => { registry.bind(candidate); return forwardBotInference(request, candidate, modelId => registry.authorize({ ...candidate, action: request.action, modelId }), deps as never); };
  return { candidate, registry, request, credential, revalidate, fetchImpl, fallback, policy, run };
}
describe('explicit owner OpenAI API transport', () => {
  it.each(['openai-completions', 'openai-responses'] as const)('dispatches %s only through exact owner API generation', async api => {
    const f = fixture(api); expect(await f.run()).toMatchObject({ ok: true });
    expect(f.fetchImpl).toHaveBeenCalledOnce(); expect(f.fetchImpl.mock.calls[0]![0]).toBe(`https://api.openai.com${f.request.path}`);
    const init = f.fetchImpl.mock.calls[0]![1]!; expect(new Headers(init.headers).get('authorization')).toBe('Bearer explicit-owner-api-key');
    expect(new Headers(init.headers).has('x-api-key')).toBe(false); expect(JSON.parse(init.body as string)).toMatchObject({ store: false });
    if (api === 'openai-responses') expect(JSON.parse(init.body as string)).toMatchObject({ max_output_tokens: 8192 });
    const identity = f.policy.mock.calls[0]![0].identity;
    expect(identity).toMatchObject({ api, endpoint: `https://api.openai.com${f.request.path}`, credential: { kind: 'api_key', generation,
      fingerprint: createHash('sha256').update('explicit-owner-api-key').digest('hex') } });
    expect(JSON.stringify(identity)).not.toContain('explicit-owner-api-key'); expect(f.fallback).not.toHaveBeenCalled(); f.registry.shutdown();
  });
  it.each(['before', 'dispatch', 'release'])('withdraws a key rotated %s dispatch without falling back', async stage => {
    const f = fixture('openai-responses');
    if (stage === 'before') f.revalidate.mockResolvedValue(false);
    if (stage === 'dispatch') f.policy.mockImplementation(async () => { f.revalidate.mockResolvedValue(false); return { allowed: true, googleOrigin: true }; });
    if (stage === 'release') f.fetchImpl.mockImplementation(async () => { f.revalidate.mockResolvedValue(false); return new Response('private response'); });
    expect((await f.run()).ok).toBe(false); expect(f.fetchImpl).toHaveBeenCalledTimes(stage === 'release' ? 1 : 0); expect(f.fallback).not.toHaveBeenCalled(); f.registry.shutdown();
  });
  it('does not accept native/OAuth profiles with API metadata or another provider API', () => {
    const registry = new BotRuntimeRegistry(), value = binding('openai-responses');
    for (const changed of [{ accessSourceId: 'owner_openai_profile' }, { route: { ...value.route, api: 'anthropic-messages' } },
      { anthropicApi: { connectionRevision: 3, credentialGeneration: generation } }]) expect(() => registry.bind({ ...value, ...changed } as never)).toThrow();
    registry.shutdown();
  });
  it.each(['openai-completions', 'openai-responses'] as const)('correlates reviewed %s route to exact observed key generation and endpoint', api => {
    const value = binding(api), path = api === 'openai-responses' ? '/v1/responses' : '/v1/chat/completions';
    const identity = googleInferenceIdentity(value, `https://api.openai.com${path}`, { kind: 'api_key', value: 'explicit-owner-api-key' });
    const route = { providerId: 'openai', providerAccountId: 'reviewed-account', credentialKind: 'byo', credentialGeneration: generation,
      credentialFingerprint: identity.credential.fingerprint, endpoint: identity.endpoint, model: identity.modelId, harnessId: `scope-runtime:${api}`, harnessRevision: identity.harnessVersion,
      recipientChain: [{ recipientId: 'openai', accountId: 'reviewed-account', endpoint: identity.endpoint }] } as const;
    expect(matchesGoogleObservedRoute(route as never, identity)).toBe(true);
    expect(matchesGoogleObservedRoute({ ...route, credentialGeneration: 'a6cf6d9a-2198-4167-ac86-b0bdc7fe87fe' } as never, identity)).toBe(false);
    expect(matchesGoogleObservedRoute({ ...route, endpoint: 'https://api.openai.com/v1/other' } as never, identity)).toBe(false);
  });
});
it('rejects an explicit OpenAI selection if an authority returns another source, API or generation', async () => {
  const { resolveManagedPiSelection } = await import('../../../packages/gateway/src/chat/managed-pi-route.js');
  const base = binding('openai-responses'); const selection = { instanceId: 'matrix_pi_openai_api', model: 'gpt-4.1', options: [
    { id: 'connectionRevision', value: '3' }, { id: 'credentialGeneration', value: generation }, { id: 'api', value: 'openai-responses' }] };
  const providers = { getSnapshot: vi.fn(async () => { throw new Error('No fallback'); }) };
  for (const changed of [{ accessSourceId: 'matrix_included', openaiApi: undefined }, { route: { ...base.route, api: 'openai-completions' } },
    { openaiApi: { connectionRevision: 4, credentialGeneration: generation } }, { accessSourceId: 'owner_openai_profile' }]) {
    const matrixOpenAi = { resolve: vi.fn(async () => ({ ...base, ...changed })) };
    await expect(resolveManagedPiSelection(selection, 'owner', { providers, matrixOpenAi } as never)).rejects.toThrow();
  }
  expect(providers.getSnapshot).not.toHaveBeenCalled();
});
