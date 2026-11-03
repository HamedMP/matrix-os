import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestPlanResponse } from '../../../desktop/src/main/chatgpt-plan/responses.js';
import { forwardChatGptPlanInference } from '../../../packages/gateway/src/bots/chatgpt-plan-inference.js';
import type { ChatGptPlanAuthority } from '../../../packages/gateway/src/bots/chatgpt-plan.js';
import type { PiRuntimeBinding } from '../../../packages/gateway/src/bots/runtime-registry.js';
import { ScopeRuntimeBotInferenceRequestSchema } from '../../../packages/scope-runtime/src/broker-protocol.js';

const RAW_RESPONSE_LIMIT = 1_048_576;
const model = 'gpt-account-model';
const requestBody = JSON.stringify({ model, store: false, stream: true, input: [{ role: 'user', content: 'Offline fixture only' }] });
const binding = {
  runtimeHandle: `runtime_${'a'.repeat(32)}`, executionGeneration: '1', ownerId: 'owner_fixture',
  botId: 'bot_12345678', chatId: 'chat_fixture', taskId: 'task_fixture', runId: 'run_fixture',
  rootFingerprint: 'a'.repeat(64),
  route: { api: 'openai-responses', modelId: model, input: ['text'], contextWindow: 128000, maxOutputTokens: 8192 },
  accessSourceId: 'matrix_chatgpt_plan', capabilities: [], requestClass: 'interactive',
  subscription: { peerId: '018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d2', accountId: 'account_fixture', computerId: 'computer_fixture', grantRevision: 4 },
} satisfies PiRuntimeBinding;
const request = ScopeRuntimeBotInferenceRequestSchema.parse({
  version: 1, action: 'inference.responses', requestId: '018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1',
  runtimeHandle: binding.runtimeHandle, executionGeneration: '1', method: 'POST',
  path: '/v1/responses', headers: {}, body: requestBody,
});

// This complete fixture reproduced the 512KiB/1MiB disagreement offline. Text
// repeats in the delta and terminal snapshots; the limit counts the whole SSE.
function reproducedResponse(): string {
  const text = 'x'.repeat(110000);
  const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
  let sequence = 0;
  const event = (type: string, fields: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...fields })}\n\n`;
  const response = { id: 'resp_fixture', object: 'response', created_at: 0, status: 'completed', error: null,
    incomplete_details: null, model, output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  return event('response.created', { response: { ...response, status: 'in_progress', output: [], usage: null } })
    + event('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } })
    + event('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
    + event('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: text })
    + event('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text })
    + event('response.content_part.done', { item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] })
    + event('response.output_item.done', { output_index: 0, item })
    + event('response.completed', { response });
}

function responseAtBytes(bytes: number): string {
  const response = reproducedResponse();
  // SSE comments are legal and do not change the completed response semantics.
  return `: ${'x'.repeat(bytes - Buffer.byteLength(response) - 4)}\n\n${response}`;
}

function desktopResponse(text: string) {
  const fetchFn = vi.fn<typeof fetch>(async () => new Response(text, { headers: { 'content-type': 'text/event-stream' } }));
  return { fetchFn, result: requestPlanResponse({
    fetchFn, body: requestBody, model, signal: new AbortController().signal,
    accessToken: async () => 'offline-fixture-token', validate() {},
  }) };
}

function forwardResponse(text: string) {
  const authority: ChatGptPlanAuthority = {
    resolve: vi.fn(), observe: vi.fn(), revalidate: vi.fn(async () => true),
    infer: vi.fn(async () => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: text })),
  };
  return { authority, result: forwardChatGptPlanInference(request, binding, {
    authority, signal: new AbortController().signal, stillAuthorized: () => true,
  }) };
}

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected external fetch'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe('ChatGPT plan response capacity across native and broker boundaries', () => {
  it('forwards the reproduced 551958-byte complete SSE accepted by Electron without discarding it', async () => {
    const original = reproducedResponse();
    expect(Buffer.byteLength(original)).toBe(551958);
    const desktop = desktopResponse(original);
    const accepted = await desktop.result;
    expect(accepted).toBe(original);
    const gateway = forwardResponse(accepted);
    const forwarded = await gateway.result;
    expect(forwarded).toMatchObject({ ok: true, status: 200 });
    if (forwarded.ok) expect(forwarded.body).toBe(original);
    expect(desktop.fetchFn).toHaveBeenCalledOnce();
    expect(gateway.authority.infer).toHaveBeenCalledOnce();
  });

  it('preserves a complete response of exactly 1MiB through both boundaries', async () => {
    const original = responseAtBytes(RAW_RESPONSE_LIMIT);
    expect(Buffer.byteLength(original)).toBe(1_048_576);
    const desktop = desktopResponse(original);
    const accepted = await desktop.result;
    expect(accepted).toBe(original);
    const forwarded = await forwardResponse(accepted).result;
    expect(forwarded.ok).toBe(true);
    if (forwarded.ok) expect(forwarded.body).toBe(original);
    expect(desktop.fetchFn).toHaveBeenCalledOnce();
  });

  it('rejects a response one byte above 1MiB even when the native boundary is bypassed', async () => {
    const original = responseAtBytes(RAW_RESPONSE_LIMIT + 1);
    expect(Buffer.byteLength(original)).toBe(1_048_577);
    const desktop = desktopResponse(original);
    await expect(desktop.result).rejects.toMatchObject({ category: 'response_too_large' });
    await expect(forwardResponse(original).result).resolves.toMatchObject({ ok: false, error: 'response_too_large' });
    expect(desktop.fetchFn).toHaveBeenCalledOnce();
  });

  it('still refuses a completed event after an error instead of passing partial output', async () => {
    const original = 'event: error\ndata: {"type":"error"}\n\n' + reproducedResponse();
    const desktop = desktopResponse(original);
    await expect(desktop.result).rejects.toMatchObject({ category: 'incomplete_stream' });
    await expect(forwardResponse(original).result).resolves.toMatchObject({ ok: false, error: 'provider_unavailable' });
    expect(desktop.fetchFn).toHaveBeenCalledOnce();
  });
});
