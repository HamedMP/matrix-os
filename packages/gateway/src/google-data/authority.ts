import { GoogleDataAuthorityError, GoogleDataRequestSchema, GoogleDataStampSchema, ResolvedGoogleRouteSchema, routeDigest, routeMatchesProfile,
  type GoogleDataRequest, type GoogleDataStamp } from './profiles.js';
import type { GoogleDataRepository, ReviewedGoogleProfile } from './repository.js';

/** No provider defaults or approval cache. Inputs come from authenticated server composition. */
export function createGoogleDataAuthority(repository: GoogleDataRepository, options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  async function lookup(value: unknown) {
    const parsed = GoogleDataRequestSchema.safeParse(value);
    if (!parsed.success) throw new GoogleDataAuthorityError();
    const request = parsed.data;
    const snapshot = await repository.snapshot({ ownerId: request.ownerId, googleAccountId: request.googleAccountId,
      purposeId: request.purposeId, profileId: request.profileId });
    const profile = snapshot.profile;
    // Read the clock after the awaited durable lookup; queue time cannot extend authority.
    const at = now().getTime();
    if (!profile || profile.status !== 'reviewed' || profile.input.ownerId !== request.ownerId
      || profile.input.purposeId !== request.purposeId || Date.parse(profile.input.evidence.reviewedAt) > at
      || Date.parse(profile.input.evidence.expiresAt) <= at || !routeMatchesProfile(request.resolvedRoute, profile.input)
      || request.dataKinds.some(kind => !profile.input.dataKinds.includes(kind))) throw new GoogleDataAuthorityError();
    return { request, profile, consent: snapshot.consent, at };
  }
  const disclosure = (request: GoogleDataRequest, profile: ReviewedGoogleProfile) => ({
    profileId: profile.id, profileRevision: profile.revision, googleAccountId: request.googleAccountId,
    evidenceRevision: profile.input.evidence.revision, disclosureRevision: profile.input.disclosure.revision,
    retentionRevision: profile.input.retention.revision, purposeId: request.purposeId,
    purpose: profile.input.disclosure.purpose, recipients: profile.input.disclosure.recipients,
    dataKinds: request.dataKinds, retention: profile.input.retention, expiresAt: profile.input.evidence.expiresAt,
  });
  async function assertAuthorized(value: unknown): Promise<GoogleDataStamp> {
    const { request, profile, consent, at } = await lookup(value);
    if (!consent || consent.status !== 'active' || consent.input.ownerId !== request.ownerId
      || consent.input.googleAccountId !== request.googleAccountId || consent.input.purposeId !== request.purposeId
      || consent.input.profileId !== profile.id || consent.input.profileRevision !== profile.revision
      || consent.input.evidenceRevision !== profile.input.evidence.revision
      || consent.input.disclosureRevision !== profile.input.disclosure.revision
      || consent.input.retentionRevision !== profile.input.retention.revision
      || Date.parse(consent.input.expiresAt) <= at || request.dataKinds.some(kind => !consent.input.dataKinds.includes(kind))) throw new GoogleDataAuthorityError();
    return GoogleDataStampSchema.parse({
      ownerId: request.ownerId, googleAccountId: request.googleAccountId, purposeId: request.purposeId,
      profileId: profile.id, profileRevision: profile.revision, evidenceRevision: profile.input.evidence.revision,
      disclosureRevision: profile.input.disclosure.revision, retentionRevision: profile.input.retention.revision,
      consentId: consent.id, consentRevision: consent.revision, dataKinds: request.dataKinds,
      routeDigest: routeDigest(request.resolvedRoute),
      expiresAt: new Date(Math.min(Date.parse(profile.input.evidence.expiresAt), Date.parse(consent.input.expiresAt))).toISOString(),
    });
  }
  return {
    async disclose(value: unknown) { const { request, profile } = await lookup(value); return disclosure(request, profile); },
    assertAuthorized,
    async revalidate(value: unknown, resolvedValue: unknown): Promise<GoogleDataStamp> {
      const parsed = GoogleDataStampSchema.safeParse(value);
      const route = ResolvedGoogleRouteSchema.safeParse(resolvedValue);
      if (!parsed.success || !route.success || Date.parse(parsed.data.expiresAt) <= now().getTime()
        || routeDigest(route.data) !== parsed.data.routeDigest) throw new GoogleDataAuthorityError();
      const stamp = parsed.data;
      const current = await assertAuthorized({ ownerId: stamp.ownerId, googleAccountId: stamp.googleAccountId,
        purposeId: stamp.purposeId, profileId: stamp.profileId, dataKinds: stamp.dataKinds, resolvedRoute: route.data });
      if (JSON.stringify(current) !== JSON.stringify(stamp)) throw new GoogleDataAuthorityError();
      return current;
    },
  };
}
export type GoogleDataAuthority = ReturnType<typeof createGoogleDataAuthority>;
