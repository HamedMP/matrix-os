import { validateBotImageInferenceBody } from "@matrix-os/contracts";
import { CHATGPT_PLAN_RESPONSE_BYTE_LIMIT, INFERENCE_RESPONSE_BUFFER_MAX_BYTES, INFERENCE_RESPONSE_CHUNK_MAX_BYTES, ChatGptPlanWireSchema } from '@matrix-os/contracts';
import { z } from 'zod/v4';
import { PlanFailure, logPlanFailure, planNetworkFailureDiagnostic, planPeerNetworkFailureDiagnostic, safePlanResponseDiagnostic, type PlanResponseDiagnostic } from './diagnostics';
import { PLAN_RESOURCE } from './oauth';
const DIAGNOSTIC_BYTE_LIMIT = 16 * 1024;
/** Only complete JSON objects from bounded SSE samples are inspected. */
function sseDiagnostic(segments: readonly string[]): PlanResponseDiagnostic {
    let sseFraming = false, sseCompleted = false, failureSeen = false;
    let projection: PlanResponseDiagnostic = {};
    for (const segment of segments) {
        const normalized = segment.replace(/\r\n?/g, '\n');
        sseFraming ||= /^(?:data|event):/m.test(normalized);
        for (const frame of normalized.split('\n\n')) {
            const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (!data || data === '[DONE]') continue;
            let event: unknown;
            try { event = JSON.parse(data); }
            catch (error: unknown) { if (error instanceof SyntaxError) continue; throw error; }
            if (!event || typeof event !== 'object' || Array.isArray(event)) continue;
            const value = event as Record<string, unknown>;
            sseCompleted ||= value.type === 'response.completed';
            if (failureSeen || typeof value.type !== 'string' || !['response.completed', 'response.failed', 'response.incomplete', 'error'].includes(value.type)) continue;
            const response = value.response && typeof value.response === 'object' && !Array.isArray(value.response)
                ? value.response as Record<string, unknown> : {};
            const error = response.error && typeof response.error === 'object' && !Array.isArray(response.error)
                ? response.error as Record<string, unknown>
                : value.error && typeof value.error === 'object' && !Array.isArray(value.error) ? value.error as Record<string, unknown> : {};
            const incomplete = response.incomplete_details && typeof response.incomplete_details === 'object' && !Array.isArray(response.incomplete_details)
                ? response.incomplete_details as Record<string, unknown> : {};
            projection = safePlanResponseDiagnostic({ responseType: value.type, responseStatus: response.status ?? value.status,
                errorCode: error.code ?? value.code, incompleteReason: incomplete.reason,
                responseObject: Object.hasOwn(value, 'response'), hasError: Object.hasOwn(value, 'error') || Object.hasOwn(response, 'error') });
            failureSeen = value.type !== 'response.completed';
        }
    }
    return { ...projection, sseFraming, sseCompleted };
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
function responseDiagnostic(response: Response, read: BodyRead, samples?: readonly string[]): PlanResponseDiagnostic {
    const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    const truncated = Buffer.byteLength(read.text) > DIAGNOSTIC_BYTE_LIMIT;
    const encoded = truncated ? Buffer.from(read.text) : undefined;
    const text = encoded ? encoded.subarray(0, DIAGNOSTIC_BYTE_LIMIT).toString('utf8') : read.text;
    const result: Record<string, unknown> = { mime: mime === 'application/json' || mime?.endsWith('+json') ? 'json'
        : mime === 'text/html' ? 'html' : mime === 'text/plain' ? 'plain' : 'other', bodyRead: read.outcome === 'complete' && truncated ? 'oversize' : read.outcome };
    // Keep one fixed 16KiB diagnostic budget. Separate head/tail samples retain
    // small terminal events after long deltas without joining across omitted bytes.
    const segments = samples ?? (encoded ? [encoded.subarray(0, DIAGNOSTIC_BYTE_LIMIT / 2).toString('utf8'),
        encoded.subarray(-DIAGNOSTIC_BYTE_LIMIT / 2).toString('utf8')] : [text]);
    Object.assign(result, sseDiagnostic(segments));
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
interface PlanResponseInput {
    fetchFn: typeof fetch;
    body: string;
    model: string;
    signal: AbortSignal;
    accessToken(): Promise<string>;
    validate(): void;
}

/** Final SIWC wire, fixed public origin; never retries. */
async function openPlanResponse(input: PlanResponseInput): Promise<Response> {
    if (!validateBotImageInferenceBody(input.body, 512000).valid)
        throw new Error('invalid inference');
    const body = ChatGptPlanWireSchema.parse(JSON.parse(input.body));
    if (body.model !== input.model)
        throw new Error('invalid inference');
    input.validate();
    const accessToken = await input.accessToken();
    input.validate();
    let response: Response;
    const requestBody = JSON.stringify(body);
    const fetchBegan = performance.now();
    try {
        response = await input.fetchFn(`${PLAN_RESOURCE}/responses`, {
            method: 'POST', redirect: 'error',
            headers: {
                authorization: `Bearer ${accessToken}`, 'content-type': 'application/json'
            },
            body: requestBody, signal: input.signal,
        });
    }
    catch (error: unknown) {
        const category = input.signal.aborted ? input.signal.reason instanceof DOMException && input.signal.reason.name === 'TimeoutError' ? 'timeout' : 'cancelled' : 'network_error';
        throw new PlanFailure('responses', category, undefined, undefined,
            planNetworkFailureDiagnostic(error, Math.round(performance.now() - fetchBegan), Buffer.byteLength(requestBody)));
    }
    if (!response.ok) {
        const read = await readResponseBody(response, input.signal, DIAGNOSTIC_BYTE_LIMIT, 1500);
        throw new PlanFailure('responses', 'http_error', response.status, responseDiagnostic(response, read));
    }
    return response;
}

/** One SSE event is buffered at a time; a completed event stays private until EOF. */
export async function* requestPlanResponseStream(input: PlanResponseInput, validateChunks = true,
    onProgress?: () => void): AsyncGenerator<string> {
    const response = await openPlanResponse(input);
    let head = '', tail = '', observedBytes = 0;
    const sample = (value: string) => {
        observedBytes += Buffer.byteLength(value);
        head = (head + value).slice(0, DIAGNOSTIC_BYTE_LIMIT);
        tail = (tail + value).slice(-DIAGNOSTIC_BYTE_LIMIT);
    };
    const fail = (category: string, streamReason: NonNullable<PlanResponseDiagnostic['streamReason']>, error?: unknown): never => {
        const large = observedBytes > DIAGNOSTIC_BYTE_LIMIT;
        const samples = large ? [head.slice(0, DIAGNOSTIC_BYTE_LIMIT / 2), tail.slice(-DIAGNOSTIC_BYTE_LIMIT / 2)] : [head];
        const read: BodyRead = { text: large ? head + tail : head, outcome: streamReason === 'body_read'
            ? category === 'timeout' ? 'timeout' : category === 'cancelled' ? 'cancelled' : 'failed'
            : large ? 'oversize' : 'complete' };
        throw new PlanFailure('responses', category, response.status, { ...responseDiagnostic(response, read, samples), streamReason },
            streamReason === 'body_read' ? planPeerNetworkFailureDiagnostic(error, 'body_read') : undefined);
    };
    // The provider may deliver a large transport read containing many small
    // events. Decode it in bounded slices before adding to the event buffer.
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let pending = '', heldTerminal = '', completed = false, doneSeen = false, sawData = false;
    const parseFrame = (raw: string): string => {
        const normalized = raw.replace(/\r\n?/g, '\n');
        const lines = normalized.slice(0, -2).split('\n').filter(Boolean);
        if (lines.some(line => !line.startsWith(':') && !/^(?:data|event|id|retry)(?::|$)/.test(line))) fail('invalid_stream', 'frame_fields');
        const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (data) {
            sawData = true;
            if (data === '[DONE]') {
                if (!completed || doneSeen) fail('incomplete_stream', 'done_order');
                doneSeen = true;
            } else {
                if (doneSeen) fail('incomplete_stream', 'done_order');
                let validationReason: NonNullable<PlanResponseDiagnostic['streamReason']> = 'event_json';
                try {
                    const parsed: unknown = JSON.parse(data);
                    validationReason = 'event_schema';
                    const event = z.object({ type: z.string().max(128).regex(/^(?:response\.[a-z0-9_.]+|error)$/) }).passthrough().parse(parsed);
                    const eventNames = lines.filter(line => line.startsWith('event:')).map(line => line.slice(6).trim());
                    if (eventNames.some(name => name && name !== event.type)) fail('invalid_stream', 'event_name');
                    if (completed) fail('incomplete_stream', 'event_after_terminal');
                    if (event.type === 'response.failed') fail('incomplete_stream', 'upstream_failed');
                    if (event.type === 'response.incomplete') fail('incomplete_stream', 'upstream_incomplete');
                    if (event.type === 'error') fail('incomplete_stream', 'upstream_error');
                    if (event.type === 'response.output_text.delta') {
                        validationReason = 'output_delta';
                        z.object({ delta: z.string() }).parse(event);
                    }
                    if (event.type === 'response.completed') {
                        validationReason = 'terminal_identity';
                        z.object({ status: z.literal('completed'), model: z.literal(input.model) }).parse(event.response);
                        completed = true;
                    }
                } catch (error: unknown) {
                    if (error instanceof PlanFailure) throw error;
                    if (error instanceof SyntaxError || error instanceof z.ZodError) fail('invalid_stream', validationReason);
                    throw error;
                }
            }
        }
        return raw.replace(/\r(?!\n)/g, '\n');
    };
    function* splitOutput(value: string): Generator<string> {
        let part = '', bytes = 0;
        for (const character of value) {
            const size = Buffer.byteLength(character);
            if (bytes + size > INFERENCE_RESPONSE_CHUNK_MAX_BYTES) {
                yield part;
                part = ''; bytes = 0;
            }
            part += character; bytes += size;
        }
        if (part) yield part;
    }
    function* drainFrames(eof: boolean): Generator<string> {
        let batch = '', batchBytes = 0;
        let boundary: RegExpExecArray | null;
        while ((boundary = /(?:\r\n|\r(?!\n)|(?<!\r)\n){2}/.exec(pending)) !== null) {
            // A trailing CR may become CRLF when the next transport read arrives.
            if (!eof && boundary[0].endsWith('\r') && boundary.index + boundary[0].length === pending.length) break;
            const frame = pending.slice(0, boundary.index + boundary[0].length);
            pending = pending.slice(boundary.index + boundary[0].length);
            if (Buffer.byteLength(frame) > INFERENCE_RESPONSE_BUFFER_MAX_BYTES) fail('response_too_large', 'frame_limit');
            const output = parseFrame(frame);
            if (completed) {
                heldTerminal += output;
                if (Buffer.byteLength(heldTerminal) > INFERENCE_RESPONSE_BUFFER_MAX_BYTES) fail('response_too_large', 'terminal_limit');
            } else {
                if (validateChunks) input.validate();
                for (const piece of splitOutput(output)) {
                    const bytes = Buffer.byteLength(piece);
                    if (batchBytes + bytes > INFERENCE_RESPONSE_CHUNK_MAX_BYTES) {
                        if (validateChunks) input.validate();
                        refreshIdle();
                        yield batch;
                        refreshIdle();
                        batch = ''; batchBytes = 0;
                    }
                    batch += piece; batchBytes += bytes;
                }
            }
        }
        if (batch) {
            if (validateChunks) input.validate();
            refreshIdle();
            yield batch;
            refreshIdle();
        }
    }
    const bodyStream = response.body;
    if (!bodyStream) return fail('invalid_stream', 'body_missing');
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try { reader = bodyStream.getReader(); }
    catch (error: unknown) {
        if (error instanceof TypeError) fail('invalid_stream', 'reader_unavailable');
        throw error;
    }
    const deadline = new AbortController();
    const expire = () => deadline.abort(new DOMException('Response deadline', 'TimeoutError'));
    let timeout = setTimeout(expire, 120000);
    const signal = AbortSignal.any([input.signal, deadline.signal]);
    function refreshIdle() {
        if (!validateChunks || signal.aborted) return;
        clearTimeout(timeout);
        timeout = setTimeout(expire, 120000);
        timeout.unref?.();
        onProgress?.();
    }
    let interrupted!: () => void;
    const interruption = new Promise<never>((_, reject) => { interrupted = () => reject(signal.reason); });
    signal.addEventListener('abort', interrupted, { once: true });
    try {
        while (true) {
            const read = await (async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
                try {
                    signal.throwIfAborted();
                    const result = await Promise.race([reader.read(), interruption]);
                    signal.throwIfAborted();
                    return result;
                } catch (error: unknown) {
                    return fail(signal.aborted ? signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError' ? 'timeout' : 'cancelled'
                        : error instanceof DOMException && error.name === 'AbortError' ? 'cancelled' : 'invalid_stream', 'body_read', error);
                }
            })();
            if (read.done) break;
            if (read.value.byteLength) refreshIdle();
            for (let offset = 0; offset < read.value.byteLength; offset += 4096) {
                let decoded: string;
                try { decoded = decoder.decode(read.value.subarray(offset, offset + 4096), { stream: true }); }
                catch (error: unknown) {
                    if (error instanceof TypeError) fail('invalid_stream', 'utf8_decode');
                    throw error;
                }
                sample(decoded);
                pending += decoded;
                yield* drainFrames(false);
                if (Buffer.byteLength(pending) > INFERENCE_RESPONSE_BUFFER_MAX_BYTES) fail('response_too_large', 'pending_limit');
            }
        }
        let final: string;
        try { final = decoder.decode(); }
        catch (error: unknown) {
            if (error instanceof TypeError) return fail('invalid_stream', 'utf8_decode');
            throw error;
        }
        sample(final);
        pending += final;
        yield* drainFrames(true);
        if (pending.trim()) fail(/^(?:data|event):/m.test(head) ? 'incomplete_stream' : 'invalid_stream', 'trailing_frame');
        if (!completed) fail(sawData ? 'incomplete_stream' : 'invalid_stream', 'missing_completion');
        input.validate();
        for (const piece of splitOutput(heldTerminal)) {
            refreshIdle();
            yield piece;
            refreshIdle();
        }
    } finally {
        clearTimeout(timeout); signal.removeEventListener('abort', interrupted);
        try { void reader.cancel().catch((error: unknown) => logPlanFailure('response_stream_cleanup', error)); }
        catch (error: unknown) { logPlanFailure('response_stream_cleanup', error); }
        finally {
            try { reader.releaseLock(); }
            catch (error: unknown) { logPlanFailure('response_stream_cleanup', error); }
        }
    }
}

/** Legacy one-shot reply retains its cumulative cap and exact SSE validation. */
export async function requestPlanResponse(input: PlanResponseInput): Promise<string> {
    let text = '', bytes = 0;
    for await (const chunk of requestPlanResponseStream(input, false)) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > CHATGPT_PLAN_RESPONSE_BYTE_LIMIT)
            throw new PlanFailure('responses', 'response_too_large', 200);
        text += chunk;
    }
    return text;
}
