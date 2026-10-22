import { z } from 'zod/v4';
import { FundedAiPolicyCheckResponseSchema, FundedAiRequestClassSchema,
  FundedAiRuntimeCredentialIssueResponseSchema } from '#funded-ai';
import { ManagedGoogleRouteDescriptorSchema } from '#managed-google-route';
import { ManagedGoogleRouteResolveRequestSchema } from '#managed-google-route-control';

/** Separate protocol; existing strict funded v1 payloads remain unchanged. No approval is implied. */
export const GOOGLE_QUALIFIED_FUNDED_PROTOCOL = 'matrix-google-qualified-funded-v1' as const;
export const GOOGLE_QUALIFIED_FUNDED_TOKEN_PREFIX = 'sk-matrix-google-funded-' as const;
// Absolute end assertion also refuses final newlines (JavaScript `$` alone accepts them).
const qualifiedToken = /^sk-matrix-google-funded-([A-Za-z0-9][A-Za-z0-9_.:-]{0,79})\.([A-Za-z0-9_-]{43})$(?![\s\S])/;
export const GoogleQualifiedFundedCredentialSchema = z.string().min(64).max(256).regex(qualifiedToken);
/** Format parsing only, not authentication/consent; never returns raw secret material. */
export function parseGoogleQualifiedFundedCredential(value: unknown): { tokenId: string } | null {
  const parsed = GoogleQualifiedFundedCredentialSchema.safeParse(value);
  if (!parsed.success) return null;
  const tokenId = qualifiedToken.exec(parsed.data)?.[1]; return tokenId ? { tokenId } : null;
}
// Reuse field validators, not the legacy object's prefix refinement. Legacy validators remain unchanged.
const legacyLease = FundedAiRuntimeCredentialIssueResponseSchema.shape;
export const GoogleQualifiedFundedLeaseSchema = z.strictObject({ ...legacyLease,
  credential: z.strictObject({ ...legacyLease.credential.shape, token: GoogleQualifiedFundedCredentialSchema }),
  requestClass: FundedAiRequestClassSchema }).superRefine((value, ctx) => {
  const lifetime = Date.parse(value.credential.expiresAt) - Date.parse(value.credential.issuedAt);
  if (lifetime <= 0 || lifetime > 60 * 60_000 || parseGoogleQualifiedFundedCredential(value.credential.token)?.tokenId !== value.credential.tokenId) {
    ctx.addIssue({ code: 'custom', message: 'Inconsistent qualified credential' });
  }
});
export type GoogleQualifiedFundedLease = z.infer<typeof GoogleQualifiedFundedLeaseSchema>;
const protocol = z.literal(GOOGLE_QUALIFIED_FUNDED_PROTOCOL);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const selector = ManagedGoogleRouteResolveRequestSchema;
const relayBaseUrl = z.url().max(2048).refine(value => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
    && url.href.replace(/\/$/, '') === value && !value.endsWith('/'); }
  catch (error) { if (error instanceof TypeError) return false; throw error; }
});
const routeFields = { descriptor: ManagedGoogleRouteDescriptorSchema, digest, relayBaseUrl,
  api: z.literal('openai-completions'), canonicalModelId: ManagedGoogleRouteDescriptorSchema.shape.upstream.shape.canonicalModelId,
  evidenceExpiresAt: z.iso.datetime() };
