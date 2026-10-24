import { isDeepStrictEqual } from 'node:util';
import { GoogleQualifiedFundedBindingSchema, GoogleQualifiedFundedRouteSchema, FundedAiRequestClassSchema, type GoogleQualifiedFundedRoute, type ManagedGoogleRouteResolveRequest } from '@matrix-os/contracts';
import { googleManagedRouteDigest, validGoogleManagedIdentity } from '../managed/identity.js';
import { z } from 'zod/v4';
import { BotCredentialAccessSourceIdSchema } from '../../bots/credentials.js';
import { GoogleDataAuthorityError, GoogleDataConsentInputSchema, GoogleDataKindsSchema, GoogleDataProfileInputSchema,
  GoogleDataStampSchema, GoogleDataModelSchema, ResolvedGoogleRouteSchema, type ResolvedGoogleRoute } from '../profiles.js';
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
  accessSourceId: BotCredentialAccessSourceIdSchema, requestClass: FundedAiRequestClassSchema.optional(),
});
export const GoogleInferenceIdentitySchema = z.strictObject({
  endpoint: GoogleDataProfileInputSchema.shape.binding.shape.endpoint.refine(value => value.startsWith('https://')), api: z.enum(['anthropic-messages', 'openai-completions', 'openai-responses']),
  modelId: GoogleDataModelSchema,
  harnessVersion: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:@-]*$/),
  credential: z.strictObject({ kind: z.enum(['api_key', 'auth_token']), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), generation: z.uuid().nullable() }),
  managed: GoogleQualifiedFundedBindingSchema.optional(),
}).refine(value => !value.managed || validGoogleManagedIdentity(value), 'Inconsistent managed identity');
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
  if (identity.managed) {
    if (!validGoogleManagedIdentity(identity)) return false; const descriptor = identity.managed.descriptor;
    return route.credentialKind === 'managed' && route.providerId === 'cloudflare' && route.providerAccountId === descriptor.cloudflare.accountId
      && route.credentialGeneration === descriptor.credential.generation && route.credentialFingerprint === descriptor.credential.fingerprint
      && route.endpoint === descriptor.upstream.endpoint && route.model === identity.modelId
      && route.harnessId === GOOGLE_POLICY_HARNESS_ID[identity.api] && route.harnessRevision === identity.harnessVersion
      && isDeepStrictEqual(route.recipientChain, descriptor.recipientChain);
  }
  return route.credentialKind === 'byo' && ['anthropic-messages', 'openai-completions', 'openai-responses'].includes(identity.api) && identity.credential.kind === 'api_key'
    && identity.credential.generation !== null && route.credentialGeneration === identity.credential.generation
    && route.credentialFingerprint === identity.credential.fingerprint && route.endpoint === identity.endpoint
    && route.model === identity.modelId && route.harnessId === GOOGLE_POLICY_HARNESS_ID[identity.api]
    && route.harnessRevision === identity.harnessVersion;
}

export type GoogleManagedRouteResolver = (selector: ManagedGoogleRouteResolveRequest, signal: AbortSignal) => Promise<GoogleQualifiedFundedRoute>;
async function revalidateManaged(identity: GoogleInferenceIdentity, resolver: GoogleManagedRouteResolver, signal: AbortSignal, now: () => Date) {
  if (!identity.managed || !validGoogleManagedIdentity(identity) || signal.aborted) throw new GoogleDataAuthorityError();
  const actual = GoogleQualifiedFundedRouteSchema.parse(await resolver({ api: 'openai-completions', canonicalModelId: identity.managed.canonicalModelId }, signal));
  const { requestClass: _class, ...expected } = identity.managed;
  if (signal.aborted || actual.digest !== googleManagedRouteDigest(actual.descriptor) || !isDeepStrictEqual(actual, expected)
    || now().getTime() < Date.parse(actual.descriptor.evidence.reviewedAt) || now().getTime() >= Date.parse(actual.evidenceExpiresAt)) throw new GoogleDataAuthorityError();
}

/** These facts must originate in the authenticated machine's live broker, never
 * a model/client. Account references and onward recipients come only from reviewed
 * evidence. Exact observed key/endpoint/adapter matching does not approve evidence. */
export async function resolveGooglePolicyProfile(repository: GoogleDataRepository, ownerId: string,
  bindingValue: unknown, identityValue: unknown, purposeValue: unknown, options: { resolveManagedRoute?: GoogleManagedRouteResolver; signal?: AbortSignal; now?: () => Date } = {}): Promise<{ profileId: string; route: ResolvedGoogleRoute; revalidateManaged?: () => Promise<void> }> {
  const binding = GooglePolicyBindingSchema.safeParse(bindingValue);
  const parsed = GoogleInferenceIdentitySchema.safeParse(identityValue);
  const purpose = GoogleDataConsentInputSchema.shape.purposeId.safeParse(purposeValue);
  if (!binding.success || !parsed.success || !purpose.success) throw new GoogleDataAuthorityError();
  const identity = parsed.data;
  const signal = options.signal ?? AbortSignal.timeout(10000); const now = options.now ?? (() => new Date());
  let recheck: (() => Promise<void>) | undefined;
  if (binding.data.accessSourceId === 'matrix_included') {
    if (!identity.managed || !options.resolveManagedRoute || binding.data.requestClass !== identity.managed.requestClass) throw new GoogleDataAuthorityError();
    recheck = () => revalidateManaged(identity, options.resolveManagedRoute!, signal, now); await recheck();
  } else if (!((binding.data.accessSourceId === 'owner_anthropic_key' && identity.api === 'anthropic-messages')
    || (binding.data.accessSourceId === 'owner_openai_key' && ['openai-completions', 'openai-responses'].includes(identity.api))) || identity.managed
    || identity.credential.kind !== 'api_key' || identity.credential.generation === null) throw new GoogleDataAuthorityError();
  const profiles = await repository.listReviewedProfiles(ownerId);
  const matches = profiles.filter(({ input }) => input.purposeId === purpose.data && input.allowedModels.includes(identity.modelId)
    && matchesGoogleObservedRoute({ ...input.binding, model: identity.modelId }, identity)
    && (!identity.managed || input.evidence.referenceDigest === identity.managed.descriptor.evidence.referenceDigest
      && Date.parse(input.evidence.reviewedAt) >= Date.parse(identity.managed.descriptor.evidence.reviewedAt)
      && Date.parse(input.evidence.expiresAt) <= Date.parse(identity.managed.evidenceExpiresAt)));
  if (matches.length !== 1) throw new GoogleDataAuthorityError();
  const selected = matches[0]!;
  const route = ResolvedGoogleRouteSchema.safeParse({ ...selected.input.binding, model: identity.modelId });
  if (!route.success) throw new GoogleDataAuthorityError();
  return { profileId: selected.id, route: route.data, ...(recheck ? { revalidateManaged: recheck } : {}) };
}
