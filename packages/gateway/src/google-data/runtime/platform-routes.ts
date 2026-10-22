import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod/v4';
import { createGoogleDataAuthority } from '../authority.js';
import { GoogleDataAuthorityError, routeDigest } from '../profiles.js';
import type { GoogleDataRepository, RecordedGoogleConsent, ReviewedGoogleProfile } from '../repository.js';
import { GooglePolicyAuthorizeSchema, GooglePolicyRevalidateSchema, resolveGooglePolicyProfile, type GooglePolicyAuthorizeInput } from './profile-resolution.js';

export interface GooglePolicyRuntimePrincipal { ownerId: string; machineId: string }
export interface GooglePlatformPolicyDependencies {
  repository: GoogleDataRepository;
  /** Must require real machine authentication AND verified signed-owner delegation.
   * The gateway must validate its live registry/run/generation before sending facts.
   * Legacy owner headers, public sessions and model claims are insufficient. */
  resolveRuntime(c: Context): Promise<GooglePolicyRuntimePrincipal | null>;
  ownsGmailAccount(ownerId: string, googleAccountId: string): Promise<boolean>;
  now?: () => Date;
}
function covers(recorded: RecordedGoogleConsent | null, profile: ReviewedGoogleProfile, request: GooglePolicyAuthorizeInput, at: number) {
  if (!recorded || recorded.status !== 'active') return false;
  const consent = recorded.input;
  return consent.ownerId === profile.input.ownerId && consent.profileId === profile.id && consent.googleAccountId === request.googleAccountId
    && consent.purposeId === request.purposeId && consent.profileRevision === profile.revision
    && consent.evidenceRevision === profile.input.evidence.revision && consent.disclosureRevision === profile.input.disclosure.revision
    && consent.retentionRevision === profile.input.retention.revision && Date.parse(consent.expiresAt) > at
    && request.dataKinds.every(kind => consent.dataKinds.includes(kind));
}
/** Internal machine routes only. No collection, consent mutation or approval inference. */
export function createGooglePlatformPolicyRoutes(deps: GooglePlatformPolicyDependencies) {
  const app = new Hono(); const now = deps.now ?? (() => new Date());
  const authority = createGoogleDataAuthority(deps.repository, { now });
  const limit = bodyLimit({ maxSize: 16384, onError: c => c.json({ error: 'invalid_request' }, 413) });
  for (const action of ['authorize', 'revalidate'] as const) app.post(`/gmail/processing/${action}`, limit, async c => {
    try {
      const principal = await deps.resolveRuntime(c);
      if (!principal) return c.json({ error: 'unauthorized' }, 401);
      const auth = z.strictObject({ ownerId: z.string().min(1).max(160), machineId: z.string().min(1).max(160) }).safeParse(principal);
      if (!auth.success) throw new GoogleDataAuthorityError();
      let raw: unknown;
      try { raw = await c.req.json(); } catch (error) { if (error instanceof SyntaxError) return c.json({ error: 'invalid_request' }, 400); throw error; }
      const parsed = action === 'authorize' ? GooglePolicyAuthorizeSchema.safeParse(raw) : GooglePolicyRevalidateSchema.safeParse(raw);
      if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
      const input = parsed.data;
      if (!await deps.ownsGmailAccount(auth.data.ownerId, input.googleAccountId)) return c.json({ error: 'unavailable' }, 403);
      const resolved = await resolveGooglePolicyProfile(deps.repository, auth.data.ownerId, input.binding, input.identity, input.purposeId);
      const request = { ownerId: auth.data.ownerId, googleAccountId: input.googleAccountId, purposeId: input.purposeId,
        profileId: resolved.profileId, dataKinds: input.dataKinds, resolvedRoute: resolved.route };
      const finish = async (payload: Record<string, unknown>, status: 200 | 428 = 200) => {
        if (!await deps.ownsGmailAccount(auth.data.ownerId, input.googleAccountId)) return c.json({ error: 'unavailable' }, 403);
        return c.json(payload, status);
      };
      if (action === 'revalidate') {
        const original = GooglePolicyRevalidateSchema.parse(input).stamp;
        if (original.ownerId !== auth.data.ownerId || original.googleAccountId !== input.googleAccountId || original.purposeId !== input.purposeId
          || original.profileId !== resolved.profileId || original.routeDigest !== routeDigest(resolved.route)
          || JSON.stringify(original.dataKinds) !== JSON.stringify(input.dataKinds)) throw new GoogleDataAuthorityError();
        return await finish({ stamp: await authority.revalidate(original, resolved.route), resolvedRoute: resolved.route });
      }
      // Inspect durable consent explicitly. A generic authority/storage failure must
      // never be relabelled as missing consent. Re-read profile before disclosing.
      const snapshot = await deps.repository.snapshot({ ownerId: request.ownerId, googleAccountId: request.googleAccountId, purposeId: request.purposeId, profileId: request.profileId });
      const disclosure = await authority.disclose(request);
      if (!snapshot.profile || snapshot.profile.revision !== disclosure.profileRevision) throw new GoogleDataAuthorityError();
      if (!covers(snapshot.consent, snapshot.profile, input, now().getTime())) return await finish({ error: 'consent_required', disclosure, consentRevision: snapshot.consent?.revision ?? 0 }, 428);
      return await finish({ stamp: await authority.assertAuthorized(request), resolvedRoute: resolved.route });
    } catch (error) {
      if (error instanceof Error && error.name === 'BodyLimitError') return c.json({ error: 'invalid_request' }, 413);
      if (!(error instanceof GoogleDataAuthorityError || error instanceof z.ZodError)) console.warn('[google-data] Platform policy unavailable:', error instanceof Error ? error.name : 'UnknownError');
      return c.json({ error: 'unavailable' }, 503);
    }
  });
  return app;
}
