import { z } from 'zod/v4';
export const ChatgptPlanSessionSchema = z.object({
    runtimeSlot: z.string().min(1).max(128), authGeneration: z.number().int().nonnegative()
}).strict();
export const ChatgptPlanModelSchema = z.object({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/), displayName: z.string().min(1).max(128), input: z.array(z.enum(['text', 'image'])).min(1).max(2), contextWindow: z.number().int().positive().max(2000000), maxOutputTokens: z.number().int().positive().max(200000)
}).strict();
export const ChatgptPlanStatusSchema = z.object({
    state: z.enum([
        'disconnected', 'connecting', 'connected', 'error'
    ]), scope: z.literal('this_device'), account: z.object({
        id: z.uuid(), label: z.string().min(1).max(256)
    }).strict().optional(), models: z.array(ChatgptPlanModelSchema).max(64), grant: z.object({
        revision: z.number().int().nonnegative(), enabled: z.boolean(), background: z.boolean()
    }).strict(), bridgeConnected: z.boolean(), revocation: z.enum(['none', 'confirmed', 'unconfirmed'])
}).strict();
export const CHATGPT_PLAN_INVOKE = {
    'chatgpt-plan:status': {
        request: ChatgptPlanSessionSchema, response: ChatgptPlanStatusSchema
    },
    'chatgpt-plan:connect': {
        request: ChatgptPlanSessionSchema.extend({ purpose: z.literal('personal_local') }), response: ChatgptPlanStatusSchema
    },
    'chatgpt-plan:cancel': {
        request: ChatgptPlanSessionSchema, response: ChatgptPlanStatusSchema
    },
    'chatgpt-plan:disconnect': {
        request: ChatgptPlanSessionSchema, response: ChatgptPlanStatusSchema
    },
    'chatgpt-plan:refresh-models': {
        request: ChatgptPlanSessionSchema, response: ChatgptPlanStatusSchema
    },
    'chatgpt-plan:set-grant': {
        request: ChatgptPlanSessionSchema.extend({
            enabled: z.boolean(), background: z.literal(false)
        }), response: ChatgptPlanStatusSchema
    },
} as const;
export type ChatgptPlanSession = z.infer<typeof ChatgptPlanSessionSchema>;
export type ChatgptPlanStatus = z.infer<typeof ChatgptPlanStatusSchema>;
export type ChatgptPlanModel = z.infer<typeof ChatgptPlanModelSchema>;
