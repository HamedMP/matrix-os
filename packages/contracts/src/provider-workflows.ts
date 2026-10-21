import { z } from 'zod/v4';
const ref = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
export const ProviderWorkflowMethodSchema = z.enum(['device_code', 'terminal', 'existing_codex', 'browser']);
export const ProviderWorkflowStartSchema = z.object({ harnessInstanceId: ref, kind: z.enum(['login', 'install', 'uninstall']), method: ProviderWorkflowMethodSchema.optional(), idempotencyKey: ref }).strict();
export const ProviderWorkflowKeySchema = z.object({ harnessInstanceId: ref, providerId: z.enum(['openai', 'anthropic', 'openrouter']), apiKey: z.string().trim().min(8).max(4096).refine(value => !/[\r\n\0]/.test(value)) }).strict();
const authorizationUrl = z.string().url().max(2048).refine(value => {
  const url = new URL(value);
  const trusted = url.hostname === 'auth.openai.com' && ['/codex/device', '/oauth/authorize'].includes(url.pathname)
    || url.hostname === 'claude.com' && url.pathname === '/cai/oauth/authorize'
    || url.hostname === 'platform.claude.com' && url.pathname === '/oauth/authorize';
  return url.protocol === 'https:' && (!url.port || url.port === '443') && trusted
    && !url.username && !url.password && !url.hash && !/[\u0000-\u001f\u007f]/.test(value);
});
export const ProviderWorkflowSchema = z.object({ id: ref, harnessInstanceId: ref, kind: z.enum(['login', 'install', 'uninstall']), state: z.enum(['pending', 'running', 'succeeded', 'failed', 'cancelled', 'expired']), expiresAt: z.iso.datetime(), terminalSessionId: ref.nullable(), deviceCode: z.string().regex(/^[A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})?$/).nullable(), authorizationUrl: authorizationUrl.nullable(), safeFailure: z.enum(['rejected', 'unavailable', 'expired']).nullable() }).strict();
export const ProviderWorkflowCapabilitySchema = z.object({ harnessInstanceId: ref, harness: z.enum(['claude', 'codex', 'opencode', 'pi', 'hermes', 'openclaw']), displayName: z.string().min(1).max(120), installState: z.enum(['installed', 'missing', 'installing', 'failed', 'unknown']), loginMethods: z.array(ProviderWorkflowMethodSchema).max(4), apiKeyProviders: z.array(z.enum(['openai', 'anthropic', 'openrouter'])).max(3), install: z.boolean(), uninstall: z.boolean(), logs: z.boolean(), activeOperationId: ref.nullable().optional() }).strict();
export const ProviderWorkflowCapabilitiesSchema = z.array(ProviderWorkflowCapabilitySchema).max(32);
export const ProviderWorkflowLogsSchema = z.object({ entries: z.array(z.object({ at: z.iso.datetime(), event: z.enum(['started', 'running', 'succeeded', 'failed', 'cancelled', 'expired']) }).strict()).max(64) }).strict();
export type ProviderWorkflow = z.infer<typeof ProviderWorkflowSchema>;
export type ProviderWorkflowStart = z.infer<typeof ProviderWorkflowStartSchema>;
export type ProviderWorkflowKey = z.infer<typeof ProviderWorkflowKeySchema>;
export type ProviderWorkflowCapability = z.infer<typeof ProviderWorkflowCapabilitySchema>;
export type ProviderWorkflowLogs = z.infer<typeof ProviderWorkflowLogsSchema>;

export const ProviderWorkflowCodeSchema = z.object({ code: z.string().min(1).max(4096).regex(/^[A-Za-z0-9._~+\/=\-]+(?:#[A-Za-z0-9._~\-]+)?$/) }).strict();

// Separate wire shapes: historical strict clients must never receive these fields.
export const ProviderWorkflowConnectionOptionSchema = z.object({
  id: ref,
  providerId: z.enum(['openai', 'anthropic', 'openrouter']),
  authKind: z.enum(['subscription', 'api_key']),
  method: ProviderWorkflowMethodSchema.optional(),
  billingKind: z.enum(['subscription', 'api_key']),
  executionKind: z.literal('native'),
  availability: z.enum(['available', 'unavailable']),
  unavailableReason: z.enum(['not_installed', 'unsupported_runtime', 'provider_access_required']).optional(),
}).strict().refine(option => option.authKind === option.billingKind
  && (option.authKind === 'subscription' ? option.method !== undefined : option.method === undefined)
  && (option.availability === 'unavailable' ? option.unavailableReason !== undefined : option.unavailableReason === undefined),
{ message: 'Invalid connection option combination' });
export const ProviderWorkflowCapabilityV2Schema = ProviderWorkflowCapabilitySchema.extend({
  connectionOptions: z.array(ProviderWorkflowConnectionOptionSchema).max(16),
}).refine(row => new Set(row.connectionOptions.map(option => option.id)).size === row.connectionOptions.length,
{ message: 'Duplicate connection option' });
export const ProviderWorkflowCapabilitiesV2Schema = z.array(ProviderWorkflowCapabilityV2Schema).max(32);
export const ProviderWorkflowStartV2Schema = z.object({ harnessInstanceId: ref, optionId: ref, idempotencyKey: ref }).strict();
export const ProviderWorkflowKeyV2Schema = z.object({ harnessInstanceId: ref, optionId: ref, apiKey: ProviderWorkflowKeySchema.shape.apiKey }).strict();
export const ProviderWorkflowV2Schema = ProviderWorkflowSchema.extend({ connectionOption: ProviderWorkflowConnectionOptionSchema.nullable() });
export type ProviderWorkflowConnectionOption = z.infer<typeof ProviderWorkflowConnectionOptionSchema>;
export type ProviderWorkflowCapabilityV2 = z.infer<typeof ProviderWorkflowCapabilityV2Schema>;
export type ProviderWorkflowStartV2 = z.infer<typeof ProviderWorkflowStartV2Schema>;
export type ProviderWorkflowKeyV2 = z.infer<typeof ProviderWorkflowKeyV2Schema>;
export type ProviderWorkflowV2 = z.infer<typeof ProviderWorkflowV2Schema>;
