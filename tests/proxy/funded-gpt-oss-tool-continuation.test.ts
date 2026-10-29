import { describe, expect, it } from 'vitest';
import { serializeFundedOpenAiRequest } from '../../packages/proxy/src/funded-relay-openai-request.js';
import { FUNDED_GLM_FLASH } from '../../packages/proxy/src/funded-relay-model.js';
import { convertMessages } from '@earendil-works/pi-ai/api/openai-completions';

describe('GPT-OSS tool continuation compatibility', () => {
  it('normalizes the actual pinned SDK tool-result transcript without executing an inference', () => {
    const model = { id: '@cf/openai/gpt-oss-20b', name: 'Synthetic', provider: 'matrix-broker', api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:1/v1', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as Parameters<typeof convertMessages>[0];
    const context = { messages: [{ role: 'user', content: 'Use synthetic inventory', timestamp: 1 },
      { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        content: [{ type: 'toolCall', id: 'call_inventory', name: 'inventory', arguments: {} }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'toolUse', timestamp: 2 },
      { role: 'toolResult', toolCallId: 'call_inventory', toolName: 'inventory', content: [{ type: 'text', text: '{"available":true}' }], isError: false, timestamp: 3 },
    ] } as Parameters<typeof convertMessages>[1];
    const messages = convertMessages(model, context, {} as Parameters<typeof convertMessages>[2], {});
    expect(messages[1]).toMatchObject({ role: 'assistant', content: null });
    const result = JSON.parse(serializeFundedOpenAiRequest({ model: model.id, messages }).body);
    expect(result.messages[1]).toMatchObject({ role: 'assistant', content: '', tool_calls: [{ id: 'call_inventory' }] });
    expect(result.messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'call_inventory', content: '{"available":true}' });
  });
  it.each([null, undefined])('renders tool-only assistant content %s as an empty string without changing tool identity', content => {
    const messages = [{ role: 'user', content: 'Use the synthetic inventory' },
      { role: 'assistant', ...(content === undefined ? {} : { content }), tool_calls: [{ id: 'call_inventory',
        type: 'function', function: { name: 'inventory', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_inventory', content: '{"available":true}' }];
    const original = structuredClone(messages);
    const output = serializeFundedOpenAiRequest({ model: '@cf/openai/gpt-oss-20b', messages, max_tokens: 32 });
    expect(JSON.parse(output.body).messages).toEqual([messages[0], { ...messages[1], content: '' }, messages[2]]);
    expect(messages).toEqual(original);
  });
  it('preserves deliberate assistant text and does not rewrite other models', () => {
    const messages = [{ role: 'assistant', content: 'Checking the tool.', tool_calls: [{ id: 'call_one',
      type: 'function', function: { name: 'inventory', arguments: '{}' } }] }];
    expect(JSON.parse(serializeFundedOpenAiRequest({ model: '@cf/openai/gpt-oss-20b', messages }).body).messages).toEqual(messages);
    const toolOnly = [{ ...messages[0], content: null }];
    expect(JSON.parse(serializeFundedOpenAiRequest({ model: FUNDED_GLM_FLASH, messages: toolOnly }).body).messages).toEqual(toolOnly);
  });
});
