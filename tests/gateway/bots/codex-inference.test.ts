import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScopeRuntimeBotInferenceRequest } from '@matrix-os/scope-runtime/broker-protocol';
import { forwardBotInference } from '../../../packages/gateway/src/bots/broker-inference.js';
import { createBotBrokerActions } from '../../../packages/gateway/src/bots/broker-actions.js';
import { BotRuntimeRegistry, type BotRuntimeBinding } from '../../../packages/gateway/src/bots/runtime-registry.js';
const request = { version: 1, action: 'inference.messages', requestId: '018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1', runtimeHandle: `runtime_${'e'.repeat(32)}`, executionGeneration: '6', path: '/v1/messages', headers: {}, body: JSON.stringify({ model: 'gpt-observed', stream: true, input: [] }) } as const;
describe('Bot coordinator credential admission', () => {
  it.each(['owner_openai_profile', 'owner_anthropic_profile'] as const)('refuses legacy subscription credential %s before identity resolution or network work', async accessSourceId => {
    const resolveCodexIdentity = vi.fn(); const resolveCredentials = vi.fn(async () => ({ env: { ANTHROPIC_AUTH_TOKEN: 'subscription-token' } })); const fetchImpl = vi.fn(async () => new Response('data: {}\n\n'));
    const current = accessSourceId === 'owner_openai_profile' ? { ...request, action: 'inference.responses', path: '/v1/responses' } : request;
    const result = await forwardBotInference(current as never, { accessSourceId, requestClass: 'interactive' } as never, () => ({ allowed: true, accessSourceId, allowedModelIds: ['gpt-observed'], allowedEgressOrigins: [] }),
      { homePath: '/owner', lifetime: new AbortController().signal, resolveCodexIdentity, resolveCredentials, fetchImpl } as never);
    expect(result).toMatchObject({ ok: false, error: 'provider_unavailable' }); expect(resolveCodexIdentity).not.toHaveBeenCalled(); expect(resolveCredentials.mock.calls.length).toBe(0); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('preserves registered owner API-key inference without loading a run spec', async () => {
    const binding: BotRuntimeBinding = {
      runtimeHandle: request.runtimeHandle, executionGeneration: request.executionGeneration,
      ownerId: 'guard_owner', botId: 'bot_0123456789abcdef', chatId: 'chat_guard',
      taskId: 'task_guard', runId: 'run_guard', rootFingerprint: 'f'.repeat(64),
      accessSourceId: 'owner_anthropic_key', capabilities: [], requestClass: 'interactive',
      route: { api: 'anthropic-messages', modelId: 'claude-sonnet-5', input: ['text'],
        contextWindow: 200_000, maxOutputTokens: 8_192 },
    };
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('data: {}\n\n', { headers: { 'content-type': 'text/event-stream' } }));
    const homePath = await mkdtemp(join(tmpdir(), 'bot-owner-key-'));
    const registry = new BotRuntimeRegistry();
    const loadRunSpec = vi.fn(async () => { throw new Error('Inference must not require a run spec'); });
    try {
      await mkdir(join(homePath, 'system'));
      await writeFile(join(homePath, 'system/config.json'), JSON.stringify({ kernel: { anthropicApiKey: 'owner-key' } }), { mode: 0o600 });
      expect(() => registry.bind({ ...binding, route: undefined } as never)).toThrow(/invalid_binding/);
      expect(registry.size).toBe(0);
      registry.bind(binding);
      const actions = createBotBrokerActions({
        db: {} as never, sessions: {} as never, checkpoints: {} as never,
        runs: { loadRunSpec, readImageChunk: vi.fn(async () => { throw new Error('No image read expected'); }) },
        events: {} as never, tools: {} as never, registry,
        inference: { homePath, lifetime: new AbortController().signal, fetchImpl },
      });
      const frame: ScopeRuntimeBotInferenceRequest = { ...request, method: 'POST', path: '/v1/messages?beta=true',
        body: JSON.stringify({ model: binding.route.modelId, stream: true, messages: [] }) };
      const result = await actions.handleFrame(frame);
      expect(result).toMatchObject({ ok: true, status: 200 });
      expect(loadRunSpec).not.toHaveBeenCalled();
      expect(registry.lookup(request)?.route.maxOutputTokens).toBe(8_192);
      expect(fetchImpl).toHaveBeenCalledOnce();
      const forwarded = fetchImpl.mock.calls[0]![1]!;
      expect(fetchImpl.mock.calls[0]![0]).toBe('https://api.anthropic.com/v1/messages?beta=true');
      expect(new Headers(forwarded.headers).get('x-api-key')).toBe('owner-key');
      expect(JSON.parse(String(forwarded.body)).max_tokens).toBe(8_192);
      const oversized = await actions.handleFrame({ ...frame, body: JSON.stringify({
        model: binding.route.modelId, stream: true, messages: [], max_tokens: 8_193,
      }) });
      expect(oversized).toMatchObject({ ok: false, error: 'invalid_request' });
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(loadRunSpec).not.toHaveBeenCalled();
    } finally {
      registry.shutdown();
      await rm(homePath, { recursive: true, force: true });
    }
  });
});
