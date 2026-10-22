import { describe, expect, it, vi } from 'vitest';
import { createGoogleDataOwnerRoutes } from '../../packages/gateway/src/google-data/owner-routes.js';
import { profileInput } from './google-data/fixtures.js';

const account = '123e4567-e89b-42d3-a456-426614174000';
const profileId = '123e4567-e89b-42d3-a456-426614174001';
function setup(owner: string | null = 'owner-one', owns = true) {
  const reviewed = { id: profileId, revision: 1, status: 'reviewed' as const, input: profileInput() };
  const repository = { listReviewedProfiles: vi.fn(async () => [reviewed]), snapshot: vi.fn(async () => ({ profile: reviewed, consent: null })),
    recordConsent: vi.fn(async () => ({ id: '123e4567-e89b-42d3-a456-426614174002', revision: 1, status: 'active' })), revokeAccount: vi.fn(async () => 1) };
  const authority = { disclose: vi.fn(async () => ({ profileId, profileRevision: 1, googleAccountId: account,
    evidenceRevision: 1, disclosureRevision: 1, retentionRevision: 1, purposeId: 'mail-assistance', purpose: 'Help with email',
    recipients: [{ recipientId: 'example-provider', name: 'Example processor', role: 'Inference' }],
    retention: { revision: 1, policyId: 'retention', mode: 'duration', maxAgeSeconds: 86400 },
    dataKinds: ['gmail-metadata', 'gmail-content'], expiresAt: '2026-11-21T12:00:00.000Z' })) };
  const app = createGoogleDataOwnerRoutes({ repository, authority, resolveOwner: async () => owner,
    ownsGoogleAccount: vi.fn(async () => owns), now: () => new Date('2026-10-21T12:00:00.000Z') });
  return { app, repository, authority };
}
const accepted = { connectionId: account, profileId, profileRevision: 1, evidenceRevision: 1, disclosureRevision: 1,
  retentionRevision: 1, purposeId: 'mail-assistance', dataKinds: ['gmail-metadata', 'gmail-content'],
  expiresAt: '2026-10-22T12:00:00.000Z', expectedConsentRevision: 0, accepted: true };

describe('owner Gmail processing consent routes', () => {
  it('contains identity lookup failures without exposing private errors', async () => {
    const { repository, authority } = setup();
    const app = createGoogleDataOwnerRoutes({ repository, authority,
      resolveOwner: async () => { throw new Error('private database hostname'); },
      ownsGoogleAccount: async () => true });
    const response = await app.request(`/gmail/processing-profiles?connectionId=${account}`);
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).not.toContain('private database hostname');
    expect(repository.listReviewedProfiles).not.toHaveBeenCalled();
  });
  it('requires owner identity and exact Google account ownership before disclosure', async () => {
    for (const [owner, owns, status] of [[null, true, 401], ['owner-one', false, 404]] as const) {
      const { app, repository } = setup(owner, owns);
      expect((await app.request(`/gmail/processing-profiles?connectionId=${account}`)).status).toBe(status);
      expect(repository.listReviewedProfiles).not.toHaveBeenCalled();
    }
  });
  it('returns server disclosures with no credential or endpoint material and never grants consent on read', async () => {
    const { app, repository } = setup();
    const response = await app.request(`/gmail/processing-profiles?connectionId=${account}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.text();
    expect(body).toContain('Example processor');
    expect(body).not.toMatch(/credential|fingerprint|api\.example|verified-account-map/);
    expect(repository.recordConsent).not.toHaveBeenCalled();
  });
  it('records only an explicit, revision-bound owner action', async () => {
    const { app, repository } = setup();
    const response = await app.request('/gmail/processing-consents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(accepted) });
    expect(response.status).toBe(200);
    expect(repository.recordConsent).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'owner-one', googleAccountId: account, profileId, disclosureRevision: 1 }), 0);
    expect(repository.recordConsent.mock.calls[0]?.[0]).not.toHaveProperty('accepted');
  });
  it.each([{ accepted: false }, { accepted: undefined }, { ownerId: 'owner-other' }, { approved: true }, { resolvedRoute: {} }, { expiresAt: '2027-01-01T00:00:00.000Z' }])('refuses non-affirmative, forged or unbounded consent: %j', extra => {
    const { app, repository } = setup();
    return app.request('/gmail/processing-consents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...accepted, ...extra }) }).then(response => {
      expect([400, 409, 503]).toContain(response.status);
      expect(repository.recordConsent).not.toHaveBeenCalled();
    });
  });
  it('rejects a disclosure revision changed since display', async () => {
    const { app, repository } = setup();
    const response = await app.request('/gmail/processing-consents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...accepted, disclosureRevision: 2 }) });
    expect(response.status).toBe(409);
    expect(repository.recordConsent).not.toHaveBeenCalled();
  });
  it('revokes permission separately from retained-copy deletion and bounds DELETE bodies', async () => {
    const { app, repository } = setup();
    expect((await app.request(`/gmail/processing-consents/${account}`, { method: 'DELETE' })).status).toBe(200);
    expect(repository.revokeAccount).toHaveBeenCalledWith('owner-one', account);
    const response = await app.request(`/gmail/processing-consents/${account}`, { method: 'DELETE', body: 'x'.repeat(1025) });
    expect(response.status).toBe(413);
    expect(repository.revokeAccount).toHaveBeenCalledTimes(1);
  });
});
