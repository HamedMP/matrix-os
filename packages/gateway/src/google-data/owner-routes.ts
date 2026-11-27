import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod/v4';
import { GoogleDataAuthorityError, GoogleDataConsentInputSchema } from './profiles.js';
import type { GoogleDataAuthority } from './authority.js';
import type { GoogleDataRepository } from './repository.js';

const Consent = GoogleDataConsentInputSchema.omit({ ownerId: true, googleAccountId: true }).extend({
  connectionId: z.uuid(), accepted: z.literal(true),
  expectedConsentRevision: z.number().int().min(0).max(2_147_483_645),
});
type Repository = Pick<GoogleDataRepository, 'listReviewedProfiles' | 'snapshot' | 'recordConsent' | 'revokeAccount'>;

/** Owner-facing disclosure/permission only. No profile review API or runtime
 * authorization is exposed. Dispatch still requires the actual server-resolved
 * route, active consent and run authority at collection and inference egress. */
export function createGoogleDataOwnerRoutes(options: {
  repository: Repository;
  authority: Pick<GoogleDataAuthority, 'disclose'>;
  resolveOwner(c: Context): Promise<string | null>;
  ownsGoogleAccount(ownerId: string, connectionId: string): Promise<boolean>;
  now?: () => Date;
}) {
  const app = new Hono();
  const now = options.now ?? (() => new Date());
  const tooLarge = (c: Context) => {
    c.header('Cache-Control', 'no-store');
    return c.json({ error: 'Request too large' }, 413);
  };
  const failure = (c: Context, error: unknown) => {
    if (error instanceof GoogleDataAuthorityError) return c.json({ error: 'Gmail data settings unavailable' }, error.code === 'conflict' ? 409 : error.code === 'capacity' ? 429 : 503);
    console.warn('[google-data] Owner settings unavailable:', error instanceof Error ? error.name : 'UnknownError');
    return c.json({ error: 'Gmail data settings unavailable' }, 503);
  };
  app.onError((error, c) => {
    c.header('Cache-Control', 'no-store');
    if (error.name === 'BodyLimitError') return tooLarge(c);
    return failure(c, error);
  });
  app.get('/gmail/processing-profiles', async c => {
    c.header('Cache-Control', 'no-store');
    const ownerId = await options.resolveOwner(c);
    if (!ownerId) return c.json({ error: 'Unauthorized' }, 401);
    const query = new URL(c.req.url).searchParams;
    const parsed = z.uuid().safeParse(query.get('connectionId'));
    if (!parsed.success || query.getAll('connectionId').length !== 1 || [...query.keys()].some(key => key !== 'connectionId')) return c.json({ error: 'Invalid request' }, 400);
    try {
      if (!await options.ownsGoogleAccount(ownerId, parsed.data)) return c.json({ error: 'Gmail account unavailable' }, 404);
      const profiles = await options.repository.listReviewedProfiles(ownerId);
      const disclosures = [];
      for (const profile of profiles) {
        // This describes an operator-reviewed target; it does not assert that
        // the currently running provider actually uses that target.
        const disclosure = await options.authority.disclose({ ownerId, googleAccountId: parsed.data,
          purposeId: profile.input.purposeId, profileId: profile.id, dataKinds: profile.input.dataKinds,
          resolvedRoute: { ...profile.input.binding, model: profile.input.allowedModels[0]! } });
        const { consent } = await options.repository.snapshot({ ownerId, googleAccountId: parsed.data,
          purposeId: profile.input.purposeId, profileId: profile.id });
        disclosures.push({ ...disclosure, connectionType: profile.input.binding.credentialKind,
          consentRevision: consent?.revision ?? 0,
          consentActive: consent?.status === 'active' && consent.input.profileRevision === profile.revision
            && consent.input.evidenceRevision === profile.input.evidence.revision
            && consent.input.disclosureRevision === profile.input.disclosure.revision
            && consent.input.retentionRevision === profile.input.retention.revision
            && profile.input.dataKinds.every(kind => consent.input.dataKinds.includes(kind))
            && Date.parse(consent.input.expiresAt) > now().getTime() });
      }
      return c.json({ profiles: disclosures });
    } catch (error: unknown) { return failure(c, error); }
  });
  app.post('/gmail/processing-consents', bodyLimit({ maxSize: 4096, onError: tooLarge }), async c => {
    c.header('Cache-Control', 'no-store');
    const ownerId = await options.resolveOwner(c);
    if (!ownerId) return c.json({ error: 'Unauthorized' }, 401);
    if (c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return c.json({ error: 'Invalid request' }, 400);
    let body: unknown;
    try { body = await c.req.json(); }
    catch (error: unknown) {
      if (error instanceof Error && error.name === 'BodyLimitError') return tooLarge(c);
      if (!(error instanceof SyntaxError)) console.warn('[google-data] Consent request unavailable:', error instanceof Error ? error.name : 'UnknownError');
      return c.json({ error: 'Invalid request' }, 400);
    }
    const parsed = Consent.safeParse(body);
    if (!parsed.success) return c.json({ error: 'Invalid request' }, 400);
    try {
      const { connectionId, accepted: _accepted, expectedConsentRevision, ...requested } = parsed.data;
      if (!await options.ownsGoogleAccount(ownerId, connectionId)) return c.json({ error: 'Gmail account unavailable' }, 404);
      const profiles = await options.repository.listReviewedProfiles(ownerId);
      const profile = profiles.find(item => item.id === requested.profileId);
      if (!profile || profile.revision !== requested.profileRevision || profile.input.purposeId !== requested.purposeId
        || profile.input.evidence.revision !== requested.evidenceRevision || profile.input.disclosure.revision !== requested.disclosureRevision
        || profile.input.retention.revision !== requested.retentionRevision) return c.json({ error: 'Gmail data notice changed. Review it again.' }, 409);
      const at = now().getTime();
      if (Date.parse(requested.expiresAt) <= at || Date.parse(requested.expiresAt) > at + 30 * 86400_000) return c.json({ error: 'Invalid request' }, 400);
      // Repository checks these revisions again under its database locks.
      const recorded = await options.repository.recordConsent({ ...requested, ownerId, googleAccountId: connectionId }, expectedConsentRevision);
      return c.json({ consentRevision: recorded.revision, consentActive: true });
    } catch (error: unknown) { return failure(c, error); }
  });
  app.delete('/gmail/processing-consents/:connectionId', bodyLimit({ maxSize: 1024, onError: tooLarge }), async c => {
    c.header('Cache-Control', 'no-store');
    const ownerId = await options.resolveOwner(c);
    if (!ownerId) return c.json({ error: 'Unauthorized' }, 401);
    const parsed = z.uuid().safeParse(c.req.param('connectionId'));
    if (!parsed.success) return c.json({ error: 'Invalid request' }, 400);
    try {
      // Trigger the middleware's streaming limit even when DELETE ignores its body.
      await c.req.arrayBuffer();
      if (!await options.ownsGoogleAccount(ownerId, parsed.data)) return c.json({ error: 'Gmail account unavailable' }, 404);
      await options.repository.revokeAccount(ownerId, parsed.data);
      return c.json({ revoked: true });
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'BodyLimitError') return tooLarge(c);
      return failure(c, error);
    }
  });
  return app;
}
