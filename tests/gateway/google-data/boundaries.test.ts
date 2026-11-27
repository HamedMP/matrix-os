import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createGoogleDataAuthority } from '../../../packages/gateway/src/google-data/authority.js';
import { createGoogleDataRepository } from '../../../packages/gateway/src/google-data/repository.js';
import { ResolvedGoogleRouteSchema } from '../../../packages/gateway/src/google-data/profiles.js';
import { createAuthorityFixture } from './fixture-db.js';
import { accountId, consentInput, now, profileInput, route } from './fixtures.js';
let db: Awaited<ReturnType<typeof createAuthorityFixture>>['db'];
beforeEach(async () => { ({ db } = await createAuthorityFixture()); });
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await db.destroy(); });
it('rejects operator identity/revision and evidence-window mistakes', async () => {
  const profile = await db.repository.reviewProfile(profileInput(), 0);
  await expect(db.repository.reviewProfile({ ...profileInput(), id: profile.id }, 0)).rejects.toMatchObject({ code: 'conflict' });
  await expect(db.repository.reviewProfile(profileInput(), 1)).rejects.toMatchObject({ code: 'conflict' });
  await expect(db.repository.reviewProfile({ ...profileInput(), id: profile.id }, 4)).rejects.toMatchObject({ code: 'conflict' });
  for (const evidence of [{ reviewedAt: '2027-01-01T00:00:00Z' }, { expiresAt: now.toISOString() }, { expiresAt: '2028-01-01T00:00:00Z' }]) {
    const input = profileInput(); Object.assign(input.evidence, evidence);
    await expect(db.repository.reviewProfile(input, 0)).rejects.toMatchObject({ code: 'unavailable' });
  }
  await expect(db.repository.revokeProfile(profile.id, 'other', 1)).rejects.toMatchObject({ code: 'conflict' });
  await expect(db.repository.revokeConsent({ ...consentInput(profile.id), profileRevision: undefined }, 1)).rejects.toMatchObject({ code: 'unavailable' });
  await expect(db.repository.revokeConsent({ ownerId: 'owner-one', googleAccountId: accountId, purposeId: 'mail-assistance', profileId: profile.id }, 1)).rejects.toMatchObject({ code: 'conflict' });
});
it('bounds consent rows per owner before any new admission', async () => {
  const profile = await db.repository.reviewProfile(profileInput(), 0);
  await sql`INSERT INTO google_data_consents(id,owner_id,google_account_id,purpose_id,profile_id,revision,status,payload,expires_at,updated_at)
    SELECT gen_random_uuid(),'owner-one',gen_random_uuid(),'mail-assistance',${profile.id},1,'active',${JSON.stringify(consentInput(profile.id))}::jsonb,${new Date('2026-11-01T00:00:00Z')},${now} FROM generate_series(1,1000)`.execute(db.sql);
  await expect(db.repository.recordConsent(consentInput(profile.id), 0)).rejects.toMatchObject({ code: 'capacity' });
});
it('lists current reviews without granting consent and rejects corrupt over-cap storage', async () => {
  const profile = await db.repository.reviewProfile(profileInput(), 0);
  expect(await db.repository.listReviewedProfiles('owner-one')).toEqual([profile]);
  await sql`INSERT INTO google_data_profiles(id,owner_id,revision,status,payload,expires_at,updated_at)
    SELECT gen_random_uuid(),'owner-one',1,'reviewed',${JSON.stringify(profileInput())}::jsonb,${new Date('2026-11-21T12:00:00Z')},${now} FROM generate_series(1,100)`.execute(db.sql);
  await expect(db.repository.listReviewedProfiles('owner-one')).rejects.toMatchObject({ code: 'capacity' });
});
it('uses the real clock when composition does not inject a test clock', async () => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  const repository = createGoogleDataRepository(db.sql);
  const profile = await repository.reviewProfile(profileInput(), 0);
  await repository.recordConsent(consentInput(profile.id), 0);
  await expect(createGoogleDataAuthority(repository).assertAuthorized({ ownerId: 'owner-one', googleAccountId: accountId, purposeId: 'mail-assistance', profileId: profile.id, dataKinds: ['gmail-content'], resolvedRoute: route() })).resolves.toMatchObject({ profileId: profile.id });
  await repository.close();
});
it('runs recurring cleanup and drains it before closing without owning the pool', async () => {
  vi.useFakeTimers(); const intervals = vi.spyOn(globalThis, 'setInterval');
  const clear = vi.spyOn(globalThis, 'clearInterval'); db.repository.startCleanup();
  const registryTimer = intervals.mock.results[0]!.value;
  await vi.advanceTimersByTimeAsync(300000);
  await db.repository.close();
  expect(clear).toHaveBeenCalledWith(registryTimer);
  expect((await sql`SELECT 1 AS alive`.execute(db.sql)).rows).toEqual([{ alive: 1 }]);
});
it('contains cleanup/database failures and leaves a retryable safe state', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const transaction = vi.spyOn(db.sql, 'transaction').mockImplementation(() => { throw new Error('synthetic private database failure'); });
  await expect(db.repository.cleanup()).rejects.toMatchObject({ code: 'unavailable', message: 'Google data processing unavailable' });
  vi.useFakeTimers(); db.repository.startCleanup(); await vi.advanceTimersByTimeAsync(300000); await db.repository.close();
  expect(warning.mock.calls.flat().join(' ')).not.toContain('synthetic private');
  transaction.mockRestore();
  expect((await sql`SELECT 1 AS alive`.execute(db.sql)).rows).toEqual([{ alive: 1 }]);
});
it('rejects malformed URLs and accepts exact explicitly reviewed loopback transport identities', () => {
  expect(ResolvedGoogleRouteSchema.safeParse(route({ endpoint: 'not-a-url' })).success).toBe(false);
  for (const endpoint of ['http://127.0.0.1:8080/v1/messages', 'http://[::1]:8080/v1/messages']) {
    const candidate = route({ endpoint }); candidate.recipientChain[0]!.endpoint = endpoint;
    expect(ResolvedGoogleRouteSchema.safeParse(candidate).success).toBe(true);
  }
});
