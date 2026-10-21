import { describe, expect, it } from 'vitest';
import { GoogleDataProfileInputSchema, ResolvedGoogleRouteSchema, GoogleDataConsentInputSchema } from '../../../packages/gateway/src/google-data/profiles.js';
import { profileInput, route, consentInput } from './fixtures.js';
describe('Google data authority boundaries', () => {
  it.each(['managed', 'byo'] as const)('accepts bounded reviewed metadata for %s without preapproving a provider', credentialKind => {
    expect(GoogleDataProfileInputSchema.parse(profileInput({ credentialKind })).binding.credentialKind).toBe(credentialKind);
  });
  it('rejects content, secret, approval and unknown fields at every boundary', () => {
    expect(GoogleDataProfileInputSchema.safeParse({ ...profileInput(), approved: true }).success).toBe(false);
    expect(ResolvedGoogleRouteSchema.safeParse({ ...route(), apiKey: 'not-a-real-key' }).success).toBe(false);
    expect(GoogleDataConsentInputSchema.safeParse({ ...consentInput('123e4567-e89b-42d3-a456-426614174000'), content: 'private mail' }).success).toBe(false);
  });
  it.each(['https://API.example.invalid/v1/messages', 'https://api.example.invalid:443/v1/messages', 'https://api.example.invalid/v1/messages?key=fake', 'https://user:pass@api.example.invalid/v1/messages'])('rejects endpoint normalization or credentials: %s', endpoint => {
    expect(ResolvedGoogleRouteSchema.safeParse({ ...route(), endpoint }).success).toBe(false);
  });
  it('rejects unbounded and incomplete chains or model constraints', () => {
    expect(GoogleDataProfileInputSchema.safeParse({ ...profileInput(), allowedModels: Array(65).fill('model') }).success).toBe(false);
    expect(ResolvedGoogleRouteSchema.safeParse({ ...route(), recipientChain: [] }).success).toBe(false);
    expect(ResolvedGoogleRouteSchema.safeParse({ ...route(), providerAccountId: '' }).success).toBe(false);
  });
});

it('requires reviewed purpose restrictions, stable recipient IDs and a thirty-day maximum retention', () => {
  expect(GoogleDataProfileInputSchema.safeParse({ ...profileInput(), controls: { noTraining: false, noAdvertising: true, noSale: true, purposeLimited: true } }).success).toBe(false);
  expect(GoogleDataProfileInputSchema.safeParse({ ...profileInput(), disclosure: { ...profileInput().disclosure, recipients: [{ recipientId: 'other', name: 'Example processor', role: 'processor' }] } }).success).toBe(false);
  expect(GoogleDataProfileInputSchema.safeParse({ ...profileInput(), retention: { revision: 1, policyId: 'policy', mode: 'duration', maxAgeSeconds: 2592001 } }).success).toBe(false);
  expect(GoogleDataProfileInputSchema.safeParse({ ...profileInput(), retention: { revision: 1, policyId: 'policy', mode: 'until-deleted', maxAgeSeconds: null } }).success).toBe(false);
  expect(GoogleDataProfileInputSchema.safeParse({ ...profileInput(), disclosure: { ...profileInput().disclosure, purpose: 'fake\nnotice' } }).success).toBe(false);
});
