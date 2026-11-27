export const now = new Date('2026-10-21T12:00:00.000Z');
export const accountId = '123e4567-e89b-42d3-a456-426614174000';
export function route(overrides: Record<string, unknown> = {}) {
  return { providerId: 'example-provider', providerAccountId: 'verified-account-map', credentialKind: 'managed', credentialGeneration: 'generation-1', credentialFingerprint: 'a'.repeat(64), endpoint: 'https://api.example.invalid/v1/messages', model: 'model-a', harnessId: 'qualified-transport', harnessRevision: 'reviewed-build-1', recipientChain: [{ recipientId: 'example-provider', accountId: 'verified-account-map', endpoint: 'https://api.example.invalid/v1/messages' }], ...overrides };
}
export function profileInput(bindingOverrides: Record<string, unknown> = {}) {
  const { model: _model, ...binding } = route(bindingOverrides);
  return { ownerId: 'owner-one', binding, allowedModels: ['model-a'], controls: { noTraining: true, noAdvertising: true, noSale: true, purposeLimited: true }, purposeId: 'mail-assistance', dataKinds: ['gmail-metadata', 'gmail-content'], evidence: { revision: 1, referenceDigest: 'b'.repeat(64), reviewerId: 'operator-one', reviewedAt: now.toISOString(), expiresAt: '2026-11-21T12:00:00.000Z' }, disclosure: { revision: 1, recipients: [{ recipientId: 'example-provider', name: 'Example processor', role: 'inference processor' }], purpose: 'Help with your email' }, retention: { revision: 1, policyId: 'reviewed-retention-policy', mode: 'duration', maxAgeSeconds: 86400 } };
}
export function consentInput(profileId: string, overrides: Record<string, unknown> = {}) {
  return { ownerId: 'owner-one', googleAccountId: accountId, purposeId: 'mail-assistance', profileId, profileRevision: 1, evidenceRevision: 1, disclosureRevision: 1, retentionRevision: 1, dataKinds: ['gmail-metadata', 'gmail-content'], expiresAt: '2026-11-01T12:00:00.000Z', ...overrides };
}
