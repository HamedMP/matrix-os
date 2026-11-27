import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createGoogleDataAuthority } from '../../../packages/gateway/src/google-data/authority.js';
import { createAuthorityFixture } from './fixture-db.js';
import { accountId, consentInput, now, profileInput, route } from './fixtures.js';
let db: Awaited<ReturnType<typeof createAuthorityFixture>>['db'];
beforeEach(async () => { ({ db } = await createAuthorityFixture()); });
afterEach(async () => { vi.useRealTimers(); await db.destroy(); });
it('bounds owner profiles, cleans expired metadata and does not preapprove replacements', async () => {
  await sql`INSERT INTO google_data_profiles(id,owner_id,revision,status,payload,expires_at,updated_at)
    SELECT gen_random_uuid(),'owner-one',1,'reviewed',${JSON.stringify(profileInput())}::jsonb,${new Date('2026-11-21T12:00:00Z')},${now} FROM generate_series(1,100)`.execute(db.sql);
  await expect(db.repository.reviewProfile(profileInput(), 0)).rejects.toMatchObject({ code: 'capacity' });
  expect(await db.repository.listReviewedProfiles('other')).toEqual([]);
  expect(await db.repository.cleanup(new Date('2026-12-10T00:00:00Z'))).toEqual({ profiles: 100, consents: 0 });
  const fresh = await db.repository.reviewProfile(profileInput(), 0);
  await expect(createGoogleDataAuthority(db.repository, { now: () => now }).assertAuthorized({ ownerId: 'owner-one', googleAccountId: accountId, purposeId: 'mail-assistance', profileId: fresh.id, dataKinds: ['gmail-content'], resolvedRoute: route() })).rejects.toMatchObject({ code: 'unavailable' });
});
it('revokes by account/profile and expires metadata with cascaded consent counts', async () => {
  const profile = await db.repository.reviewProfile(profileInput(), 0);
  await db.repository.recordConsent(consentInput(profile.id), 0);
  expect(await db.repository.revokeAccount('other', accountId)).toBe(0);
  expect(await db.repository.revokeAccount('owner-one', accountId)).toBe(1);
  expect(await db.repository.revokeProfile(profile.id, 'owner-one', 1)).toBe(2);
  await expect(db.repository.recordConsent(consentInput(profile.id), 2)).rejects.toMatchObject({ code: 'conflict' });
  expect(await db.repository.listReviewedProfiles('owner-one')).toEqual([]);
  expect(await db.repository.cleanup(new Date('2026-12-10T00:00:00Z'))).toEqual({ profiles: 1, consents: 1 });
});
it('owns only its bounded cleanup timer and never destroys an injected database', async () => {
  vi.useFakeTimers(); db.repository.startCleanup(); db.repository.startCleanup();
  expect(vi.getTimerCount()).toBe(1);
  await db.repository.close(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers();
  expect((await sql`SELECT 1 AS alive`.execute(db.sql)).rows).toEqual([{ alive: 1 }]);
});
