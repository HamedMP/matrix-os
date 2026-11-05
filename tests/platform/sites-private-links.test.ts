import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { insertUserMachine } from '../../packages/platform/src/db.js';
import { SITE_ACCESS_LINK_CLAIM_TTL_MS, SITE_MAX_ACCESS_LINKS, SITE_VIEWER_SESSION_TTL_MS } from '@matrix-os/contracts';
import { createSitesService } from '../../packages/platform/src/sites/service.js';

const db = await createTestPlatformDb({ serializeTransactions: true });
const owner = { ownerId: 'user_private_links', machineId: 'private-links-runtime', appSlug: 'event' };
await insertUserMachine(db.db, { machineId: owner.machineId, clerkUserId: owner.ownerId, handle: 'private-links', status: 'running', provisionedAt: new Date().toISOString() });
afterAll(() => destroyTestPlatformDb(db.db));
beforeEach(async () => {
  await db.db.executor.deleteFrom('public_site_access_links').execute();
  await db.db.executor.deleteFrom('public_site_versions').execute();
  await db.db.executor.deleteFrom('public_sites').execute();
  await db.db.executor.deleteFrom('public_site_aliases').execute();
});

const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex');

async function publishedPrivateSite() {
  const siteId = randomUUID();
  const versionId = randomUUID();
  await db.db.executor.insertInto('public_sites').values({
    id: siteId, owner_id: owner.ownerId, machine_id: owner.machineId, app_slug: owner.appSlug,
    title: 'Event', description: '', slug: null, revision: 1, status: 'published',
    access_mode: 'private_link', active_version: versionId, created_at: new Date().toISOString(),
  }).execute();
  await db.db.executor.insertInto('public_site_versions').values({
    id: versionId, site_id: siteId, created_at: new Date().toISOString(), config: { data: {}, forms: [] }, files: [],
  }).execute();
  return { siteId, versionId };
}

