import { ChatGptPlanRawWireSchema, ChatGptPlanWireSchema } from '@matrix-os/contracts';
const bodySchema = ChatGptPlanRawWireSchema.passthrough();
const omitted = new Set(['max_output_tokens', 'max_tool_calls', 'background', 'conversation', 'previous_response_id', 'metadata', 'moderation',
    'multi_agent', 'prompt', 'prompt_cache_retention', 'prompt_cache_options', 'prompt_cache_key', 'safety_identifier', 'temperature', 'top_logprobs', 'top_p', 'truncation', 'user', 'service_tier', 'tool_choice']);
/** Explicit adaptation is required: Pi workers use a secretless placeholder, so the
 * SDK cannot infer the OAuth access token's SIWC compatibility by inspection. */
export function chatGptPlanWire(raw: unknown, modelId: string): string {
    const body = bodySchema.parse(raw);
    if (body.model !== modelId)
        throw new Error('invalid_request');
    const allowed = new Set(Object.keys(bodySchema.shape));
    if (Object.keys(body).some(key => !allowed.has(key) && !omitted.has(key)))
        throw new Error('invalid_request');
    const input = body.input.map(item => 'role' in item && item.role === 'system' ? { ...item, role: 'developer' } : item);
    // additional_tools keeps broker tool names unchanged (namespace wrapping changes
    // names on some SDK versions). No hosted tools, MCP/connectors or tool_search.
    if (body.tools?.length)
        input.unshift({ type: 'additional_tools', role: 'developer', tools: body.tools });
    const result = { model: modelId, input, store: false, stream: true,
        ...(body.instructions !== undefined ? { instructions: body.instructions } : {}),
        ...(body.reasoning !== undefined ? { reasoning: body.reasoning } : {}),
        ...(body.include !== undefined ? { include: body.include } : {}) };
    return JSON.stringify(ChatGptPlanWireSchema.parse(result));
}
/** A partial delta or clean socket close is insufficient. Late failures discard the
 * whole response, so neither Pi nor the gateway can checkpoint a false completion. */
export function assertChatGptPlanCompleted(body: string, modelId: string): void {
    let completed = false;
    for (const frame of body.replace(/\r\n/g, '\n').split('\n\n')) {
        const lines = frame.split('\n');
        const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data || data === '[DONE]')
            continue;
        const event = JSON.parse(data) as Record<string, unknown>;
        if (!event || typeof event !== 'object' || typeof event.type !== 'string')
            throw new Error('provider_unavailable');
        if (completed || ['error', 'response.failed', 'response.incomplete'].includes(event.type))
            throw new Error('provider_unavailable');
        if (event.type === 'response.completed') {
            const response = event.response as Record<string, unknown> | undefined;
            if (!response || response.status !== 'completed' || response.model !== modelId)
                throw new Error('provider_unavailable');
            completed = true;
        }
    }
    if (!completed)
        throw new Error('provider_unavailable');
}
