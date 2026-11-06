import { INFERENCE_RESPONSE_BODY_MAX_BYTES } from '@matrix-os/contracts';
import { ScopeRuntimeBrokerResponseSchema, type ScopeRuntimeBotInferenceRequest, type ScopeRuntimeBrokerResponse, type ScopeRuntimeBrokerResult } from '@matrix-os/scope-runtime/broker-protocol';
import type { PiRuntimeBinding } from './runtime-registry.js';
import type { ChatGptPlanAuthority } from './chatgpt-plan.js';
import { chatGptPlanWire, assertChatGptPlanCompleted } from './chatgpt-plan-wire.js';
import { guardInferenceStream, validateChatGptStream } from './inference-stream.js';
const refused = (requestId: string, error: 'action_denied' | 'invalid_request' | 'provider_unavailable' | 'response_too_large'): ScopeRuntimeBrokerResponse => ScopeRuntimeBrokerResponseSchema.parse({ version: 1, requestId, ok: false, error });
export async function forwardChatGptPlanInference(request: ScopeRuntimeBotInferenceRequest, binding: PiRuntimeBinding, deps: {
    authority: ChatGptPlanAuthority;
    signal: AbortSignal;
    stillAuthorized(): boolean | Promise<boolean>;
}): Promise<ScopeRuntimeBrokerResult> {
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
    const streamLifetime = new AbortController();
    const streaming = request.responseMode === 'stream';
    const signal = AbortSignal.any([deps.signal, streamLifetime.signal, ...(!streaming ? [AbortSignal.timeout(120000)] : [])]);
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let handedOff = false;
    const pauseIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = undefined;
    };
    const clearIdle = () => {
        pauseIdle();
        signal.removeEventListener('abort', clearIdle);
    };
    if (streaming) signal.addEventListener('abort', clearIdle, { once: true });
    const refreshIdle = () => {
        if (!streaming || signal.aborted) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => streamLifetime.abort(new DOMException('Inference stalled', 'TimeoutError')), 120000);
        idleTimer.unref();
    };
    const finish = () => { clearIdle(); streamLifetime.abort(); };
    refreshIdle(); // Bounds preparation/headers and then the first real body read.
    const waitFor = <T>(pending: Promise<T>): Promise<T> => {
        if (!streaming) return pending;
        return new Promise<T>((resolve, reject) => {
            // Authority/setup waits stay bounded even while body idle is paused.
            const timer = setTimeout(() => streamLifetime.abort(new DOMException('Inference control stalled', 'TimeoutError')), 120000);
            timer.unref();
            const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
            const abort = () => { cleanup(); reject(signal.reason); };
            signal.addEventListener('abort', abort, { once: true });
            pending.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
            if (signal.aborted) abort();
        });
    };
    const authorized = async () => !signal.aborted && await waitFor(Promise.resolve().then(() => deps.stillAuthorized())) && !signal.aborted
        && await waitFor(deps.authority.revalidate(binding, signal)) && !signal.aborted
        && await waitFor(Promise.resolve().then(() => deps.stillAuthorized())) && !signal.aborted;
    try {
        if (!await authorized())
            return refused(request.requestId, 'action_denied');
        if (!await authorized())
            return refused(request.requestId, 'action_denied');
        if (request.responseMode === 'stream') {
            if (!deps.authority.inferStream) return refused(request.requestId, 'provider_unavailable');
            const response = await waitFor(deps.authority.inferStream(binding, body, signal));
            if (response.status !== 200 || response.headers['content-type'] !== 'text/event-stream') {
                streamLifetime.abort();
                return refused(request.requestId, 'provider_unavailable');
            }
            refreshIdle();
            async function* progress() {
                try {
                    for await (const chunk of response.body) {
                        // A received chunk is bounded downstream backpressure,
                        // not time spent waiting for more provider data.
                        if (chunk.length) pauseIdle();
                        yield chunk;
                        if (chunk.length) refreshIdle();
                    }
                } finally {
                    pauseIdle(); // EOF/terminal delivery has no upstream idle.
                }
            }
            handedOff = true;
            return { version: 1, requestId: request.requestId, ok: true, status: response.status,
                headers: { 'content-type': 'text/event-stream' },
                body: guardInferenceStream(validateChatGptStream(progress(), binding.route.modelId, authorized), {
                    signal, authorized, abort: finish,
                }) };
        }
        const response = await deps.authority.infer(binding, body, signal);
        if (response.status !== 200 || response.headers['content-type'] !== 'text/event-stream')
            return refused(request.requestId, 'provider_unavailable');
        const result = response.body;
        if (Buffer.byteLength(result, 'utf8') > INFERENCE_RESPONSE_BODY_MAX_BYTES)
            return refused(request.requestId, 'response_too_large');
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
    } finally {
        if (!handedOff) finish();
    }
}
