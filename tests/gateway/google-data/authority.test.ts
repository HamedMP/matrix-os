import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createGoogleDataAuthority } from '../../../packages/gateway/src/google-data/authority.js';
import { createAuthorityFixture } from './fixture-db.js';
import { accountId, consentInput, now, profileInput, route } from './fixtures.js';
let db: Awaited<ReturnType<typeof createAuthorityFixture>>['db'];
beforeEach(async () => { ({ db } = await createAuthorityFixture()); });
afterEach(async () => { await db.destroy(); });
const request = (profileId: string, overrides: Record<string, unknown> = {}) => ({ ownerId: 'owner-one', googleAccountId: accountId, purposeId: 'mail-assistance', profileId, dataKinds: ['gmail-content'], resolvedRoute: route(), ...overrides });
async function reviewed(credentialKind = 'managed') { return db.repository.reviewProfile(profileInput({ credentialKind }), 0); }
describe('durable Google data authority', () => {
  it.each(['managed', 'byo'])('requires independently recorded consent for the exact %s route', async credentialKind => {
    const profile = await reviewed(credentialKind);
    const authority = createGoogleDataAuthority(db.repository, { now: () => now });
    const input = request(profile.id, { resolvedRoute: route({ credentialKind }) });
    await expect(authority.assertAuthorized(input)).rejects.toMatchObject({ code: 'unavailable' });
    await db.repository.recordConsent(consentInput(profile.id), 0);
    const stamp = await authority.assertAuthorized(input);
    expect(stamp).toMatchObject({ profileId: profile.id, profileRevision: 1, consentRevision: 1, ownerId: 'owner-one', googleAccountId: accountId });
    expect(JSON.stringify(stamp)).not.toMatch(/fingerprint|verified-account-map|api\.example|referenceDigest/i);
    await expect(authority.revalidate(stamp, route({ credentialKind }))).resolves.toEqual(stamp);
  });
  it('discloses only a matching current owner route and never exposes approval metadata to a wrong owner', async () => {
    const profile = await reviewed(); const authority = createGoogleDataAuthority(db.repository, { now: () => now });
    const disclosure = await authority.disclose(request(profile.id));
    expect(disclosure).toMatchObject({ profileId: profile.id, disclosureRevision: 1, recipients: [{ recipientId: 'example-provider', name: 'Example processor', role: 'inference processor' }] });
    expect(JSON.stringify(disclosure)).not.toMatch(/credential|fingerprint|reviewer|referenceDigest|verified-account-map/);
    await expect(authority.disclose(request(profile.id, { ownerId: 'other' }))).rejects.toMatchObject({ code: 'unavailable' });
  });
  it.each([
    { providerId: 'other' }, { providerAccountId: 'other' }, { credentialGeneration: 'rotated' },
    { credentialFingerprint: 'c'.repeat(64) }, { endpoint: 'https://other.example.invalid/v1/messages' },
    { harnessId: 'other' }, { harnessRevision: 'new-build' }, { model: 'model-b' },
    { recipientChain: [...route().recipientChain, { recipientId: 'telemetry', accountId: 'telemetry-map', endpoint: 'https://telemetry.example.invalid/' }] },
  ])('denies changed resolved identity %j', async change => {
    const profile = await reviewed(); await db.repository.recordConsent(consentInput(profile.id), 0);
    const authority = createGoogleDataAuthority(db.repository, { now: () => now });
    await expect(authority.assertAuthorized(request(profile.id, { resolvedRoute: route(change) }))).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('binds consent to account, purpose, exact disclosure/retention/profile evidence and data kinds', async () => {
    const profile = await reviewed();
    for (const change of [{ profileRevision: 2 }, { evidenceRevision: 2 }, { disclosureRevision: 2 }, { retentionRevision: 2 }, { purposeId: 'other' }, { dataKinds: ['gmail-attachments'] }]) {
      await expect(db.repository.recordConsent(consentInput(profile.id, change), 0)).rejects.toBeDefined();
    }
    await db.repository.recordConsent(consentInput(profile.id), 0);
    const authority = createGoogleDataAuthority(db.repository, { now: () => now });
    await expect(authority.assertAuthorized(request(profile.id, { googleAccountId: '523e4567-e89b-42d3-a456-426614174000' }))).rejects.toMatchObject({ code: 'unavailable' });
    await expect(authority.assertAuthorized({ ...request(profile.id), approved: true, evidence: profile.input.evidence })).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('denies revoked, expired, revised or purged authority without caching an approval', async () => {
    const profile = await reviewed(); const consent = await db.repository.recordConsent(consentInput(profile.id), 0);
    const authority = createGoogleDataAuthority(db.repository, { now: () => now });
    const stamp = await authority.assertAuthorized(request(profile.id));
    await db.repository.revokeConsent({ ownerId: consent.input.ownerId, googleAccountId: consent.input.googleAccountId, purposeId: consent.input.purposeId, profileId: consent.input.profileId }, consent.revision);
    await expect(authority.revalidate(stamp, route())).rejects.toMatchObject({ code: 'unavailable' });
    await db.repository.recordConsent(consentInput(profile.id), 2);
    await expect(authority.revalidate(stamp, route())).rejects.toMatchObject({ code: 'unavailable' });
    const changed = profileInput(); changed.evidence.revision = 2; changed.disclosure.revision = 2;
    await db.repository.reviewProfile({ ...changed, id: profile.id }, 1);
    await expect(authority.assertAuthorized(request(profile.id))).rejects.toMatchObject({ code: 'unavailable' });
    await db.repository.deleteOwner('owner-one');
    await expect(authority.disclose(request(profile.id))).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('does not allow changing the original stamp route or accepting expired evidence/consent', async () => {
    const profile = await reviewed(); await db.repository.recordConsent(consentInput(profile.id), 0);
    const authority = createGoogleDataAuthority(db.repository, { now: () => now });
    const stamp = await authority.assertAuthorized(request(profile.id));
    await expect(authority.revalidate(stamp, route({ model: 'model-b' }))).rejects.toMatchObject({ code: 'unavailable' });
    const expired = createGoogleDataAuthority(db.repository, { now: () => new Date('2026-12-01T00:00:00Z') });
    await expect(expired.revalidate(stamp, route())).rejects.toMatchObject({ code: 'unavailable' });
    expect(await db.repository.cleanup(new Date('2026-12-10T00:00:00Z'))).toMatchObject({ profiles: 1 });
  });
  it('does not resurrect an old stamp when expired consent is purged then recorded again', async () => {
    const profile = await reviewed(); await db.repository.recordConsent(consentInput(profile.id), 0);
    const authority = createGoogleDataAuthority(db.repository, { now: () => now });
    const stamp = await authority.assertAuthorized(request(profile.id));
    expect(await db.repository.cleanup(new Date('2026-11-10T00:00:00Z'))).toEqual({ profiles: 0, consents: 1 });
    const replacement = await db.repository.recordConsent(consentInput(profile.id), 0);
    expect(replacement.revision).toBe(1); expect(replacement.id).not.toBe(stamp.consentId);
    await expect(authority.revalidate(stamp, route())).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('fails closed on malformed persisted review data without exposing it', async () => {
    const profile = await reviewed(); await db.repository.recordConsent(consentInput(profile.id), 0);
    await sql`UPDATE google_data_profiles SET payload=${JSON.stringify({ ...profile.input, secret: 'synthetic forbidden field' })}::jsonb WHERE id=${profile.id}`.execute(db.sql);
    const authority = createGoogleDataAuthority(db.repository, { now: () => now });
    await expect(authority.disclose(request(profile.id))).rejects.toMatchObject({ code: 'unavailable', message: 'Google data processing unavailable' });
    await expect(authority.assertAuthorized(request(profile.id))).rejects.toMatchObject({ code: 'unavailable' });
  });

});
