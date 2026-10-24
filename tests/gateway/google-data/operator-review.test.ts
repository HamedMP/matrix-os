import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { reviewGoogleProcessingProfile, profileReviewSubjectDigest, providerEvidenceBundleDigest } from '../../../packages/gateway/src/google-data/operator-review.js';
import { profileInput, route, now } from './fixtures.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function scene() {
  const profile = profileInput();
  const artifacts = ['terms', 'account-settings', 'route-probe', 'data-handling', 'deletion'].map(kind => ({
    kind, path: `${kind}.json`, sha256: sha(JSON.stringify({ kind, syntheticFixture: true })),
  }));
  profile.evidence.referenceDigest = providerEvidenceBundleDigest(artifacts);
  const manifest = { providerEvidenceDigest: profile.evidence.referenceDigest, version: 1, decision: 'approved', ownerId: profile.ownerId,
    profileId: null as string | null, expectedRevision: 0,
    reviewerId: profile.evidence.reviewerId, reviewedAt: profile.evidence.reviewedAt,
    expiresAt: profile.evidence.expiresAt, subjectDigest: profileReviewSubjectDigest(profile),
    observedRoutes: [route()], artifacts };
  const encode = () => JSON.stringify(manifest);
  const prepare = () => { const manifestBytes = encode(); return { profile, manifestBytes,
    expectedManifestDigest: sha(manifestBytes), expectedRevision: 0 }; };
  const repository = { reviewProfile: vi.fn(async (value: unknown) => ({ id: '123e4567-e89b-42d3-a456-426614174000',
    revision: 1, status: 'reviewed' as const, input: value })) };
  const readArtifact = vi.fn(async (name: string) => JSON.stringify({ kind: name.slice(0, -5), syntheticFixture: true }));
  return { profile, manifest, prepare, repository, readArtifact,
    deps: { repository, readArtifact, now: () => now } };
}

