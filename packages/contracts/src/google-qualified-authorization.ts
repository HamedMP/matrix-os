import { z } from 'zod/v4';
import { FundedAiAuthorizationRequestSchema, FundedAiAuthorizationResponseSchema } from '#funded-ai';
import { GOOGLE_QUALIFIED_FUNDED_PROTOCOL, GoogleQualifiedFundedCredentialSchema, GoogleQualifiedFundedBindingSchema,
  GoogleQualifiedFundedCheckResponseSchema, GoogleQualifiedFundedRouteSchema } from '#google-qualified-funded';

// Service-control-only requests. Never accept owner, URL, class or approval from callers.
const fields = { protocol: z.literal(GOOGLE_QUALIFIED_FUNDED_PROTOCOL), credential: GoogleQualifiedFundedCredentialSchema,
  api: GoogleQualifiedFundedRouteSchema.shape.api, canonicalModelId: GoogleQualifiedFundedRouteSchema.shape.canonicalModelId,
  expectedDigest: z.string().regex(/^[a-f0-9]{64}$/) };
export const GoogleQualifiedFundedDispatchCheckRequestSchema = z.strictObject(fields);
const legacy = FundedAiAuthorizationRequestSchema.shape;
export const GoogleQualifiedFundedAuthorizationRequestSchema = z.strictObject({ ...fields,
  requestId: legacy.requestId, maxCostMicrousd: legacy.maxCostMicrousd, billingMode: z.literal('usage'), claimKey: legacy.claimKey });
export const GoogleQualifiedFundedDispatchCheckResponseSchema = GoogleQualifiedFundedCheckResponseSchema;
export const GoogleQualifiedFundedAuthorizationResponseSchema = z.strictObject({ protocol: fields.protocol,
  authorization: FundedAiAuthorizationResponseSchema, binding: GoogleQualifiedFundedBindingSchema }).superRefine((value, ctx) => {
  if (value.authorization.reservation.modelId !== value.binding.canonicalModelId || value.authorization.reservation.billingMode !== 'usage'
    || !value.authorization.policy.allowedModelIds.includes(value.binding.canonicalModelId)
    || Date.parse(value.authorization.identity.expiresAt) > Date.parse(value.binding.evidenceExpiresAt)) {
    ctx.addIssue({ code: 'custom', message: 'Inconsistent qualified reservation' });
  }
});
export type GoogleQualifiedFundedAuthorizationRequest = z.infer<typeof GoogleQualifiedFundedAuthorizationRequestSchema>;
export type GoogleQualifiedFundedAuthorizationResponse = z.infer<typeof GoogleQualifiedFundedAuthorizationResponseSchema>;
export type GoogleQualifiedFundedDispatchCheckRequest = z.infer<typeof GoogleQualifiedFundedDispatchCheckRequestSchema>;
export type GoogleQualifiedFundedDispatchCheckResponse = z.infer<typeof GoogleQualifiedFundedDispatchCheckResponseSchema>;
