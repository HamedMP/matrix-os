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
    }).strict(), bridgeConnected: z.boolean(), bridgeFailure: z.literal('device_conflict').optional(), revocation: z.enum(['none', 'confirmed', 'unconfirmed'])
}).strict();
/** Fixed nonsecret metadata from one naturally occurring status operation. */
export const ChatgptPlanDiagnosticSchema = z.object({
    phase: z.enum(['session_binding', 'vault_protection', 'vault_cleanup', 'vault_open', 'vault_read', 'vault_decrypt', 'vault_schema', 'vault_owner', 'catalog', 'peer', 'response_schema', 'transport', 'status']),
    category: z.enum(['stale_session', 'protection_unavailable', 'unavailable', 'invalid_data', 'owner_mismatch', 'cancelled', 'timeout', 'invalid_response', 'rejected', 'unknown']),
    at: z.iso.datetime().max(64), correlationId: z.uuid(),
    httpStatus: z.union([z.literal(400), z.literal(401), z.literal(403), z.literal(404), z.literal(408), z.literal(409), z.literal(422), z.literal(429), z.literal(500), z.literal(502), z.literal(503), z.literal(504)]).optional(),
    runtimeSlotMatches: z.boolean().optional(), authGenerationMatches: z.boolean().optional(), ownerMatches: z.boolean().optional(),
}).strict();
export const ChatgptPlanStatusResponseSchema = z.union([
    ChatgptPlanStatusSchema,
    z.object({ kind: z.literal('status_failure'), diagnostic: ChatgptPlanDiagnosticSchema }).strict(),
    z.object({ kind: z.literal('status_result'), status: ChatgptPlanStatusSchema, diagnostic: ChatgptPlanDiagnosticSchema }).strict(),
]);
export type ChatgptPlanDiagnostic = Readonly<z.infer<typeof ChatgptPlanDiagnosticSchema>>;
export const CHATGPT_PLAN_INVOKE = {
    'chatgpt-plan:status': {
        request: ChatgptPlanSessionSchema, response: ChatgptPlanStatusResponseSchema
    },
    'chatgpt-plan:connect': {
        request: ChatgptPlanSessionSchema.extend({ purpose: z.literal('personal_local') }), response: ChatgptPlanStatusSchema
    },
    'chatgpt-plan:rebind': {
        request: ChatgptPlanSessionSchema.extend({ purpose: z.literal('replace_device') }), response: ChatgptPlanStatusSchema
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
