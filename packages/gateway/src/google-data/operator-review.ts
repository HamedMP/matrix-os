import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import { GoogleDataProfileInputSchema, ResolvedGoogleRouteSchema, routeMatchesProfile } from './profiles.js';

export const GOOGLE_REVIEW_MAX_BYTES = 1024 * 1024;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().min(0).max(2_147_483_645);
export const GoogleReviewFilenameSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
const profileSchema = GoogleDataProfileInputSchema.safeExtend({ id: z.uuid().optional() });
const roles = ['terms', 'account-settings', 'route-probe', 'data-handling', 'deletion'] as const;
const artifactSchema = z.strictObject({ kind: z.enum(roles), path: GoogleReviewFilenameSchema, sha256: digest });
const artifactsSchema = z.array(artifactSchema).length(roles.length);
const manifestSchema = z.strictObject({
  version: z.literal(1), decision: z.literal('approved'),
  profileId: z.uuid().nullable(), expectedRevision: revision,
  ownerId: z.string().min(1).max(160), reviewerId: z.string().min(1).max(160),
  reviewedAt: z.iso.datetime(), expiresAt: z.iso.datetime(), subjectDigest: digest, providerEvidenceDigest: digest,
  observedRoutes: z.array(ResolvedGoogleRouteSchema).min(1).max(64),
  artifacts: artifactsSchema,
});
const requestSchema = z.strictObject({
  profile: z.unknown(), manifestBytes: z.unknown(), expectedManifestDigest: digest,
  expectedRevision: revision, apply: z.boolean().optional(),
});

export class GoogleProcessingReviewError extends Error {
  constructor() { super('Google processing review unavailable'); this.name = 'GoogleProcessingReviewError'; }
}
function deny(): never { throw new GoogleProcessingReviewError(); }
export function boundedGoogleReviewBytes(value: unknown): Uint8Array {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value instanceof Uint8Array ? value : deny();
  if (bytes.byteLength === 0 || bytes.byteLength > GOOGLE_REVIEW_MAX_BYTES) deny();
  return bytes;
}
function sha(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function parseProfile(value: unknown) {
  boundedGoogleReviewBytes(JSON.stringify(value));
  return profileSchema.parse(value);
}

/** Common provider bundle identity. Role order and record keys are fixed; owner approval metadata is excluded. */
export function providerEvidenceBundleDigest(value: unknown): string {
  try {
    const artifacts = artifactsSchema.parse(value);
    if (new Set(artifacts.map(artifact => artifact.kind)).size !== roles.length
      || new Set(artifacts.map(artifact => artifact.path)).size !== roles.length) deny();
    const ordered = roles.map(kind => {
      const artifact = artifacts.find(candidate => candidate.kind === kind)!;
      return { kind: artifact.kind, path: artifact.path, sha256: artifact.sha256 };
    });
    return sha(Buffer.from(JSON.stringify(ordered), 'utf8'));
  } catch (error: unknown) { if (error instanceof GoogleProcessingReviewError) throw error; throw new GoogleProcessingReviewError(); }
}

/** Full profile subject, including the common provider evidence digest. The independent raw-manifest hash is external. */
export function profileReviewSubjectDigest(value: unknown): string {
  try {
    const profile = parseProfile(value);
    return sha(Buffer.from(canonical(profile), 'utf8'));
  } catch (error: unknown) {
    if (error instanceof GoogleProcessingReviewError) throw error;
    throw new GoogleProcessingReviewError();
  }
}
export interface GoogleProcessingReviewDependencies {
  repository: { reviewProfile(value: unknown, expectedRevision: number): Promise<{ id: string; revision: number; status: 'reviewed' | 'revoked' }> };
  readArtifact(name: string): Promise<string | Uint8Array>;
  now?: () => Date;
}

/** Privileged operator tooling only. Hashes bind a human review; they do not establish provider approval or owner consent. */
export async function reviewGoogleProcessingProfile(value: unknown, dependencies: GoogleProcessingReviewDependencies) {
  try {
    const input = requestSchema.parse(value);
    const profile = parseProfile(input.profile);
    const bytes = boundedGoogleReviewBytes(input.manifestBytes);
    const manifestDigest = sha(bytes);
    if (manifestDigest !== input.expectedManifestDigest) deny();
    const manifest = manifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    const providerEvidenceDigest = providerEvidenceBundleDigest(manifest.artifacts);
    if (manifest.providerEvidenceDigest !== providerEvidenceDigest || profile.evidence.referenceDigest !== providerEvidenceDigest) deny();
    const at = (dependencies.now ?? (() => new Date()))().getTime();
    const reviewedAt = Date.parse(manifest.reviewedAt), expiresAt = Date.parse(manifest.expiresAt);
    if (!Number.isFinite(at) || reviewedAt > at || expiresAt <= at || expiresAt > at + 365 * 86_400_000
      || manifest.ownerId !== profile.ownerId || manifest.reviewerId !== profile.evidence.reviewerId
      || manifest.reviewedAt !== profile.evidence.reviewedAt || manifest.expiresAt !== profile.evidence.expiresAt
      || manifest.subjectDigest !== profileReviewSubjectDigest(profile)
      || manifest.expectedRevision !== input.expectedRevision || manifest.profileId !== (profile.id ?? null)
      || ((input.expectedRevision === 0) !== (profile.id === undefined))) deny();
    if (manifest.observedRoutes.length !== profile.allowedModels.length
      || new Set(manifest.observedRoutes.map(route => route.model)).size !== profile.allowedModels.length
      || manifest.observedRoutes.some(route => !routeMatchesProfile(route, profile))
      || new Set(manifest.artifacts.map(artifact => artifact.kind)).size !== roles.length
      || new Set(manifest.artifacts.map(artifact => artifact.path)).size !== roles.length) deny();
    for (const artifact of manifest.artifacts) {
      if (sha(boundedGoogleReviewBytes(await dependencies.readArtifact(artifact.path))) !== artifact.sha256) deny();
    }
    const summary = { artifactCount: roles.length, manifestDigest, providerEvidenceDigest, subjectDigest: manifest.subjectDigest,
      ownerId: profile.ownerId, expectedRevision: input.expectedRevision, profileId: profile.id ?? null, expiresAt: manifest.expiresAt };
    if (input.apply !== true) return { ...summary, mode: 'dry-run' as const };
    const reviewed = await dependencies.repository.reviewProfile(profile, input.expectedRevision);
    if (!z.uuid().safeParse(reviewed.id).success || reviewed.revision !== input.expectedRevision + 1
      || reviewed.status !== 'reviewed' || (profile.id !== undefined && reviewed.id.toLowerCase() !== profile.id.toLowerCase())) deny();
    return { ...summary, mode: 'applied' as const, id: reviewed.id, revision: reviewed.revision };
  } catch (error: unknown) {
    if (error instanceof GoogleProcessingReviewError) throw error;
    if (!(error instanceof z.ZodError) && !(error instanceof SyntaxError) && !(error instanceof TypeError)) {
      console.warn('[google-data] Operator review failed:', error instanceof Error ? 'operation_failed' : 'untyped_failure');
    }
    throw new GoogleProcessingReviewError();
  }
}