describe('private Matrix.page access links', () => {
  it('creates multiple write-only links and projects only bounded summaries', async () => {
    const { siteId } = await publishedPrivateSite();
    const service = createSitesService({ db: db.db, env: { NODE_ENV: 'test' } });
    const first = await service.createAccessLink(owner, { baseRevision: 1 });
    const second = await service.createAccessLink(owner, { baseRevision: 1 });
    expect(first.url).toMatch(new RegExp(`^https://matrix\\.page/${siteId}#access=${first.link.id}\\.[A-Za-z0-9_-]{43}$`));
    expect(second.link.id).not.toBe(first.link.id);
    expect(JSON.stringify(await service.listAccessLinks(owner))).not.toContain(first.url.split('.').at(-1));
    const rows = await db.db.executor.selectFrom('public_site_access_links').selectAll().execute();
    expect(rows).toHaveLength(2);
    expect(rows.every(row => /^[a-f0-9]{64}$/.test(row.claim_token_hash))).toBe(true);
    expect(rows.every(row => row.session_token_hash === null)).toBe(true);
    expect(Date.parse(first.link.claimExpiresAt)-Date.parse(first.link.createdAt)).toBe(SITE_ACCESS_LINK_CLAIM_TTL_MS);
  });

  it('allows exactly one concurrent claim and binds the resulting session to its site', async () => {
    const { siteId } = await publishedPrivateSite();
    const service = createSitesService({ db: db.db, env: { NODE_ENV: 'test' } });
    const created = await service.createAccessLink(owner, { baseRevision: 1 });
    const secret = created.url.split('.').at(-1)!;
    const attempts = await Promise.allSettled([
      service.claimAccessLink(siteId, { linkId: created.link.id, token: secret }),
      service.claimAccessLink(siteId, { linkId: created.link.id, token: secret }),
    ]);
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const claim = attempts.find(result => result.status === 'fulfilled')!;
    if (claim.status !== 'fulfilled') throw new Error('claim missing');
    expect(claim.value.cookie).toContain('HttpOnly');
    expect(claim.value.cookie).toContain('Secure');
    expect(claim.value.cookie).toContain('SameSite=Lax');
    expect(Date.parse(claim.value.link.sessionExpiresAt!)-Date.parse(claim.value.link.claimedAt!)).toBe(SITE_VIEWER_SESSION_TTL_MS);
    expect(await service.authorize(siteId, claim.value.cookie)).toMatchObject({ id: siteId, accessMode: 'private_link' });
    expect(await service.authorize(randomUUID(), claim.value.cookie)).toBeNull();
  });

  it('revokes sessions on link removal, public transition, and unpublish', async () => {
    const { siteId } = await publishedPrivateSite();
    const service = createSitesService({ db: db.db, env: { NODE_ENV: 'test' } });
    const created = await service.createAccessLink(owner, { baseRevision: 1 });
    const claim = await service.claimAccessLink(siteId, { linkId: created.link.id, token: created.url.split('.').at(-1)! });
    await service.revokeAccessLink(owner, created.link.id);
    expect(await service.authorize(siteId, claim.cookie)).toBeNull();

    const next = await service.createAccessLink(owner, { baseRevision: 1 });
    const nextClaim = await service.claimAccessLink(siteId, { linkId: next.link.id, token: next.url.split('.').at(-1)! });
    const publicSite = await service.patch(owner, { accessMode: 'public', baseRevision: 1 });
    expect(publicSite.accessMode).toBe('public');
    expect(await service.listAccessLinks(owner)).toEqual([]);
    expect(await service.authorize(siteId, nextClaim.cookie)).toMatchObject({ accessMode: 'public' });

    const privateAgain = await service.patch(owner, { accessMode: 'private_link', baseRevision: publicSite.revision });
    expect(await service.authorize(siteId, nextClaim.cookie)).toBeNull();
    const final = await service.createAccessLink(owner, { baseRevision: privateAgain.revision });
    const finalClaim = await service.claimAccessLink(siteId, { linkId: final.link.id, token: final.url.split('.').at(-1)! });
    await service.unpublish(owner, privateAgain.revision);
    expect(await service.authorize(siteId, finalClaim.cookie)).toBeNull();
  });

  it('rejects expired claims and validates stored hashes rather than plaintext', async () => {
    const { siteId } = await publishedPrivateSite();
    const service = createSitesService({ db: db.db, env: { NODE_ENV: 'test' } });
    const linkId = randomUUID();
    const secret = 'z'.repeat(43);
    await db.db.executor.insertInto('public_site_access_links').values({
      id: linkId, site_id: siteId, claim_token_hash: tokenHash(secret), session_token_hash: null,
      created_at: '2026-01-01T00:00:00.000Z', claim_expires_at: '2026-01-02T00:00:00.000Z',
      claimed_at: null, session_expires_at: null,
    }).execute();
    await expect(service.claimAccessLink(siteId, { linkId, token: secret })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('caps active and expired link inventory at fifty until the owner revokes rows', async () => {
    const { siteId } = await publishedPrivateSite();
    const now = new Date().toISOString();
    await db.db.executor.insertInto('public_site_access_links').values(Array.from({length:SITE_MAX_ACCESS_LINKS},(_,index)=>({
      id:randomUUID(),site_id:siteId,claim_token_hash:tokenHash(String(index).padStart(43,'x')),session_token_hash:null,
      created_at:now,claim_expires_at:'2026-01-01T00:00:00.000Z',claimed_at:null,session_expires_at:null,
    }))).execute();
    const service=createSitesService({db:db.db,env:{NODE_ENV:'test'}});
    await expect(service.createAccessLink(owner,{baseRevision:1})).rejects.toMatchObject({code:'conflict'});
    const first=(await service.listAccessLinks(owner))[0]!;
    await service.revokeAccessLink(owner,first.id);
    await expect(service.createAccessLink(owner,{baseRevision:1})).resolves.toHaveProperty('url');
  });

  it('rejects an expired browser session even when its hash remains valid', async () => {
    const {siteId}=await publishedPrivateSite();
    const service=createSitesService({db:db.db,env:{NODE_ENV:'test'}});
    const created=await service.createAccessLink(owner,{baseRevision:1});
    const claim=await service.claimAccessLink(siteId,{linkId:created.link.id,token:created.url.split('.').at(-1)!});
    await db.db.executor.updateTable('public_site_access_links').set({session_expires_at:'2026-01-01T00:00:00.000Z'}).where('id','=',created.link.id).execute();
    expect(await service.authorize(siteId,claim.cookie)).toBeNull();
  });
});
