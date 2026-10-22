import { describe, expect, it } from 'vitest';
import { normalizeContext } from '@earendil-works/pi-ai';
import { createBridgeModel, BROKER_PLACEHOLDER_KEY } from '../../packages/bot-runtime/src/providers.js';
import { googleInferenceHeadersAllowed, prepareGoogleInferenceBody } from '../../packages/gateway/src/google-data/runtime/inference-policy.js';

describe('pinned Pi Google-data wire compatibility', () => {
  it('disables SDK prompt cache directives without changing synthetic tool argument data', async () => {
    const { provider, model } = createBridgeModel({ api: 'anthropic-messages', modelId: 'model-a', input: ['text'], contextWindow: 128000, maxOutputTokens: 1024 }, 'http://127.0.0.1:41000');
    let body = '';
    let actualPath = '';
    let configHeaders: Record<string, string> = {};
    await provider.streamSimple(model, normalizeContext({ systemPrompt: 'Synthetic system', messages: [
      { role: 'user', content: 'Synthetic Google context', timestamp: 1 },
    ], tools: [{ name: 'synthetic_tool', description: 'Synthetic tool', parameters: { type: 'object', properties: { cache_control: { type: 'string' } } } } as never] }), {
      apiKey: BROKER_PLACEHOLDER_KEY, cacheRetention: 'short', maxRetries: 0, maxTokens: 256,
      signal: AbortSignal.timeout(1000), fetch: async (input, init) => {
        const request = new Request(input, init); body = await request.text();
        configHeaders = Object.fromEntries([...request.headers].filter(([name]) => ['anthropic-version', 'anthropic-beta'].includes(name)));
        const target = new URL(request.url); actualPath = target.pathname + target.search;
        return Response.json({ error: { type: 'unavailable', message: 'Synthetic intercepted response' } }, { status: 503 });
      },
    }).result();
    expect(actualPath).toBe('/v1/messages?beta=true');
    expect(googleInferenceHeadersAllowed(configHeaders)).toBe(true);
    expect(body).toContain('"type":"ephemeral"');
    const outgoing = JSON.parse(prepareGoogleInferenceBody('anthropic-messages', body));
    expect(outgoing.system[0]).not.toHaveProperty('cache_control');
    expect(outgoing.messages[0].content[0]).not.toHaveProperty('cache_control');
    expect(outgoing.tools[0]).not.toHaveProperty('cache_control');
    expect(outgoing.tools[0].input_schema.properties.cache_control).toEqual({ type: 'string' });
  });
});
