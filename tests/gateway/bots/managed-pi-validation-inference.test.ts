import { describe, expect, it, vi } from 'vitest';
import { BotRuntimeRegistry, type ManagedPiRuntimeBinding } from '../../../packages/gateway/src/bots/runtime-registry.js';
import { forwardBotInference } from '../../../packages/gateway/src/bots/broker-inference.js';
import type { ScopeRuntimeBotInferenceRequest } from '@matrix-os/scope-runtime/broker-protocol';
import { createFundedAdmissionQueue } from '../../../packages/gateway/src/funded-ai/admission-queue.js';
const now = Date.parse('2026-10-09T12:00:00.000Z');
const profile = { version: 1, maxOutputTokens: 256, maxInferenceRequests: 1, maxRequestBytes: 131072, validThrough: '2026-10-09T12:10:00.000Z' } as const;
function setup(api: 'anthropic-messages' | 'openai-completions' = 'anthropic-messages', enabled = true) {
  let clock = now;
  const registry = new BotRuntimeRegistry({ now: () => clock });
  const model = api === 'anthropic-messages' ? 'claude-sonnet-5' : '@cf/zai-org/glm-5.3-flash';
  const binding: ManagedPiRuntimeBinding = { runtimeHandle: `runtime_${'a'.repeat(32)}`, executionGeneration: '1', kind: 'managed_chat', ownerId: 'owner', chatId: 'chat_test', runId: 'run_test', workspace: { kind: 'chat_workspace' }, rootFingerprint: 'f'.repeat(64), route: { api, modelId: model, input: ['text'], contextWindow: 128000, maxOutputTokens: 8192 }, accessSourceId: 'matrix_included', capabilities: ['artifact.read'], requestClass: 'interactive', ...(enabled ? { validationLimits: profile } : {}) };
  registry.bind(binding);
  const request: ScopeRuntimeBotInferenceRequest = { version: 1, requestId: '018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1', runtimeHandle: binding.runtimeHandle, executionGeneration: '1', action: api === 'anthropic-messages' ? 'inference.messages' : 'inference.chat_completions', method: 'POST', path: api === 'anthropic-messages' ? '/v1/messages?beta=true' : '/v1/chat/completions', headers: {}, body: JSON.stringify({ model, stream: true, max_tokens: 8192, messages: [{ role: 'user', content: 'hi' }] }) };
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }));
  const resolveCredentials = vi.fn(async () => ({ env: { ANTHROPIC_AUTH_TOKEN: 'test-only', ANTHROPIC_BASE_URL: 'https://relay.example.invalid' } }));
  const deps = { homePath: '/tmp', lifetime: new AbortController().signal, runSignal: registry.inferenceSignal(binding)!, fetchImpl, resolveCredentials, consumeValidationSend: () => registry.consumeValidationSend(binding) };
  const execute = (candidate = request) => forwardBotInference(candidate, registry.lookupRun(binding)!, () => ({ allowed: true, accessSourceId: binding.accessSourceId, allowedModelIds: [model], allowedEgressOrigins: [] }), deps);
  return { registry, binding, request, deps, fetchImpl, resolveCredentials, execute, advance: () => { clock = Date.parse(profile.validThrough); } };
}
describe('registry-owned finite ordinary managed Pi send', () => {
  it.each(['anthropic-messages', 'openai-completions'] as const)('clamps the actual %s Relay request and denies later continuation/summary frames', async api => {
    const f = setup(api); expect(await f.execute()).toMatchObject({ ok: true }); expect(JSON.parse(f.fetchImpl.mock.calls[0]![1]!.body as string).max_tokens).toBe(256);
    expect(await f.execute()).toMatchObject({ ok: false, error: 'action_denied' }); expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('expiry denies new sends without cancelling an already sent response', async () => {
    const f = setup();
    let started!: () => void; let complete!: (response: Response) => void;
    const sending = new Promise<void>(resolve => { started = resolve; });
    f.fetchImpl.mockImplementationOnce(async () => { started(); return new Promise<Response>(resolve => { complete = resolve; }); });
    const first = f.execute(); await sending; f.advance();
    expect(f.deps.runSignal.aborted).toBe(false);
    complete(new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }));
    expect(await first).toMatchObject({ ok: true });
    expect(await f.execute()).toMatchObject({ ok: false, error: 'action_denied' });
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('does not refund an unknown outcome', async () => { const f = setup(); f.fetchImpl.mockRejectedValueOnce(new TypeError('unknown')); expect(await f.execute()).toMatchObject({ ok: false }); expect(await f.execute()).toMatchObject({ ok: false, error: 'action_denied' }); expect(f.fetchImpl).toHaveBeenCalledTimes(1); });
  it('reserves the slot synchronously against simultaneous frames', async () => { const f = setup(); const results = await Promise.all([f.execute(), f.execute()]); expect(results.filter(r => r.ok)).toHaveLength(1); expect(f.fetchImpl).toHaveBeenCalledTimes(1); });
  it('spends capacity refusal sends without allowing a second transport retry', async () => { const f = setup(); const fundedAdmission = createFundedAdmissionQueue(); f.fetchImpl.mockResolvedValueOnce(new Response('busy', { status: 429, headers: { 'x-matrix-funded-reason': 'capacity_busy' } })); try { expect(await forwardBotInference(f.request, f.binding, () => ({ allowed: true, accessSourceId: 'matrix_included', allowedModelIds: [f.binding.route.modelId], allowedEgressOrigins: [] }), { ...f.deps, fundedAdmission })).toMatchObject({ ok: false, error: 'action_denied' }); expect(f.fetchImpl).toHaveBeenCalledTimes(1); } finally { fundedAdmission.close(); } });
  it('fails closed if the profile binding lacks the private registry spend seam', async () => { const f = setup(); const { consumeValidationSend: _consume, ...deps } = f.deps; void _consume; expect(await forwardBotInference(f.request, f.binding, () => ({ allowed: true, accessSourceId: 'matrix_included', allowedModelIds: [f.binding.route.modelId], allowedEgressOrigins: [] }), deps)).toMatchObject({ ok: false, error: 'action_denied' }); expect(f.fetchImpl).not.toHaveBeenCalled(); });
  it('expiry/release/wrong identity deny transport; registry snapshot cannot be widened', () => { const f = setup(); expect(f.registry.consumeValidationSend({ ...f.binding, ownerId: 'other' })).toBe(false); const looked = f.registry.lookupRun(f.binding)! as ManagedPiRuntimeBinding; if (looked.validationLimits) expect(() => { (looked.validationLimits as unknown as {maxInferenceRequests: number}).maxInferenceRequests = 2; }).toThrow(); f.advance(); expect(f.registry.consumeValidationSend(f.binding)).toBe(false); f.registry.release(f.binding.runtimeHandle); expect(f.registry.size).toBe(0); });
  it('preserves exact normal payload and unlimited existing send behavior when absent', async () => { const f = setup('anthropic-messages', false); expect(await f.execute()).toMatchObject({ ok: true }); expect(await f.execute()).toMatchObject({ ok: true }); expect(f.fetchImpl.mock.calls[0]![1]!.body).toBe(f.request.body); expect(f.fetchImpl).toHaveBeenCalledTimes(2); });
  it('invalid/image/oversized inputs fail before credentials or slot spending', async () => { const f = setup(); const bad = { ...f.request, body: JSON.stringify({ model: f.binding.route.modelId, stream: true, max_tokens: 256, messages: [{ content: [{ type: 'image' }] }] }) }; expect(await f.execute(bad)).toMatchObject({ ok: false, error: 'invalid_request' }); expect(f.resolveCredentials).not.toHaveBeenCalled(); expect(f.fetchImpl).not.toHaveBeenCalled(); expect(await f.execute()).toMatchObject({ ok: true }); });
});

it('wires the spend guard from actual broker actions and ignores caller-supplied guard overrides', async () => {
  const { createBotBrokerActions } = await import('../../../packages/gateway/src/bots/broker-actions.js');
  const f = setup();
  const actions = createBotBrokerActions({ db: {} as never, registry: f.registry, sessions: {} as never, checkpoints: {} as never, runs: {} as never, events: {} as never, tools: {} as never, inference: { ...f.deps, consumeValidationSend: () => true } });
  expect(await actions.handleFrame(f.request)).toMatchObject({ ok: true });
  expect(await actions.handleFrame(f.request)).toMatchObject({ ok: false, error: 'action_denied' });
  expect(f.fetchImpl).toHaveBeenCalledTimes(1);
});

it('a new admitted run gets a new bound while lookup never exposes the spent counter', async () => {
  const f = setup(); expect(await f.execute()).toMatchObject({ ok: true });
  expect(f.registry.lookupRun(f.binding)).not.toHaveProperty('validationSends');
  f.registry.release(f.binding.runtimeHandle);
  const next = { ...f.binding, runId: 'run_next', runtimeHandle: `runtime_${'b'.repeat(32)}` };
  f.registry.bind(next);
  expect(f.registry.consumeValidationSend(next)).toBe(true); expect(f.registry.consumeValidationSend(next)).toBe(false);
  f.registry.shutdown(); expect(f.registry.size).toBe(0);
});
