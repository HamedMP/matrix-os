import { describe, expect, it, vi } from 'vitest';
import { forwardBotInference } from '../../../packages/gateway/src/bots/broker-inference.js';
import { BotRuntimeRegistry } from '../../../packages/gateway/src/bots/runtime-registry.js';
import type { ChatGptPlanAuthority } from '../../../packages/gateway/src/bots/chatgpt-plan.js';
const route = { api: 'openai-responses', modelId: 'gpt-account-model', input: ['text'], contextWindow: 128000, maxOutputTokens: 8192 } as const;
const subscription = { peerId: '018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d2', accountId: 'account_own', computerId: 'computer-own', grantRevision: 4 };
const binding = { runtimeHandle: `runtime_${'a'.repeat(32)}`, executionGeneration: '1', ownerId: 'owner', botId: 'bot_12345678', chatId: 'chat-own', taskId: 'task-own', runId: 'run_own', rootFingerprint: 'a'.repeat(64), route, accessSourceId: 'matrix_chatgpt_plan', subscription, capabilities: [], requestClass: 'interactive' } as const;
const body = { model: route.modelId, stream: true, store: false, input: [{ role: 'system', content: 'Be helpful' }, { role: 'user', content: 'Read file' }], tools: [{ type: 'function', name: 'artifact_read', description: 'Read', parameters: { type: 'object', properties: {} }, strict: false }], max_output_tokens: 8192, temperature: 0.2 };
const frame = (payload: unknown = body) => ({ version: 1, action: 'inference.responses', requestId: '018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1', runtimeHandle: binding.runtimeHandle, executionGeneration: '1', path: '/v1/responses', headers: {}, body: JSON.stringify(payload) }) as const;
const event = (type: string, extra = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`;
const completed = event('response.completed', { response: { status: 'completed', model: route.modelId } });
function fixture(response = completed) {
    const registry = new BotRuntimeRegistry();
    registry.bind(binding);
    const authority: ChatGptPlanAuthority = { resolve: vi.fn(), observe: vi.fn(), revalidate: vi.fn(async () => true), infer: vi.fn(async (_binding, _body, _signal) => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: response })) };
    const fetchImpl = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(response, { headers: { 'content-type': 'text/event-stream' } }));
    const resolveCredentials = vi.fn();
    const fundedAdmission = { execute: vi.fn() };
    const deps = { homePath: '/owner', lifetime: new AbortController().signal, chatgptPlan: authority, fetchImpl, resolveCredentials, fundedAdmission };
    const send = (payload?: unknown) => forwardBotInference(frame(payload), binding, modelId => registry.authorize({ ...binding, action: 'inference.responses', modelId }), deps as never);
    return { authority, registry, fetchImpl, resolveCredentials, fundedAdmission, send };
}
describe('own-registration ChatGPT plan Pi broker', () => {
    it('adapts actual Responses requirements and never enters monetary/native credential paths', async () => {
        const f = fixture();
        expect(await f.send()).toMatchObject({ ok: true });
        const call = vi.mocked(f.authority.infer).mock.calls[0]!;
        const wire = JSON.parse(call[1]);
        expect(call[2]).toBeInstanceOf(AbortSignal);
        expect(f.fetchImpl).not.toHaveBeenCalled();
        expect(wire).toMatchObject({ store: false, stream: true, input: [{ type: 'additional_tools', role: 'developer', tools: body.tools }, { role: 'developer', content: 'Be helpful' }, { role: 'user', content: 'Read file' }] });
        expect(wire).not.toHaveProperty('max_output_tokens');
        expect(wire).not.toHaveProperty('temperature');
        expect(wire).not.toHaveProperty('tools');
        expect(f.resolveCredentials).not.toHaveBeenCalled();
        expect(f.fundedAdmission.execute).not.toHaveBeenCalled();
    });
    it.each([event('response.output_text.delta', { delta: 'partial' }), event('response.failed'), completed + event('error')])('never treats partial/error SSE as success', async (response) => {
        expect(await fixture(response).send()).toMatchObject({ ok: false, error: 'provider_unavailable' });
    });
    it('fences a revoked account after credential refresh before any dispatch', async () => {
        const f = fixture();
        vi.mocked(f.authority.revalidate).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        expect(await f.send()).toMatchObject({ ok: false, error: 'action_denied' });
        expect(f.fetchImpl).not.toHaveBeenCalled();
    });
    it('Stop during credential resolution refuses dispatch', async () => {
        const f = fixture();
        vi.mocked(f.authority.revalidate).mockImplementation(async () => { f.registry.release(binding.runtimeHandle); return false; });
        expect(await f.send()).toMatchObject({ ok: false, error: 'action_denied' });
        expect(f.fetchImpl).not.toHaveBeenCalled();
    });
    it.each([{ ...body, model: 'foreign-model' }, { ...body, input: [{ type: 'tool_search_call' }] }, { ...body, tools: [{ type: 'mcp', server_url: 'https://unsafe.invalid' }] }])('refuses worker-widened model or hosted tools', async (payload) => {
        const f = fixture();
        expect((await f.send(payload)).ok).toBe(false);
        expect(f.fetchImpl).not.toHaveBeenCalled();
    });
    it('preserves full tool history and unmodified tool names/results on continuation', async () => {
        const f = fixture();
        const history = [{ type: 'function_call', call_id: 'call_1', name: 'artifact_read', arguments: '{}' }, { type: 'function_call_output', call_id: 'call_1', output: 'real-result' }];
        expect((await f.send({ ...body, input: [...body.input, ...history] })).ok).toBe(true);
        expect(JSON.parse(vi.mocked(f.authority.infer).mock.calls[0]![1]).input.slice(-2)).toEqual(history);
    });
});
