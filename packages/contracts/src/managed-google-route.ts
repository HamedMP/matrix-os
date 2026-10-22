import { z } from 'zod/v4';
import { MANAGED_WORKERS_AI_MODEL_IDS } from './funded-workers-models.js';

/** Request-local cache/payload controls only; not provider/account retention or ZDR attestation. */
export const MANAGED_GOOGLE_CONTROL_POLICY_VERSION = 'matrix-cf-workers-request-controls-v1' as const;
export const MANAGED_GOOGLE_ROUTE_DIGEST_DOMAIN = 'matrix-managed-google-route:v1:';
const reference = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const endpoint = z.url().max(2048).refine(value => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.href === value; }
  catch (error) { if (error instanceof TypeError) return false; throw error; }
});
const model = z.enum(MANAGED_WORKERS_AI_MODEL_IDS);
const fields = {
  routeId: reference, routeRevision: z.number().int().positive().max(2_147_483_647),
  evidence: z.strictObject({ referenceDigest: digest, accountSettingsReferenceDigest: digest,
    reviewedAt: z.iso.datetime(), expiresAt: z.iso.datetime() }),
  relay: z.strictObject({ endpoint, api: z.literal('openai-completions') }),
  upstream: z.strictObject({ endpoint, api: z.literal('cloudflare-workers-ai-run'), nativeModelId: model, canonicalModelId: model }),
  cloudflare: z.strictObject({ accountId: z.string().regex(/^[a-f0-9]{32}$/), gatewayId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    credentialMode: z.literal('workers-ai-api-token') }),
  credential: z.strictObject({ generation: z.uuid(), fingerprint: digest }),
  recipientChain: z.array(z.strictObject({ recipientId: reference, accountId: reference, endpoint })).min(1).max(16),
  controlPolicyVersion: z.literal(MANAGED_GOOGLE_CONTROL_POLICY_VERSION),
};
type RouteFields = z.infer<z.ZodObject<typeof fields>>;
function coherent(value: RouteFields, context: z.RefinementCtx) {
  const first = value.recipientChain[0];
  const expected = `https://api.cloudflare.com/client/v4/accounts/${value.cloudflare.accountId}/ai/run/${value.upstream.nativeModelId}`;
  if (value.upstream.endpoint !== expected || value.upstream.canonicalModelId !== value.upstream.nativeModelId
    || !value.relay.endpoint.endsWith('/v1/chat/completions') || first?.recipientId !== 'cloudflare'
    || first.accountId !== value.cloudflare.accountId || first.endpoint !== value.upstream.endpoint
    || new Set(value.recipientChain.map(recipient => JSON.stringify(recipient))).size !== value.recipientChain.length
    || Date.parse(value.evidence.expiresAt) <= Date.parse(value.evidence.reviewedAt)) {
    context.addIssue({ code: 'custom', message: 'Inconsistent managed route facts' });
  }
}
/** Private operator-record shape. Parsing a record neither reviews evidence nor approves processing. */
export const CloudflareManagedGoogleRouteReviewSchema = z.strictObject(fields).superRefine(coherent);
/** First recognized adapter only. Extend with a separately reviewed discriminated branch for future providers. */
export const ManagedGoogleRouteDescriptorSchema = z.strictObject({ version: z.literal(1), kind: z.literal('cloudflare-workers-ai'), ...fields }).superRefine(coherent);
export type CloudflareManagedGoogleRouteReview = z.infer<typeof CloudflareManagedGoogleRouteReviewSchema>;
export type ManagedGoogleRouteDescriptor = z.infer<typeof ManagedGoogleRouteDescriptorSchema>;
/** Schema projection fixes object property order; recipient array order is significant. No secret/content fields. */
export function serializeManagedGoogleRouteDescriptor(value: unknown): string {
  return JSON.stringify(ManagedGoogleRouteDescriptorSchema.parse(value));
}
