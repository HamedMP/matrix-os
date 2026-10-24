import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { createAuthorityFixture } from './fixture-db.js';
import { profileInput, now } from './fixtures.js';
import { qualifiedRouteFixture } from '../../helpers/google-qualified-funded-fixture.js';
import { reviewGoogleProcessingProfile, profileReviewSubjectDigest } from '../../../packages/gateway/src/google-data/operator-review.js';
import { resolveGooglePolicyProfile, GOOGLE_POLICY_HARNESS_ID } from '../../../packages/gateway/src/google-data/runtime/profile-resolution.js';
import { googleManagedInferenceIdentity, googleManagedRouteDigest } from '../../../packages/gateway/src/google-data/managed/identity.js';
import type { ManagedPiRuntimeBinding } from '../../../packages/gateway/src/bots/runtime-registry.js';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const roles = ['terms', 'account-settings', 'route-probe', 'data-handling', 'deletion'];
const artifacts = roles.map(kind => ({ kind, path: `${kind}.json`, sha256: hash(JSON.stringify({ kind, fixture: 'shared synthetic evidence' })) }));
// The common evidence digest is independent of each owner's approval manifest.
const providerEvidenceDigest = hash(JSON.stringify(artifacts));
let db: Awaited<ReturnType<typeof createAuthorityFixture>>['db'] | undefined;
afterEach(async () => { await db?.destroy(); db = undefined; });
it('applies two owner-bound operator manifests to real Postgres and resolves both against one managed descriptor', async () => {
  ({ db } = await createAuthorityFixture());
  const qualified = qualifiedRouteFixture(); qualified.descriptor.evidence.referenceDigest = providerEvidenceDigest;
  qualified.digest = googleManagedRouteDigest(qualified.descriptor);
  const descriptor = qualified.descriptor;
  const binding: ManagedPiRuntimeBinding = { kind: 'managed_chat', runtimeHandle: `runtime_${'a'.repeat(32)}`, executionGeneration: '1', ownerId: 'owner-one', chatId: 'chat_one', runId: 'run_one',
    workspace: { kind: 'chat_workspace' }, rootFingerprint: 'c'.repeat(64), accessSourceId: 'matrix_included', requestClass: 'interactive', capabilities: ['artifact.read'],
    route: { api: 'openai-completions', modelId: qualified.canonicalModelId, input: ['text'], contextWindow: 128000, maxOutputTokens: 8192 } };
  const identity = googleManagedInferenceIdentity(binding, qualified);
  const rawHashes: string[] = [], ids: string[] = [];
  for (const ownerId of ['owner-one', 'owner-two']) {
    const profile = profileInput({ providerId: 'cloudflare', providerAccountId: descriptor.cloudflare.accountId, credentialKind: 'managed', credentialGeneration: descriptor.credential.generation,
      credentialFingerprint: descriptor.credential.fingerprint, endpoint: descriptor.upstream.endpoint, recipientChain: descriptor.recipientChain,
      harnessId: GOOGLE_POLICY_HARNESS_ID['openai-completions'], harnessRevision: identity.harnessVersion });
    profile.ownerId = ownerId; profile.allowedModels = [qualified.canonicalModelId];
    profile.evidence.referenceDigest = providerEvidenceDigest; profile.evidence.expiresAt = descriptor.evidence.expiresAt;
    profile.disclosure.recipients = [{ recipientId: 'cloudflare', name: 'Cloudflare', role: 'inference processor' }];
    const manifest = { version: 1, decision: 'approved', ownerId, reviewerId: profile.evidence.reviewerId, profileId: null, expectedRevision: 0,
      reviewedAt: profile.evidence.reviewedAt, expiresAt: profile.evidence.expiresAt, providerEvidenceDigest,
      subjectDigest: profileReviewSubjectDigest(profile), observedRoutes: [{ ...profile.binding, model: qualified.canonicalModelId }], artifacts };
    const manifestBytes = JSON.stringify(manifest); rawHashes.push(hash(manifestBytes));
    const applied = await reviewGoogleProcessingProfile({ profile, manifestBytes, expectedManifestDigest: hash(manifestBytes), expectedRevision: 0, apply: true }, {
      repository: db.repository, now: () => now, readArtifact: async name => JSON.stringify({ kind: name.slice(0, -5), fixture: 'shared synthetic evidence' }),
    });
    expect(applied.mode).toBe('applied');
    const resolved = await resolveGooglePolicyProfile(db.repository, ownerId, {
      runId: binding.runId, runtimeHandle: binding.runtimeHandle, executionGeneration: '1', accessSourceId: 'matrix_included', requestClass: 'interactive',
    }, identity, profile.purposeId, { resolveManagedRoute: async () => qualified, now: () => now });
    ids.push(resolved.profileId);
    expect((await db.repository.listReviewedProfiles(ownerId))[0]!.input.evidence.referenceDigest).toBe(providerEvidenceDigest);
  }
  expect(new Set(rawHashes).size).toBe(2); expect(new Set(ids).size).toBe(2);
});
it('binds the common provider evidence digest inside the full canonical subject', () => {
  const profile = profileInput();
  expect(profileReviewSubjectDigest({ ...profile, evidence: { ...profile.evidence, referenceDigest: 'd'.repeat(64) } }))
    .not.toBe(profileReviewSubjectDigest(profile));
});
