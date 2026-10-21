import { z } from 'zod/v4';
import { BotCredentialAccessSourceIdSchema } from '../../bots/credentials.js';
import { GoogleDataAuthorityError, GoogleDataConsentInputSchema, GoogleDataKindsSchema, GoogleDataProfileInputSchema,
  GoogleDataStampSchema, ResolvedGoogleRouteSchema, type ResolvedGoogleRoute } from '../profiles.js';
import type { GoogleDataRepository } from '../repository.js';
import type { GoogleInferenceIdentity } from './inference-policy.js';

/** Transport adapter identity, separate from a provider/account evidence mapping. */
export const GOOGLE_POLICY_HARNESS_ID = {
  'anthropic-messages': 'scope-runtime:anthropic-messages',
  'openai-completions': 'scope-runtime:openai-completions',
  'openai-responses': 'scope-runtime:openai-responses',
} as const;
export const GooglePolicyBindingSchema = z.strictObject({
  runId: z.string().regex(/^run_[A-Za-z0-9_-]{1,128}$/),
  runtimeHandle: z.string().regex(/^runtime_[a-f0-9]{32}$/),
  executionGeneration: z.string().regex(/^(0|[1-9][0-9]{0,19})$/),
  accessSourceId: BotCredentialAccessSourceIdSchema,
});
export const GoogleInferenceIdentitySchema = z.strictObject({
  endpoint: GoogleDataProfileInputSchema.shape.binding.shape.endpoint.refine(value => value.startsWith('https://')), api: z.enum(['anthropic-messages', 'openai-completions', 'openai-responses']),
  modelId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
  harnessVersion: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:@-]*$/),
  credential: z.strictObject({ kind: z.enum(['api_key', 'auth_token']), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), generation: z.uuid().nullable() }),
});
export const GooglePolicyAuthorizeSchema = z.strictObject({
  binding: GooglePolicyBindingSchema, googleAccountId: z.uuid(), purposeId: GoogleDataConsentInputSchema.shape.purposeId,
  dataKinds: GoogleDataKindsSchema, identity: GoogleInferenceIdentitySchema,
});
export const GooglePolicyRevalidateSchema = GooglePolicyAuthorizeSchema.extend({ stamp: GoogleDataStampSchema });
export const GooglePolicyGrantedSchema = z.strictObject({ stamp: GoogleDataStampSchema, resolvedRoute: ResolvedGoogleRouteSchema });
export const GooglePolicyDisclosureSchema = z.strictObject({
  profileId: z.uuid(), profileRevision: GoogleDataConsentInputSchema.shape.profileRevision,
  googleAccountId: z.uuid(), evidenceRevision: GoogleDataConsentInputSchema.shape.evidenceRevision,
  disclosureRevision: GoogleDataConsentInputSchema.shape.disclosureRevision, retentionRevision: GoogleDataConsentInputSchema.shape.retentionRevision,
  purposeId: GoogleDataConsentInputSchema.shape.purposeId, purpose: GoogleDataProfileInputSchema.shape.disclosure.shape.purpose,
  recipients: GoogleDataProfileInputSchema.shape.disclosure.shape.recipients, dataKinds: GoogleDataKindsSchema,
  retention: GoogleDataProfileInputSchema.shape.retention, expiresAt: GoogleDataConsentInputSchema.shape.expiresAt,
});
export const GooglePolicyConsentRequiredSchema = z.strictObject({ error: z.literal('consent_required'), disclosure: GooglePolicyDisclosureSchema,
  consentRevision: z.number().int().min(0).max(2_147_483_646) });
export type GooglePolicyAuthorizeInput = z.infer<typeof GooglePolicyAuthorizeSchema>;
export type GooglePolicyRevalidateInput = z.infer<typeof GooglePolicyRevalidateSchema>;

/** Correlate the returned evidence route with the exact observed transport. */
export function matchesGoogleObservedRoute(route: ResolvedGoogleRoute, identity: GoogleInferenceIdentity): boolean {
  return route.credentialKind === 'byo' && identity.api === 'anthropic-messages' && identity.credential.kind === 'api_key'
    && identity.credential.generation !== null && route.credentialGeneration === identity.credential.generation
    && route.credentialFingerprint === identity.credential.fingerprint && route.endpoint === identity.endpoint
    && route.model === identity.modelId && route.harnessId === GOOGLE_POLICY_HARNESS_ID[identity.api]
    && route.harnessRevision === identity.harnessVersion;
}

/** These facts must originate in the authenticated machine's live broker, never
 * a model/client. Account references and onward recipients come only from reviewed
 * evidence. Exact observed key/endpoint/adapter matching does not approve evidence. */
export async function resolveGooglePolicyProfile(repository: GoogleDataRepository, ownerId: string,
  bindingValue: unknown, identityValue: unknown, purposeValue: unknown): Promise<{ profileId: string; route: ResolvedGoogleRoute }> {
  const binding = GooglePolicyBindingSchema.safeParse(bindingValue);
  const parsed = GoogleInferenceIdentitySchema.safeParse(identityValue);
  const purpose = GoogleDataConsentInputSchema.shape.purposeId.safeParse(purposeValue);
  if (!binding.success || !parsed.success || !purpose.success) throw new GoogleDataAuthorityError();
  const identity = parsed.data;
  // The current managed relay has neither an actual credential generation nor
  // verified downstream proof. No current managed adapter can supply this contract.
  if (binding.data.accessSourceId !== 'owner_anthropic_key' || identity.api !== 'anthropic-messages'
    || identity.credential.kind !== 'api_key' || identity.credential.generation === null) throw new GoogleDataAuthorityError();
  const profiles = await repository.listReviewedProfiles(ownerId);
  const matches = profiles.filter(({ input }) => input.purposeId === purpose.data && input.allowedModels.includes(identity.modelId)
    && matchesGoogleObservedRoute({ ...input.binding, model: identity.modelId }, identity));
  if (matches.length !== 1) throw new GoogleDataAuthorityError();
  const selected = matches[0]!;
  const route = ResolvedGoogleRouteSchema.safeParse({ ...selected.input.binding, model: identity.modelId });
  if (!route.success) throw new GoogleDataAuthorityError();
  return { profileId: selected.id, route: route.data };
}
