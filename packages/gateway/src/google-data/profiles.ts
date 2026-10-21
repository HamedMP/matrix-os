import { createHash } from 'node:crypto';
import { z } from 'zod/v4';

const identifier = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:@-]*$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().min(1).max(2_147_483_646);
const label = z.string().min(1).max(240).refine(value => value === value.trim() && !/[\u0000-\u001f\u007f-\u009f]/.test(value));
export const GoogleDataTimeSchema = z.iso.datetime();
const endpoint = z.string().max(2048).refine(value => {
  try {
    const url = new URL(value);
    return url.href === value && !url.username && !url.password && !url.search && !url.hash
      && (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)));
  } catch (error) { if (!(error instanceof TypeError)) throw error; return false; }
}, 'Exact canonical endpoint required');
const recipient = z.strictObject({ recipientId: identifier, accountId: identifier, endpoint });
const bindingShape = {
  providerId: identifier,
  // Evidence-backed server mapping reference; never inferred from a key or generation UUID.
  providerAccountId: identifier,
  credentialKind: z.enum(['managed', 'byo']),
  credentialGeneration: identifier,
  credentialFingerprint: digest,
  endpoint,
  harnessId: identifier,
  harnessRevision: identifier,
  recipientChain: z.array(recipient).min(1).max(16).refine(values => new Set(values.map(item => item.recipientId)).size === values.length, 'Duplicate recipient'),
};
const model = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const binding = z.strictObject(bindingShape).refine(value => {
  const first = value.recipientChain[0];
  return Boolean(first) && first!.recipientId === value.providerId && first!.accountId === value.providerAccountId && first!.endpoint === value.endpoint;
}, 'Primary recipient must match the resolved route');
export const ResolvedGoogleRouteSchema = z.strictObject({ ...bindingShape, model }).refine(value => {
  const first = value.recipientChain[0];
  return Boolean(first) && first!.recipientId === value.providerId && first!.accountId === value.providerAccountId && first!.endpoint === value.endpoint;
}, 'Primary recipient must match the resolved route');
export type ResolvedGoogleRoute = z.infer<typeof ResolvedGoogleRouteSchema>;
export const GoogleDataKindsSchema = z.array(z.enum(['gmail-metadata', 'gmail-content', 'gmail-attachments', 'google-derived-context'])).min(1).max(4)
  .refine(values => new Set(values).size === values.length, 'Duplicate data kind');
const retention = z.discriminatedUnion('mode', [
  z.strictObject({ revision, policyId: identifier, mode: z.literal('none'), maxAgeSeconds: z.literal(0) }),
  z.strictObject({ revision, policyId: identifier, mode: z.literal('duration'), maxAgeSeconds: z.number().int().min(1).max(2_592_000) }),
]);
export const GoogleDataProfileInputSchema = z.strictObject({
  ownerId: identifier,
  binding,
  allowedModels: z.array(model).min(1).max(64).refine(values => new Set(values).size === values.length, 'Duplicate model'),
  controls: z.strictObject({ noTraining: z.literal(true), noAdvertising: z.literal(true), noSale: z.literal(true), purposeLimited: z.literal(true) }),
  purposeId: identifier,
  dataKinds: GoogleDataKindsSchema,
  evidence: z.strictObject({ revision, referenceDigest: digest, reviewerId: identifier, reviewedAt: GoogleDataTimeSchema, expiresAt: GoogleDataTimeSchema }),
  disclosure: z.strictObject({ revision, recipients: z.array(z.strictObject({ recipientId: identifier, name: label, role: label })).min(1).max(16), purpose: label }),
  retention,
}).refine(value => value.binding.recipientChain.length === value.disclosure.recipients.length
  && value.binding.recipientChain.every((recipient, index) => recipient.recipientId === value.disclosure.recipients[index]?.recipientId), 'Every recipient needs its exact ordered disclosure');
export type GoogleDataProfileInput = z.infer<typeof GoogleDataProfileInputSchema>;
export const GoogleDataConsentInputSchema = z.strictObject({
  ownerId: identifier, googleAccountId: z.uuid(), purposeId: identifier, profileId: z.uuid(),
  profileRevision: revision, evidenceRevision: revision, disclosureRevision: revision, retentionRevision: revision,
  dataKinds: GoogleDataKindsSchema, expiresAt: GoogleDataTimeSchema,
});
export type GoogleDataConsentInput = z.infer<typeof GoogleDataConsentInputSchema>;
export const GoogleDataRequestSchema = z.strictObject({
  ownerId: identifier, googleAccountId: z.uuid(), purposeId: identifier, profileId: z.uuid(),
  dataKinds: GoogleDataKindsSchema, resolvedRoute: ResolvedGoogleRouteSchema,
});
export type GoogleDataRequest = z.infer<typeof GoogleDataRequestSchema>;
export const GoogleDataStampSchema = z.strictObject({
  ownerId: identifier, googleAccountId: z.uuid(), purposeId: identifier, profileId: z.uuid(),
  profileRevision: revision, evidenceRevision: revision, disclosureRevision: revision, retentionRevision: revision,
  consentId: z.uuid(), consentRevision: revision, dataKinds: GoogleDataKindsSchema,
  routeDigest: digest, expiresAt: GoogleDataTimeSchema,
});
export type GoogleDataStamp = z.infer<typeof GoogleDataStampSchema>;
export class GoogleDataAuthorityError extends Error {
  constructor(readonly code: 'unavailable' | 'conflict' | 'capacity' = 'unavailable') { super('Google data processing unavailable'); this.name = 'GoogleDataAuthorityError'; }
}
export function routeDigest(route: ResolvedGoogleRoute): string {
  return createHash('sha256').update(JSON.stringify(ResolvedGoogleRouteSchema.parse(route))).digest('hex');
}
export function routeMatchesProfile(route: ResolvedGoogleRoute, profile: GoogleDataProfileInput): boolean {
  const { model: selected, ...resolvedBinding } = ResolvedGoogleRouteSchema.parse(route);
  return profile.allowedModels.includes(selected) && JSON.stringify(resolvedBinding) === JSON.stringify(profile.binding);
}
