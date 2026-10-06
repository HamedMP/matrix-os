import { z } from 'zod/v4';
const tool = z.object({ type: z.literal('function'), name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
    description: z.string().max(16000).optional(), parameters: z.record(z.string(), z.unknown()), strict: z.boolean().optional() }).strict();
const message = z.object({ type: z.literal('message').optional(), role: z.enum(['system', 'developer', 'user', 'assistant']),
    content: z.union([z.string(), z.array(z.record(z.string(), z.unknown())).max(256)]), id: z.string().max(160).optional(),
    status: z.enum(['in_progress', 'completed', 'incomplete']).optional(), phase: z.enum(['commentary', 'final_answer']).optional() }).strict();
const inputItem = z.union([message,
    z.object({ type: z.literal('function_call'), id: z.string().max(160).optional(), call_id: z.string().max(160), name: tool.shape.name,
        arguments: z.string().max(240000), status: z.enum(['in_progress', 'completed', 'incomplete']).optional() }).strict(),
    z.object({ type: z.literal('function_call_output'), call_id: z.string().max(160), output: z.union([z.string(), z.array(z.record(z.string(), z.unknown())).max(256)]) }).strict(),
    z.object({ type: z.literal('reasoning'), id: z.string().max(160), summary: z.array(z.record(z.string(), z.unknown())).max(256), encrypted_content: z.string().optional() }).strict(),
    z.object({ type: z.literal('additional_tools'), role: z.literal('developer'), tools: z.array(tool).max(64) }).strict(),
]);
export const ChatGptPlanRawWireSchema = z.object({ model: z.string().min(1).max(128), stream: z.literal(true), store: z.literal(false).optional(),
    input: z.array(inputItem).max(4096), tools: z.array(tool).max(64).optional(), instructions: z.string().max(64000).optional(),
    reasoning: z.object({ effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']).optional(), summary: z.enum(['auto', 'concise', 'detailed']).optional() }).strict().optional(),
    include: z.array(z.literal('reasoning.encrypted_content')).max(1).optional(),
}).strict();
/** Final public SIWC request; unsupported hosted tools and system roles never cross the native boundary. */
export const ChatGptPlanWireSchema = ChatGptPlanRawWireSchema.omit({ tools: true }).extend({ store: z.literal(false) })
    .refine(body => !body.input.some(item => 'role' in item && item.role === 'system'));
