import { ScopeRuntimeBrokerResponseSchema, type ScopeRuntimeBotInferenceRequest, type ScopeRuntimeBrokerResponse } from '@matrix-os/scope-runtime/broker-protocol';
import type { PiRuntimeBinding } from './runtime-registry.js';
import type { ChatGptPlanAuthority } from './chatgpt-plan.js';
import { chatGptPlanWire, assertChatGptPlanCompleted } from './chatgpt-plan-wire.js';
const refused = (requestId: string, error: 'action_denied' | 'invalid_request' | 'provider_unavailable' | 'response_too_large'): ScopeRuntimeBrokerResponse => ScopeRuntimeBrokerResponseSchema.parse({ version: 1, requestId, ok: false, error });
export async function forwardChatGptPlanInference(request: ScopeRuntimeBotInferenceRequest, binding: PiRuntimeBinding, deps: {
    authority: ChatGptPlanAuthority;
    signal: AbortSignal;
    stillAuthorized(): boolean;
}): Promise<ScopeRuntimeBrokerResponse> {
    if (!binding.subscription || binding.accessSourceId !== 'matrix_chatgpt_plan' || request.action !== 'inference.responses'
        || request.path !== '/v1/responses')
        return refused(request.requestId, 'action_denied');
    let body: string;
    try {
        body = chatGptPlanWire(JSON.parse(request.body), binding.route.modelId);
    }
    catch (error) {
        console.warn('[bots] ChatGPT plan request rejected:', error instanceof Error ? error.name : 'UnknownError');
        return refused(request.requestId, 'invalid_request');
    }
    const signal = AbortSignal.any([deps.signal, AbortSignal.timeout(120000)]);
    const authorized = async () => !signal.aborted && deps.stillAuthorized() && await deps.authority.revalidate(binding, signal) && !signal.aborted && deps.stillAuthorized();
    try {
        if (!await authorized())
            return refused(request.requestId, 'action_denied');
        if (!await authorized())
            return refused(request.requestId, 'action_denied');
        const response = await deps.authority.infer(binding, body, signal);
        if (response.status !== 200 || response.headers['content-type'] !== 'text/event-stream')
            return refused(request.requestId, 'provider_unavailable');
        const result = response.body;
        assertChatGptPlanCompleted(result, binding.route.modelId);
        if (!await authorized())
            return refused(request.requestId, 'action_denied');
        return ScopeRuntimeBrokerResponseSchema.parse({ version: 1, requestId: request.requestId, ok: true,
            status: response.status, headers: response.headers, body: result });
    }
    catch (error) {
        if (signal.aborted)
            return refused(request.requestId, 'action_denied');
        if (error instanceof RangeError && error.message === 'response_too_large')
            return refused(request.requestId, 'response_too_large');
        console.warn('[bots] ChatGPT plan inference unavailable:', error instanceof Error ? error.name : 'UnknownError');
        return refused(request.requestId, 'provider_unavailable');
    }
}