describe('operator Google profile review', () => {
  it('validates complete hashed evidence in dry-run without a registry write', async () => {
    const s = scene(); const result = await reviewGoogleProcessingProfile(s.prepare(), s.deps);
    expect(result).toMatchObject({ mode: 'dry-run', artifactCount: 5 });
    expect(s.repository.reviewProfile).not.toHaveBeenCalled();
  });
  it('applies only after explicit apply and preserves the repository CAS revision', async () => {
    const s = scene(); const input = { ...s.prepare(), apply: true };
    const result = await reviewGoogleProcessingProfile(input, s.deps);
    expect(result).toMatchObject({ mode: 'applied', revision: 1 });
    expect(s.repository.reviewProfile).toHaveBeenCalledExactlyOnceWith(input.profile, 0);
  });
  it.each(['terms', 'account-settings', 'route-probe', 'data-handling', 'deletion'])(
    'refuses missing %s evidence without writing', async kind => {
      const s = scene(); s.manifest.artifacts = s.manifest.artifacts.filter(a => a.kind !== kind);
      await expect(reviewGoogleProcessingProfile({ ...s.prepare(), apply: true }, s.deps)).rejects.toThrow();
      expect(s.repository.reviewProfile).not.toHaveBeenCalled();
    });
  it('refuses an unapproved review even if its artifact digests are valid', async () => {
    const s = scene(); s.manifest.decision = 'pending';
    await expect(reviewGoogleProcessingProfile(s.prepare(), s.deps)).rejects.toThrow();
  });
  it('refuses a substituted manifest and an artifact changed after review', async () => {
    const s = scene(); const input = s.prepare();
    await expect(reviewGoogleProcessingProfile({ ...input, manifestBytes: `${input.manifestBytes} ` }, s.deps)).rejects.toThrow();
    s.readArtifact.mockResolvedValue('changed');
    await expect(reviewGoogleProcessingProfile(input, s.deps)).rejects.toThrow();
    expect(s.repository.reviewProfile).not.toHaveBeenCalled();
  });
  it.each(['ownerId', 'reviewerId'] as const)('refuses mismatched %s', async key => {
    const s = scene(); s.manifest[key] = 'another-operator';
    await expect(reviewGoogleProcessingProfile(s.prepare(), s.deps)).rejects.toThrow();
  });
  it('refuses changed purpose, retention, recipients or model constraints after review', async () => {
    const s = scene(); const input = s.prepare();
    for (const profile of [{ ...input.profile, purposeId: 'another-purpose' },
      { ...input.profile, retention: { ...input.profile.retention, maxAgeSeconds: 60 } },
      { ...input.profile, allowedModels: ['another-model'] }]) {
      await expect(reviewGoogleProcessingProfile({ ...input, profile }, s.deps)).rejects.toThrow();
    }
  });
  it('requires an exact observed route for every approved model', async () => {
    const s = scene(); s.manifest.observedRoutes[0]!.credentialFingerprint = 'c'.repeat(64);
    await expect(reviewGoogleProcessingProfile(s.prepare(), s.deps)).rejects.toThrow();
  });
  it('refuses stale or future evidence and unsafe artifact paths', async () => {
    for (const transform of [
      (s: ReturnType<typeof scene>) => { s.manifest.expiresAt = now.toISOString(); },
      (s: ReturnType<typeof scene>) => { s.manifest.reviewedAt = '2026-10-22T12:00:00.000Z'; },
      (s: ReturnType<typeof scene>) => { s.manifest.artifacts[0]!.path = '../terms.json'; },
      (s: ReturnType<typeof scene>) => { s.manifest.artifacts[0]!.path = '/private/terms.json'; },
    ]) {
      const s = scene(); transform(s);
      await expect(reviewGoogleProcessingProfile(s.prepare(), s.deps)).rejects.toThrow();
    }
  });
  it('binds the reviewed target and CAS revision so approval cannot be replayed against another row', async () => {
    const s = scene(); const original = s.prepare();
    await expect(reviewGoogleProcessingProfile({ ...original, expectedRevision: 1 }, s.deps)).rejects.toThrow();
    s.manifest.profileId = '123e4567-e89b-42d3-a456-426614174099';
    await expect(reviewGoogleProcessingProfile(s.prepare(), s.deps)).rejects.toThrow();
    expect(s.repository.reviewProfile).not.toHaveBeenCalled();
  });
  it('binds updates to the exact profile ID and passes the expected revision through', async () => {
    const s = scene(); const id = '123e4567-e89b-42d3-a456-426614174000';
    const profile = { ...s.profile, id };
    s.manifest.profileId = id; s.manifest.expectedRevision = 3;
    s.manifest.subjectDigest = profileReviewSubjectDigest(profile);
    const manifestBytes = JSON.stringify(s.manifest);
    const input = { profile,
      manifestBytes, expectedManifestDigest: sha(manifestBytes), expectedRevision: 3, apply: true };
    s.repository.reviewProfile.mockResolvedValue({ id, revision: 4, status: 'reviewed', input: input.profile });
    await expect(reviewGoogleProcessingProfile(input, s.deps)).resolves.toMatchObject({ mode: 'applied', id, revision: 4 });
    expect(s.repository.reviewProfile).toHaveBeenCalledExactlyOnceWith(input.profile, 3);
  });
  it('recognizes the same UUID target returned in PostgreSQL canonical case after an update', async () => {
    const s = scene(); const id = '123e4567-e89b-42d3-a456-426614174000';
    const profile = { ...s.profile, id: id.toUpperCase() };
    s.manifest.profileId = profile.id; s.manifest.expectedRevision = 3;
    s.manifest.subjectDigest = profileReviewSubjectDigest(profile);
    const manifestBytes = JSON.stringify(s.manifest);
    const input = { profile,
      manifestBytes, expectedManifestDigest: sha(manifestBytes), expectedRevision: 3, apply: true };
    s.repository.reviewProfile.mockResolvedValue({ id, revision: 4, status: 'reviewed', input: input.profile });
    await expect(reviewGoogleProcessingProfile(input, s.deps)).resolves.toMatchObject({ mode: 'applied', id, revision: 4 });
  });
  it('requires unique roles and paths and refuses extra or oversized evidence', async () => {
    const s = scene(); s.manifest.artifacts[1] = { ...s.manifest.artifacts[0]! };
    await expect(reviewGoogleProcessingProfile(s.prepare(), s.deps)).rejects.toThrow();
    const t = scene(); t.readArtifact.mockResolvedValue('a'.repeat(1024 * 1024 + 1));
    await expect(reviewGoogleProcessingProfile(t.prepare(), t.deps)).rejects.toThrow();
    expect(t.repository.reviewProfile).not.toHaveBeenCalled();
  });
  it('canonicalizes subject object keys but keeps all approval constraints', () => {
    const s = scene(); const profile = s.profile;
    expect(profileReviewSubjectDigest({ ...profile, evidence: { ...profile.evidence, referenceDigest: 'd'.repeat(64) } }))
      .not.toBe(profileReviewSubjectDigest(profile));
    expect(profileReviewSubjectDigest(Object.fromEntries(Object.entries(profile).reverse()))).toBe(profileReviewSubjectDigest(profile));
  });
  it('does not convert a database failure or a stale revision into success', async () => {
    const s = scene(); s.repository.reviewProfile.mockRejectedValue(new Error('conflict'));
    await expect(reviewGoogleProcessingProfile({ ...s.prepare(), apply: true }, s.deps)).rejects.toThrow();
  });
});

it('computes a deterministic common evidence digest in role order and rejects ambiguous bundles', () => {
  const s = scene();
  expect(providerEvidenceBundleDigest([...s.manifest.artifacts].reverse())).toBe(s.manifest.providerEvidenceDigest);
  expect(() => providerEvidenceBundleDigest([...s.manifest.artifacts.slice(0, 4), s.manifest.artifacts[0]])).toThrow();
});
it('refuses a valid raw manifest pinned to a substituted common evidence bundle', async () => {
  const s = scene(); s.manifest.providerEvidenceDigest = 'd'.repeat(64);
  await expect(reviewGoogleProcessingProfile(s.prepare(), s.deps)).rejects.toThrow();
  expect(s.repository.reviewProfile).not.toHaveBeenCalled();
});