function coherent(value: { descriptor: z.infer<typeof ManagedGoogleRouteDescriptorSchema>; relayBaseUrl: string;
  api: string; canonicalModelId: string; evidenceExpiresAt: string }, ctx: z.RefinementCtx) {
  if (value.api !== value.descriptor.relay.api || value.canonicalModelId !== value.descriptor.upstream.canonicalModelId
    || `${value.relayBaseUrl}/v1/chat/completions` !== value.descriptor.relay.endpoint
    || value.evidenceExpiresAt !== value.descriptor.evidence.expiresAt) ctx.addIssue({ code: 'custom', message: 'Inconsistent qualified route' });
}
/** Digest is structurally bounded here; the receiving server MUST recompute canonical SHA-256. */
export const GoogleQualifiedFundedRouteSchema = z.strictObject(routeFields).superRefine(coherent);
export const GoogleQualifiedFundedBindingSchema = z.strictObject({ ...routeFields, requestClass: FundedAiRequestClassSchema }).superRefine(coherent);
export type GoogleQualifiedFundedRoute = z.infer<typeof GoogleQualifiedFundedRouteSchema>;
export type GoogleQualifiedFundedBinding = z.infer<typeof GoogleQualifiedFundedBindingSchema>;
const requestFields = { protocol };
// Reuse only the supported selector variants, never accept route/account/owner/URL assertions.
function requestSchema<T extends z.ZodRawShape>(extra: T) {
  return z.discriminatedUnion('api', [z.strictObject({ ...selector.options[0].shape, ...requestFields, ...extra }),
    z.strictObject({ ...selector.options[1].shape, ...requestFields, ...extra })]);
}
export const GoogleQualifiedFundedDiscoveryRequestSchema = requestSchema({});
export const GoogleQualifiedFundedIssueRequestSchema = requestSchema({ requestClass: FundedAiRequestClassSchema, expectedDigest: digest });
export const GoogleQualifiedFundedCheckRequestSchema = requestSchema({ requestClass: FundedAiRequestClassSchema, expectedDigest: digest,
  credential: GoogleQualifiedFundedCredentialSchema });
export const GoogleQualifiedFundedDiscoveryResponseSchema = z.strictObject({ protocol, route: GoogleQualifiedFundedRouteSchema });
export const GoogleQualifiedFundedIssueResponseSchema = z.strictObject({ protocol, lease: GoogleQualifiedFundedLeaseSchema,
  binding: GoogleQualifiedFundedBindingSchema }).superRefine((value, ctx) => {
  if (value.lease.requestClass !== value.binding.requestClass || !value.lease.policy.enabled
    || !value.lease.policy.allowedModelIds.includes(value.binding.canonicalModelId)
    || Date.parse(value.lease.credential.expiresAt) > Date.parse(value.binding.evidenceExpiresAt)
    || Date.parse(value.lease.credential.issuedAt) < Date.parse(value.binding.descriptor.evidence.reviewedAt)) {
    ctx.addIssue({ code: 'custom', message: 'Inconsistent qualified lease' });
  }
});
export const GoogleQualifiedFundedCheckResponseSchema = z.strictObject({ protocol, authorization: FundedAiPolicyCheckResponseSchema,
  binding: GoogleQualifiedFundedBindingSchema }).superRefine((value, ctx) => {
  if (!value.authorization.policy.enabled || !value.authorization.policy.allowedModelIds.includes(value.binding.canonicalModelId)
    || Date.parse(value.authorization.identity.expiresAt) > Date.parse(value.binding.evidenceExpiresAt)) {
    ctx.addIssue({ code: 'custom', message: 'Inconsistent qualified authorization' });
  }
});
export type GoogleQualifiedFundedDiscoveryRequest = z.infer<typeof GoogleQualifiedFundedDiscoveryRequestSchema>;
export type GoogleQualifiedFundedDiscoveryResponse = z.infer<typeof GoogleQualifiedFundedDiscoveryResponseSchema>;
export type GoogleQualifiedFundedIssueRequest = z.infer<typeof GoogleQualifiedFundedIssueRequestSchema>;
export type GoogleQualifiedFundedCheckRequest = z.infer<typeof GoogleQualifiedFundedCheckRequestSchema>;
export type GoogleQualifiedFundedIssueResponse = z.infer<typeof GoogleQualifiedFundedIssueResponseSchema>;
export type GoogleQualifiedFundedCheckResponse = z.infer<typeof GoogleQualifiedFundedCheckResponseSchema>;
