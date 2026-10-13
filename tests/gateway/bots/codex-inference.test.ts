import { describe, expect, it, vi } from 'vitest';
import { forwardBotInference } from '../../../packages/gateway/src/bots/broker-inference.js';
import type { BotRuntimeBinding } from '../../../packages/gateway/src/bots/runtime-registry.js';
const request = { version: 1, action: 'inference.messages', requestId: '018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1', runtimeHandle: `runtime_${'e'.repeat(32)}`, executionGeneration: '6', path: '/v1/messages', headers: {}, body: JSON.stringify({ model: 'gpt-observed', stream: true, input: [] }) } as const;
describe('Bot coordinator credential admission', () => {
  it.each(['owner_openai_profile', 'owner_anthropic_profile'] as const)('refuses legacy subscription credential %s before identity resolution or network work', async accessSourceId => {
    const resolveCodexIdentity = vi.fn(); const resolveCredentials = vi.fn(async () => ({ env: { ANTHROPIC_AUTH_TOKEN: 'subscription-token' } })); const fetchImpl = vi.fn(async () => new Response('data: {}\n\n'));
    const current = accessSourceId === 'owner_openai_profile' ? { ...request, action: 'inference.responses', path: '/v1/responses' } : request;
    const result = await forwardBotInference(current as never, { accessSourceId, requestClass: 'interactive' } as never, () => ({ allowed: true, accessSourceId, allowedModelIds: ['gpt-observed'], allowedEgressOrigins: [] }),
      { homePath: '/owner', lifetime: new AbortController().signal, resolveCodexIdentity, resolveCredentials, fetchImpl } as never);
    expect(result).toMatchObject({ ok: false, error: 'provider_unavailable' }); expect(resolveCodexIdentity).not.toHaveBeenCalled(); expect(resolveCredentials.mock.calls.length).toBe(0); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('preserves genuine owner API-key coordinator requests', async () => {
    const binding: BotRuntimeBinding = {
      runtimeHandle: request.runtimeHandle, executionGeneration: request.executionGeneration,
      ownerId: 'guard_owner', botId: 'bot_guard', chatId: 'chat_guard',
      taskId: 'task_guard', runId: 'run_guard', rootFingerprint: 'f'.repeat(64),
      accessSourceId: 'owner_anthropic_key', capabilities: [], requestClass: 'interactive',
      route: { api: 'anthropic-messages', modelId: 'gpt-observed', input: ['text'],
        contextWindow: 200_000, maxOutputTokens: 8_192 },
    };
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('data: {}\n\n', { headers: { 'content-type': 'text/event-stream' } }));
    const resolveCredentials = vi.fn(async () => ({ env: { ANTHROPIC_API_KEY: 'owner-key' } }));
    const result = await forwardBotInference(request as never, binding, () => ({ allowed: true, accessSourceId: 'owner_anthropic_key', allowedModelIds: ['gpt-observed'], allowedEgressOrigins: [] }), { homePath: '/owner', lifetime: new AbortController().signal, resolveCredentials, fetchImpl } as never);
    expect(result.ok).toBe(true); expect(fetchImpl).toHaveBeenCalledOnce();
    const forwarded = fetchImpl.mock.calls[0]![1]!;
    expect(new Headers(forwarded.headers).get('x-api-key')).toBe('owner-key');
    expect(JSON.parse(String(forwarded.body)).max_tokens).toBe(8_192);
  });
});
