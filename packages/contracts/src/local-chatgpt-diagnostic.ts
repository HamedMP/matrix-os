import { z } from "zod/v4";

/** Fixed nonsecret metadata from one naturally occurring status operation. */
export const ChatgptPlanDiagnosticSchema = z.object({
    phase: z.enum(['session_binding', 'vault_protection', 'vault_cleanup', 'vault_open', 'vault_read', 'vault_decrypt', 'vault_schema', 'vault_owner', 'catalog', 'peer', 'response_schema', 'transport', 'status']),
    category: z.enum(['stale_session', 'protection_unavailable', 'unavailable', 'invalid_data', 'owner_mismatch', 'cancelled', 'timeout', 'invalid_response', 'rejected', 'unknown']),
    at: z.iso.datetime().max(64), correlationId: z.uuid(),
    httpStatus: z.union([z.literal(400), z.literal(401), z.literal(403), z.literal(404), z.literal(408), z.literal(409), z.literal(422), z.literal(429), z.literal(500), z.literal(502), z.literal(503), z.literal(504)]).optional(),
    runtimeSlotMatches: z.boolean().optional(), authGenerationMatches: z.boolean().optional(), ownerMatches: z.boolean().optional(),
}).strict();
export type ChatgptPlanDiagnostic = Readonly<z.infer<typeof ChatgptPlanDiagnosticSchema>>;
