import { z } from 'zod/v4';
import { canonicalReferenceId } from '#canonical-chat-primitives';
const writableRevision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const BotProviderConnectionIdSchema = z.enum(['matrix_chatgpt_plan', 'claude_code_tasks']);
export const BotProviderAuthorizationRequestSchema = z.object({ baseRevision: writableRevision, enabled: z.boolean(), background: z.boolean() }).strict();
export const BotProviderConnectionSchema = z.object({
  accountId: canonicalReferenceId(160).optional(),
  id: BotProviderConnectionIdSchema, providerId: z.enum(['openai', 'anthropic']),
  executionKind: z.enum(['direct_pi', 'native_task']), availability: z.enum(['available', 'setup_required', 'unavailable']),
  unavailableReason: z.enum(['provider_access_required', 'authentication_required', 'unsupported_runtime', 'authorization_required']).optional(),
  models: z.array(z.object({ id: canonicalReferenceId(128), displayName: z.string().min(1).max(160) }).strict()).max(128),
  authorization: z.object({ revision, enabled: z.boolean(), background: z.boolean() }).strict(),
  coordinatorFunding: z.enum(['separate', 'subscription']),
}).strict().superRefine((row, ctx) => {
  const pair = row.id === 'claude_code_tasks' ? row.providerId === 'anthropic' && row.executionKind === 'native_task' : row.providerId === 'openai' && row.executionKind === 'direct_pi';
  const status = row.availability === 'available' ? row.unavailableReason === undefined && row.authorization.enabled && row.models.length > 0
    : row.unavailableReason !== undefined && !row.authorization.enabled && (row.availability !== 'unavailable' || row.models.length === 0);
  if (!pair || !status || (!row.authorization.enabled && row.authorization.background) || new Set(row.models.map(model => model.id)).size !== row.models.length) ctx.addIssue({ code: 'custom', message: 'Invalid connection state' });
});
export const BotProviderConnectionsSchema = z.object({ connections: z.array(BotProviderConnectionSchema).max(2).refine(rows => new Set(rows.map(row => row.id)).size === rows.length, 'Duplicate connections') }).strict();
export const BotExecutionBindingSchema = z.object({
  revision, connectionId: z.literal('claude_code_tasks').nullable(), model: canonicalReferenceId(128).nullable(), grantRevision: revision.nullable(),
}).strict().refine(row => row.connectionId === null ? row.model === null && row.grantRevision === null : row.model !== null && row.grantRevision !== null, 'Invalid execution binding');
export const BotExecutionBindingRequestSchema = z.object({ baseRevision: writableRevision, connectionId: z.literal('claude_code_tasks').nullable(), model: canonicalReferenceId(128).optional() }).strict()
  .refine(row => row.connectionId === null ? row.model === undefined : row.model !== undefined, { message: 'Invalid execution binding' });
export type BotProviderConnection = z.infer<typeof BotProviderConnectionSchema>;
export type BotProviderConnections = z.infer<typeof BotProviderConnectionsSchema>;
export type BotProviderAuthorizationRequest = z.infer<typeof BotProviderAuthorizationRequestSchema>;
export type BotExecutionBinding = z.infer<typeof BotExecutionBindingSchema>;
export type BotExecutionBindingRequest = z.infer<typeof BotExecutionBindingRequestSchema>;
