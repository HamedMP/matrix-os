import { convertResponsesMessages } from '@earendil-works/pi-ai/api/openai-responses-shared';
import { describe, expect, it, vi } from 'vitest';
import { forwardBotInference } from '../../packages/gateway/src/bots/broker-inference.js';
import { prepareGoogleInferenceBody } from '../../packages/gateway/src/google-data/runtime/inference-policy.js';
import type { ManagedPiRuntimeBinding } from '../../packages/gateway/src/bots/runtime-registry.js';
const generation = 'e16625fe-cad7-4983-a9db-e808bbf104cc';
const model = { id: 'gpt-4.1', name: 'GPT', api: 'openai-responses', provider: 'openai', input: ['text'], reasoning: false,
  contextWindow: 128000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as const;
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function history() {
  return convertResponsesMessages(model as never, { messages: [
    { role: 'user', content: 'Summarize the synthetic fixture.', timestamp: 1 },
    { role: 'assistant', api: model.api, provider: model.provider, model: model.id, usage, stopReason: 'toolUse', timestamp: 2,
      content: [{ type: 'text', text: 'I will inspect the fixture.', textSignature: JSON.stringify({ v: 1, id: 'msg_fixture', phase: 'commentary' }) },
        { type: 'toolCall', id: 'call_fixture|fc_fixture', name: 'read_fixture', arguments: { id: 'synthetic' } }] },
    { role: 'toolResult', toolCallId: 'call_fixture|fc_fixture', toolName: 'read_fixture', content: [{ type: 'text', text: 'Synthetic fixture result' }], isError: false, timestamp: 3 },
    { role: 'user', content: 'Now summarize it.', timestamp: 4 },
  ] } as never, new Set(['openai']));
}
describe('governed Responses with the pinned Pi SDK converter', () => {
  it('forwards actual multi-turn inline assistant and function-call history through the governed broker', async () => {
    const input = history();
    expect(input).toContainEqual(expect.objectContaining({ type: 'message', role: 'assistant', id: 'msg_fixture', status: 'completed', phase: 'commentary', content: [expect.objectContaining({ annotations: [] })] }));
    expect(input).toContainEqual(expect.objectContaining({ type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture' }));
    const binding: ManagedPiRuntimeBinding = { kind: 'managed_chat', ownerId: 'owner', chatId: 'chat_history', runId: 'run_history', runtimeHandle: `runtime_${'a'.repeat(32)}`,
      executionGeneration: '1', rootFingerprint: 'b'.repeat(64), workspace: { kind: 'chat_workspace' }, requestClass: 'interactive', capabilities: ['artifact.read'],
      accessSourceId: 'owner_openai_key', openaiApi: { connectionRevision: 3, credentialGeneration: generation },
      route: { api: 'openai-responses', modelId: model.id, input: ['text'], contextWindow: 128000, maxOutputTokens: 8192 } };
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('data: {}\n\n', { headers: { 'content-type': 'text/event-stream' } }));
    const result = await forwardBotInference({ version: 1, requestId: generation, runtimeHandle: binding.runtimeHandle, executionGeneration: '1',
      action: 'inference.responses', method: 'POST', path: '/v1/responses', headers: {}, body: JSON.stringify({ model: model.id, stream: true, input }) }, binding,
      () => ({ allowed: true, accessSourceId: binding.accessSourceId, allowedModelIds: [model.id], allowedEgressOrigins: [] }),
      { homePath: '/unused', lifetime: new AbortController().signal, fetchImpl,
        matrixOpenAi: { credential: async () => 'synthetic-api-key', revalidate: async () => true },
        googleData: { authorize: async () => ({ allowed: true, googleOrigin: true }) } } as never);
    expect(result).toMatchObject({ ok: true }); expect(fetchImpl).toHaveBeenCalledOnce();
    const wire = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(wire.store).toBe(false);
    expect(wire.input).toContainEqual({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I will inspect the fixture.' }] });
    expect(wire.input).toContainEqual({ type: 'function_call', call_id: 'call_fixture', name: 'read_fixture', arguments: '{"id":"synthetic"}' });
    expect(JSON.stringify(wire)).not.toMatch(/msg_fixture|fc_fixture|annotations|commentary/);
  });
  it.each([
    { type: 'item_reference', id: 'msg_remote' }, { type: 'reasoning', id: 'rs_remote', encrypted_content: 'opaque' },
    { type: 'custom_tool_call', call_id: 'call_1', name: 'remote', input: 'x' },
    { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', arguments: '{}', namespace: 'remote' },
    { role: 'assistant', type: 'message', id: 'msg_1', status: 'completed', content: [{ type: 'output_text', text: 'x', annotations: [{ type: 'url_citation', url: 'https://remote.invalid' }] }] },
  ])('keeps unsupported remote/persistent/opaque history denied: %j', item => {
    expect(() => prepareGoogleInferenceBody('openai-responses', JSON.stringify({ model: model.id, stream: true, input: [item] }))).toThrow();
  });
});
