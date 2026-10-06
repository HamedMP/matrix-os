import { ChatGptPlanWireSchema } from '@matrix-os/contracts';
import { z } from 'zod/v4';
import { PlanFailure } from './diagnostics';
import { boundedText, PLAN_RESOURCE } from './oauth';
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
    if (!response.ok || !response.headers.get('content-type')?.startsWith('text/event-stream')) {
        await response.body?.cancel();
        throw new PlanFailure('responses', response.ok ? 'invalid_content_type' : 'http_error', response.status);
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
