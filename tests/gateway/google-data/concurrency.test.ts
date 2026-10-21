import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createGoogleDataAuthority } from '../../../packages/gateway/src/google-data/authority.js';
import { createGoogleDataRepository } from '../../../packages/gateway/src/google-data/repository.js';
import { createAuthorityFixture } from './fixture-db.js';
import { accountId, consentInput, now, profileInput, route } from './fixtures.js';
let db: Awaited<ReturnType<typeof createAuthorityFixture>>['db'];
const request = (profileId: string) => ({ ownerId: 'owner-one', googleAccountId: accountId, purposeId: 'mail-assistance', profileId, dataKinds: ['gmail-content'], resolvedRoute: route() });
describe.runIf(Boolean(process.env.MATRIX_PLATFORM_FIXTURE_POSTGRES_URL))('real PostgreSQL authority concurrency', () => {
  beforeEach(async () => { ({ db } = await createAuthorityFixture()); });
  afterEach(async () => { await db.destroy(); });
  it('admits only one simultaneous consent create and one revision-conditional change', async () => {
    const profile = await db.repository.reviewProfile(profileInput(), 0);
    const created = await Promise.allSettled([db.repository.recordConsent(consentInput(profile.id), 0), db.repository.recordConsent(consentInput(profile.id), 0)]);
    expect(created.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const key = { ownerId: 'owner-one', googleAccountId: accountId, purposeId: 'mail-assistance', profileId: profile.id };
    const changed = await Promise.allSettled([db.repository.recordConsent(consentInput(profile.id), 1), db.repository.revokeConsent(key, 1)]);
    expect(changed.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  });
  it('never releases authority for a superseded profile after concurrent consent and review', async () => {
    const profile = await db.repository.reviewProfile(profileInput(), 0);
    const results = await Promise.allSettled([db.repository.recordConsent(consentInput(profile.id), 0), db.repository.reviewProfile({ ...profileInput(), id: profile.id }, 1)]);
    expect(results[1]!.status).toBe('fulfilled');
    await expect(createGoogleDataAuthority(db.repository, { now: () => now }).assertAuthorized(request(profile.id))).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('rechecks evidence and consent expiry after waiting for the writer lock', async () => {
    let clock = new Date(now); const repository = createGoogleDataRepository(db.sql, { now: () => clock });
    const input = profileInput(); input.evidence.expiresAt = new Date(now.getTime() + 1000).toISOString();
    const profile = await repository.reviewProfile(input, 0);
    let release!: () => void; let acquired!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { acquired = resolve; });
    const blocker = db.sql.transaction().execute(async tx => { await sql`SELECT pg_advisory_xact_lock(5510356)`.execute(tx); acquired(); await held; });
    await ready;
    const pending = repository.recordConsent(consentInput(profile.id, { expiresAt: new Date(now.getTime() + 500).toISOString() }), 0);
    // Both calls entered synchronously; its first database await is queued behind the real lock.
    await new Promise(resolve => setTimeout(resolve, 20));
    clock = new Date(now.getTime() + 2000); release(); await blocker;
    await expect(pending).rejects.toMatchObject({ code: 'conflict' });
  });
  it('orders cleanup and snapshots consistently without deadlock or resurrected approval', async () => {
    const profile = await db.repository.reviewProfile(profileInput(), 0);
    await db.repository.recordConsent(consentInput(profile.id), 0);
    const stamp = await createGoogleDataAuthority(db.repository, { now: () => now }).assertAuthorized(request(profile.id));
    const key = { ownerId: 'owner-one', googleAccountId: accountId, purposeId: 'mail-assistance', profileId: profile.id };
    const results = await Promise.allSettled([db.repository.snapshot(key), db.repository.cleanup(new Date('2026-12-10T00:00:00Z')), db.repository.snapshot(key)]);
    expect(results.every(result => result.status === 'fulfilled')).toBe(true);
    await expect(createGoogleDataAuthority(db.repository, { now: () => now }).revalidate(stamp, route())).rejects.toMatchObject({ code: 'unavailable' });
  });
});
