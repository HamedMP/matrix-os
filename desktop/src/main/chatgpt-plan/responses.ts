import { CHATGPT_PLAN_RESPONSE_BYTE_LIMIT, ChatGptPlanWireSchema } from '@matrix-os/contracts';
import { z } from 'zod/v4';
import { PlanFailure, logPlanFailure, safePlanResponseDiagnostic, type PlanResponseDiagnostic } from './diagnostics';
import { PLAN_RESOURCE } from './oauth';
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
type BodyRead = { text: string; outcome: NonNullable<PlanResponseDiagnostic['bodyRead']> };
/** The body deadline also covers custom streams that do not observe fetch abort. */
async function readResponseBody(response: Response, parentSignal: AbortSignal, limit: number, deadlineMs: number): Promise<BodyRead> {
    let text = '';
    if (!response.body) return { text, outcome: 'complete' };
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try { reader = response.body.getReader(); }
    catch (error: unknown) {
        if (error instanceof TypeError) return { text, outcome: 'failed' };
        throw error;
    }
    let outcome: BodyRead['outcome'] = 'complete';
    const deadline = new AbortController();
    const timeout = setTimeout(() => deadline.abort(new DOMException('Response deadline', 'TimeoutError')), deadlineMs);
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
            text += decoder.decode(chunk.value.subarray(0, limit - bytes), { stream: true });
            bytes += chunk.value.byteLength;
            if (bytes > limit) { outcome = 'oversize'; break; }
        }
        text += decoder.decode();
    } catch (error: unknown) {
        outcome = signal.aborted ? signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError' ? 'timeout' : 'cancelled'
            : error instanceof DOMException && error.name === 'AbortError' ? 'cancelled' : 'failed';
    } finally {
        clearTimeout(timeout); signal.removeEventListener('abort', interrupted);
        // Drain/cancel without waiting on an uncertain underlying cancel promise.
        // Releasing the reader also rejects a pending read after Stop or deadline.
        try { void reader.cancel().catch((error: unknown) => logPlanFailure('response_stream_cleanup', error)); }
        catch (error: unknown) { logPlanFailure('response_stream_cleanup', error); }
        finally {
            try { reader.releaseLock(); }
            catch (error: unknown) { logPlanFailure('response_stream_cleanup', error); }
        }
    }
    return { text, outcome };
}
/** Diagnostic output remains allowlisted and capped even after reading a full stream. */
function responseDiagnostic(response: Response, read: BodyRead): PlanResponseDiagnostic {
    const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    const truncated = Buffer.byteLength(read.text) > DIAGNOSTIC_BYTE_LIMIT;
    const text = truncated ? Buffer.from(read.text).subarray(0, DIAGNOSTIC_BYTE_LIMIT).toString('utf8') : read.text;
    const result: Record<string, unknown> = { mime: mime === 'application/json' || mime?.endsWith('+json') ? 'json'
        : mime === 'text/html' ? 'html' : mime === 'text/plain' ? 'plain' : 'other', bodyRead: read.outcome === 'complete' && truncated ? 'oversize' : read.outcome };
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
    if (!response.ok) {
        const read = await readResponseBody(response, input.signal, DIAGNOSTIC_BYTE_LIMIT, 1500);
        throw new PlanFailure('responses', 'http_error', response.status, responseDiagnostic(response, read));
    }
    // Official streaming Responses parsing is based on SSE frames, not MIME.
    // A labelled JSON/HTML body cannot pass the same event/completion checks.
    const read = await readResponseBody(response, input.signal, CHATGPT_PLAN_RESPONSE_BYTE_LIMIT, 120000);
    const fail = (category: string): never => { throw new PlanFailure('responses', category, response.status, responseDiagnostic(response, read)); };
    if (read.outcome !== 'complete') fail(read.outcome === 'oversize' ? 'response_too_large' : read.outcome === 'failed' ? 'invalid_stream' : read.outcome);
    input.validate();
    const normalized = read.text.replace(/\r\n?/g, '\n');
    const frames = normalized.split('\n\n');
    const tail = frames.pop();
    if (tail?.trim()) fail(/^(?:data|event):/m.test(normalized) ? 'incomplete_stream' : 'invalid_stream');
    let completed = false;
    let sawData = false;
    try {
        for (const frame of frames) {
            const lines = frame.split('\n').filter(Boolean);
            if (lines.some(line => !line.startsWith(':') && !/^(?:data|event|id|retry)(?::|$)/.test(line))) fail('invalid_stream');
            const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
            if (!data) continue;
            sawData = true;
            if (data === '[DONE]') continue;
            const event = z.object({ type: z.string().max(128).regex(/^(?:response\.[a-z0-9_.]+|error)$/) }).passthrough().parse(JSON.parse(data));
            const eventNames = lines.filter(line => line.startsWith('event:')).map(line => line.slice(6).trim());
            if (eventNames.some(name => name && name !== event.type)) fail('invalid_stream');
            if (completed || ['response.failed', 'response.incomplete', 'error'].includes(event.type)) fail('incomplete_stream');
            if (event.type === 'response.output_text.delta') z.object({ delta: z.string() }).parse(event);
            if (event.type === 'response.completed') {
                z.object({ status: z.literal('completed'), model: z.literal(input.model) }).parse(event.response);
                completed = true;
            }
        }
    } catch (error: unknown) {
        if (error instanceof PlanFailure) throw error;
        if (error instanceof SyntaxError || error instanceof z.ZodError) fail('invalid_stream');
        throw error;
    }
    if (!completed) fail(sawData ? 'incomplete_stream' : 'invalid_stream');
    // Lone CR is valid SSE framing. Normalize it for the Gateway completion
    // boundary, while retaining existing LF/CRLF framing and all event data.
    return read.text.replace(/\r(?!\n)/g, '\n');
}
