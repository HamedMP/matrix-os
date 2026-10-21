import { describe, expect, it, vi } from 'vitest';
import { forwardBotInference } from '../../../packages/gateway/src/bots/broker-inference.js';
import { BotRuntimeRegistry } from '../../../packages/gateway/src/bots/runtime-registry.js';
import type { ChatGptPlanAuthority } from '../../../packages/gateway/src/bots/chatgpt-plan.js';
import { convertResponsesMessages, processResponsesStream } from '@earendil-works/pi-ai/api/openai-responses-shared';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { AssistantMessage, Model } from '@earendil-works/pi-ai';
import { ChatGptPlanWireSchema } from '../../../packages/contracts/src/chatgpt-plan-wire.js';
const route = { api: 'openai-responses', modelId: 'gpt-account-model', input: ['text'], contextWindow: 128000, maxOutputTokens: 8192 } as const;
const subscription = { peerId: '018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d2', accountId: 'account_own', computerId: 'computer-own', grantRevision: 4 };
const binding = { runtimeHandle: `runtime_${'a'.repeat(32)}`, executionGeneration: '1', ownerId: 'owner', botId: 'bot_12345678', chatId: 'chat-own', taskId: 'task-own', runId: 'run_own', rootFingerprint: 'a'.repeat(64), route, accessSourceId: 'matrix_chatgpt_plan', subscription, capabilities: [], requestClass: 'interactive' } as const;
const body = { model: route.modelId, stream: true, store: false, input: [{ role: 'system', content: 'Be helpful' }, { role: 'user', content: 'Read file' }], tools: [{ type: 'function', name: 'artifact_read', description: 'Read', parameters: { type: 'object', properties: {} }, strict: false }], max_output_tokens: 8192, temperature: 0.2 };
const frame = (payload: unknown = body) => ({ version: 1, action: 'inference.responses', requestId: '018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1', runtimeHandle: binding.runtimeHandle, executionGeneration: '1', path: '/v1/responses', headers: {}, body: JSON.stringify(payload) }) as const;
const event = (type: string, extra = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`;
const completed = event('response.completed', { response: { status: 'completed', model: route.modelId } });
const piModel: Model<'openai-responses'> = { id: route.modelId, name: 'Account model', api: 'openai-responses', provider: 'openai',
    baseUrl: 'https://api.openai.com/v1', input: ['text'], reasoning: true, contextWindow: 128000, maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
async function piToolContinuation(reasoning: Record<string, unknown>) {
    const output: AssistantMessage = { role: 'assistant', content: [], api: piModel.api, provider: piModel.provider, model: piModel.id,
        stopReason: 'stop', timestamp: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const call = { type: 'function_call', id: 'fc_write', call_id: 'call_write', name: 'write_artifact', arguments: '{"path":"note.txt"}' };
    async function* events() {
        // Provider-shaped fixtures exercise the pinned Pi parser and signature saver.
        for (const [output_index, item] of [reasoning, call].entries())
            yield { type: 'response.output_item.done', sequence_number: output_index, output_index, item };
        yield { type: 'response.completed', sequence_number: 2, response: { id: 'resp_tool', status: 'completed', model: route.modelId, output: [reasoning, call] } };
    }
    await processResponsesStream(events() as Parameters<typeof processResponsesStream>[0], output, createAssistantMessageEventStream(), piModel);
    const input = convertResponsesMessages(piModel, { messages: [
        { role: 'user', content: 'Write a note', timestamp: 0 }, output,
        { role: 'toolResult', toolCallId: 'call_write|fc_write', toolName: 'write_artifact', content: [{ type: 'text', text: 'write confirmed' }], isError: false, timestamp: 2 },
    ] }, new Set(['openai']));
    return { output, input };
}
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
    it('replays the actual pinned Pi reasoning signature and completed tool result on the same subscription', async () => {
        const reasoning = { id: 'rs_write', type: 'reasoning', content: [], encrypted_content: 'encrypted-fixture', summary: [] };
        const { output, input } = await piToolContinuation(reasoning);
        expect(output.stopReason).toBe('toolUse');
        expect(output.content.find(block => block.type === 'thinking')).toMatchObject({ thinkingSignature: JSON.stringify(reasoning) });
        const f = fixture();
        expect(await f.send({ ...body, input })).toMatchObject({ ok: true });
        expect(JSON.parse(vi.mocked(f.authority.infer).mock.calls[0]![1]).input).toEqual([
            { type: 'additional_tools', role: 'developer', tools: body.tools },
            { role: 'user', content: [{ type: 'input_text', text: 'Write a note' }] }, reasoning,
            { type: 'function_call', id: 'fc_write', call_id: 'call_write', name: 'write_artifact', arguments: '{"path":"note.txt"}' },
            { type: 'function_call_output', call_id: 'call_write', output: 'write confirmed' },
        ]);
        expect(f.authority.infer).toHaveBeenCalledTimes(1);
        expect(f.resolveCredentials).not.toHaveBeenCalled();
        expect(f.fundedAdmission.execute).not.toHaveBeenCalled();
    });
    it.each(['in_progress', 'completed', 'incomplete'])('preserves official reasoning content, %s item status and null encryption through Pi replay', async status => {
        const reasoning = { id: 'rs_write', type: 'reasoning', content: [{ type: 'reasoning_text', text: 'Fixture reasoning' }],
            encrypted_content: null, summary: [{ type: 'summary_text', text: 'Fixture summary' }], status };
        const { input } = await piToolContinuation(reasoning);
        const f = fixture();
        expect(await f.send({ ...body, input })).toMatchObject({ ok: true });
        const wire = JSON.parse(vi.mocked(f.authority.infer).mock.calls[0]![1]);
        expect(ChatGptPlanWireSchema.parse(wire).input[2]).toEqual(reasoning);
        expect(f.authority.infer).toHaveBeenCalledTimes(1);
        expect(f.resolveCredentials).not.toHaveBeenCalled();
        expect(f.fundedAdmission.execute).not.toHaveBeenCalled();
    });
    it('keeps omitted optional reasoning fields omitted on Pi continuation', async () => {
        const reasoning = { id: 'rs_write', type: 'reasoning', summary: [] };
        const { input } = await piToolContinuation(reasoning);
        const f = fixture();
        expect(await f.send({ ...body, input })).toMatchObject({ ok: true });
        expect(JSON.parse(vi.mocked(f.authority.infer).mock.calls[0]![1]).input[2]).toEqual(reasoning);
    });
    it.each([
        { status: 'queued' }, { status: null }, { encrypted_content: 42 },
        { encrypted_content: 'x'.repeat(240001) },
        { content: [{ type: 'output_text', text: 'unsupported' }] },
        { content: [{ type: 'reasoning_text', text: 42 }] },
        { content: [{ type: 'reasoning_text', text: 'x'.repeat(240001) }] },
        { content: Array.from({ length: 257 }, () => ({ type: 'reasoning_text', text: '' })) },
        { content: [{ type: 'reasoning_text', text: '', server_url: 'https://unsafe.invalid' }] },
        { server_url: 'https://unsafe.invalid' },
    ])('refuses invalid or widened reasoning fields before subscription dispatch', async extra => {
        const f = fixture();
        expect((await f.send({ ...body, input: [{ id: 'rs_write', type: 'reasoning', summary: [], ...extra }] })).ok).toBe(false);
        expect(f.authority.infer).not.toHaveBeenCalled();
        expect(f.resolveCredentials).not.toHaveBeenCalled();
        expect(f.fundedAdmission.execute).not.toHaveBeenCalled();
    });
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
