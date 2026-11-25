import { z } from 'zod/v4';
import { MANAGED_WORKERS_AI_MODEL_IDS } from '#funded-workers-models';
import { ManagedGoogleRouteDescriptorSchema } from '#managed-google-route';

export const MANAGED_GOOGLE_ROUTE_CONTROL_PATH = '/internal/google-managed-route/resolve';
/** Private platform-to-proxy control only. A request cannot supply route, owner or approval facts. */
export const ManagedGoogleRouteResolveRequestSchema = z.discriminatedUnion('api', [
  z.strictObject({ api: z.literal('openai-completions'), canonicalModelId: z.enum(MANAGED_WORKERS_AI_MODEL_IDS) }),
  z.strictObject({ api: z.literal('anthropic-messages'), canonicalModelId: z.literal('anthropic/claude-sonnet-5') }),
]);
export const ManagedGoogleRouteResolveResponseSchema = z.strictObject({ descriptor: ManagedGoogleRouteDescriptorSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/) });
export type ManagedGoogleRouteResolveRequest = z.infer<typeof ManagedGoogleRouteResolveRequestSchema>;
export type ManagedGoogleRouteResolveResponse = z.infer<typeof ManagedGoogleRouteResolveResponseSchema>;
