import { ChatGptPlanWireSchema } from '@matrix-os/contracts';
import { z } from 'zod/v4';
import { PlanFailure, logPlanFailure, safePlanResponseDiagnostic, type PlanResponseDiagnostic } from './diagnostics';
import { boundedText, PLAN_RESOURCE } from './oauth';
const DIAGNOSTIC_BYTE_LIMIT = 16 * 1024;
function sseCompletion(text: string): boolean {
    return text.replace(/\r\n/g, '\n').split('\n\n').some(frame => {
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data || data === '[DONE]') return false;
        try {
            const event: unknown = JSON.parse(data);
            return !!event && typeof event === 'object' && 'type' in event && event.type === 'response.completed';
        } catch (error: unknown) {
            if (error instanceof SyntaxError) return false;
            throw error;
        }
    });
}
/** Read a small diagnostic sample once. MIME rejection remains a failure; no replay. */
async function unexpectedResponseDiagnostic(response: Response, parentSignal: AbortSignal): Promise<PlanResponseDiagnostic> {
    const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    const result: Record<string, unknown> = { mime: mime === 'application/json' || mime?.endsWith('+json') ? 'json'
        : mime === 'text/html' ? 'html' : mime === 'text/plain' ? 'plain' : 'other', bodyRead: 'complete' };
    let text = '';
    if (response.body) {
        const reader = response.body.getReader();
        const deadline = new AbortController();
        const timeout = setTimeout(() => deadline.abort(new DOMException('Diagnostic deadline', 'TimeoutError')), 1500);
        const signal = AbortSignal.any([parentSignal, deadline.signal]);
        let interrupted!: () => void;
        const interruption = new Promise<never>((_, reject) => { interrupted = () => reject(signal.reason); });
        signal.addEventListener('abort', interrupted, { once: true });
        const decoder = new TextDecoder();
        let bytes = 0;
        try {
            while (true) {
                signal.throwIfAborted();
                const chunk = await Promise.race([reader.read(), interruption]);
                signal.throwIfAborted();
                if (chunk.done) break;
                const available = DIAGNOSTIC_BYTE_LIMIT - bytes;
                text += decoder.decode(chunk.value.subarray(0, available), { stream: true });
                bytes += chunk.value.byteLength;
                if (bytes > DIAGNOSTIC_BYTE_LIMIT) { result.bodyRead = 'oversize'; break; }
            }
            text += decoder.decode();
        } catch (error: unknown) {
            result.bodyRead = signal.aborted ? signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError' ? 'timeout' : 'cancelled'
                : error instanceof DOMException && error.name === 'AbortError' ? 'cancelled' : 'failed';
        } finally {
            clearTimeout(timeout); signal.removeEventListener('abort', interrupted);
            // Do not let an uncertain stream cancellation replace the original MIME/status
            // failure or extend its bounded read deadline. Only coarse cleanup errors log.
            try {
                void reader.cancel().catch((error: unknown) => logPlanFailure('response_diagnostic_cleanup', error));
            } catch (error: unknown) {
                logPlanFailure('response_diagnostic_cleanup', error);
            } finally {
                try { reader.releaseLock(); }
                catch (error: unknown) { logPlanFailure('response_diagnostic_cleanup', error); }
            }
        }
    }
    result.sseFraming = /^(?:data|event):/m.test(text);
    result.sseCompleted = sseCompletion(text);
    if (result.bodyRead === 'complete') {
        if (!text.trim()) result.bodyShape = 'empty';
        else {
            try {
                const value: unknown = JSON.parse(text);
                result.bodyShape = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
                if (value && typeof value === 'object' && !Array.isArray(value)) {
                    const object = value as Record<string, unknown>;
                    const error = object.error && typeof object.error === 'object' ? object.error as Record<string, unknown> : {};
                    const detail = object.detail && typeof object.detail === 'object' ? object.detail as Record<string, unknown> : {};
                    result.hasDetail = Object.hasOwn(object, 'detail'); result.hasError = Object.hasOwn(object, 'error');
                    result.responseObject = object.object === 'response' || !!object.response && typeof object.response === 'object' && !Array.isArray(object.response);
                    result.responseType = object.object ?? object.type;
                    result.responseStatus = object.status;
                    result.errorCode = error.code ?? object.code ?? detail.code ?? object.detail;
                }
            } catch (error: unknown) {
                if (error instanceof SyntaxError) result.bodyShape = 'non_json';
                else throw error;
            }
        }
    }
    return safePlanResponseDiagnostic(result);
}
/** Final SIWC wire, fixed public origin and terminal completion; never retries. */
export async function requestPlanResponse(input: {
    fetchFn: typeof fetch;
    body: string;
    model: string;
    signal: AbortSignal;
    accessToken(): Promise<string>;
    validate(): void;
}): Promise<string> {
    if (Buffer.byteLength(input.body) > 512000)
        throw new Error('invalid inference');
    const body = ChatGptPlanWireSchema.parse(JSON.parse(input.body));
    if (body.model !== input.model)
        throw new Error('invalid inference');
    input.validate();
    const accessToken = await input.accessToken();
    input.validate();
    let response: Response;
    try {
        response = await input.fetchFn(`${PLAN_RESOURCE}/responses`, {
            method: 'POST', redirect: 'error',
            headers: {
                authorization: `Bearer ${accessToken}`, 'content-type': 'application/json'
            },
            body: JSON.stringify(body), signal: input.signal,
        });
    }
    catch (error: unknown) {
        const category = input.signal.aborted ? input.signal.reason instanceof DOMException && input.signal.reason.name === 'TimeoutError' ? 'timeout' : 'cancelled' : 'network_error';
        throw new PlanFailure('responses', category);
    }
    const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (!response.ok || mime !== 'text/event-stream') {
        const diagnostic = await unexpectedResponseDiagnostic(response, input.signal);
        throw new PlanFailure('responses', response.ok ? 'invalid_content_type' : 'http_error', response.status, diagnostic);
    }
    const text = await boundedText(response, 1024 * 1024);
    input.validate();
    let completed = false;
    for (const frame of text.replace(/\r\n/g, '\n').split('\n\n')) {
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data || data === '[DONE]')
            continue;
        const event = z.object({ type: z.string() }).passthrough().parse(JSON.parse(data));
        if (completed || ['response.failed', 'response.incomplete', 'error'].includes(event.type))
            throw new PlanFailure('responses', 'incomplete_stream');
        if (event.type === 'response.completed') {
            z.object({
                status: z.literal('completed'), model: z.literal(input.model)
            }).parse(event.response);
            completed = true;
        }
    }
    if (!completed)
        throw new PlanFailure('responses', 'incomplete_stream');
    return text;
}
