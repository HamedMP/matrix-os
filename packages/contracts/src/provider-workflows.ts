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
