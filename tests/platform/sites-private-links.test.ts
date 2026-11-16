import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { insertUserMachine } from '../../packages/platform/src/db.js';
import { SITE_VIEWER_SESSION_TTL_MS } from '@matrix-os/contracts';
import { createSitesService } from '../../packages/platform/src/sites/service.js';
import { seedLegacyAccessLink } from './site-legacy-access-links.js';

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

const sealedFiles = [
  { path: 'index.html', contentType: 'text/html', body: Buffer.from('<script type="module" src="./main.js"></script>').toString('base64') },
  { path: 'main.js', contentType: 'text/javascript', body: Buffer.from('window.sealed = true;').toString('base64') },
];
function memoryStorage() {
  const objects = new Map<string, Uint8Array>();
  const getObject = vi.fn(async (key: string) => {
    const body = objects.get(key);
    return { body: body ? new ReadableStream({ start(controller) { controller.enqueue(body); controller.close(); } }) : null };
  });
  return { objects, getObject, storage: { async putObject(key: string, body: unknown) { objects.set(key, body as Uint8Array); return {}; }, getObject } };
}

describe('private Matrix.page access links', () => {
  it('republishes a legacy one-time-link site and serves its sealed frame from the production cache', async () => {
    await publishedPrivateSite();
    const { storage, getObject } = memoryStorage();
    const service = createSitesService({ db: db.db, env: { NODE_ENV: 'test' }, storage });
    const site = await service.deploy(owner, { title: 'Sealed event', accessMode: 'private_link', baseRevision: 1, config: { data: {}, forms: [] }, files: sealedFiles });
    expect(site.accessMode).toBe('private_link');
    const first = await service.privateFrame(site.id, site.activeVersion!, 'index.html');
    expect(first).toContain('<script type="importmap">');
    expect(first).toContain('matrix-site:main.js');
    expect(getObject).toHaveBeenCalledTimes(2);
    await expect(service.privateFrame(site.id, site.activeVersion!, 'index.html')).resolves.toBe(first);
    expect(getObject).toHaveBeenCalledTimes(2);
  });

  it('refuses to create a new one-time link and stores no credential', async () => {
    await publishedPrivateSite();
    const captureEvent = vi.fn();
    const service = createSitesService({ db: db.db, env: { NODE_ENV: 'test' }, captureEvent });
    await expect(service.createAccessLink(owner, { baseRevision: 1 })).rejects.toMatchObject({ code: 'gone' });
    expect(await db.db.executor.selectFrom('public_site_access_links').selectAll().execute()).toEqual([]);
    expect(captureEvent).not.toHaveBeenCalled();
  });

  it('refuses a first publication as a one-time-link site before reserving inventory or uploading bytes', async () => {
    const { storage, objects } = memoryStorage();
    const service = createSitesService({ db: db.db, env: { NODE_ENV: 'test' }, storage });
    await expect(service.deploy(owner, { title: 'Sealed event', accessMode: 'private_link', config: { data: {}, forms: [] }, files: sealedFiles }))
      .rejects.toMatchObject({ code: 'gone' });
    expect(objects.size).toBe(0);
    expect(await db.db.executor.selectFrom('public_sites').selectAll().execute()).toEqual([]);
  });

  it('refuses to switch a public site into one-time links by publish or settings update', async () => {
    const { storage, objects } = memoryStorage();
    const service = createSitesService({ db: db.db, env: { NODE_ENV: 'test' }, storage });
    const site = await service.deploy(owner, { title: 'Public event', config: { data: {}, forms: [] }, files: sealedFiles });
    const uploaded = objects.size;
    await expect(service.deploy(owner, { title: 'Public event', accessMode: 'private_link', baseRevision: site.revision, config: { data: {}, forms: [] }, files: sealedFiles }))
      .rejects.toMatchObject({ code: 'gone' });
    expect(objects.size).toBe(uploaded);
    await expect(service.patch(owner, { accessMode: 'private_link', baseRevision: site.revision })).rejects.toMatchObject({ code: 'gone' });
    expect(await service.get(owner)).toMatchObject({ accessMode: 'public', revision: site.revision, activeVersion: site.activeVersion });
  });

  it('keeps legacy links and viewer sessions working when the owner edits a site that stays private', async () => {
    const { siteId } = await publishedPrivateSite();
    const service = createSitesService({ db: db.db, env: { NODE_ENV: 'test' } });
    const seeded = await seedLegacyAccessLink(db.db, siteId);
    const claim = await service.claimAccessLink(siteId, { linkId: seeded.linkId, token: seeded.secret });
    const renamed = await service.patch(owner, { title: 'Renamed event', accessMode: 'private_link', baseRevision: 1 });
    expect(renamed).toMatchObject({ title: 'Renamed event', accessMode: 'private_link', revision: 2 });
    expect(await service.authorize(siteId, claim.cookie)).toMatchObject({ id: siteId, accessMode: 'private_link' });
    expect((await service.listAccessLinks(owner)).links).toEqual([expect.objectContaining({ id: seeded.linkId, status: 'claimed' })]);
  });

  it('lets a legacy unclaimed link be claimed exactly once and binds the session to its site', async () => {
    const { siteId } = await publishedPrivateSite();
    const service = createSitesService({ db: db.db, env: { NODE_ENV: 'test' } });
    const seeded = await seedLegacyAccessLink(db.db, siteId);
    expect(JSON.stringify(await service.listAccessLinks(owner))).not.toContain(seeded.secret);
    const attempts = await Promise.allSettled([
      service.claimAccessLink(siteId, { linkId: seeded.linkId, token: seeded.secret }),
      service.claimAccessLink(siteId, { linkId: seeded.linkId, token: seeded.secret }),
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

  it('revokes legacy sessions on link removal, public transition, and unpublish', async () => {
    const { siteId } = await publishedPrivateSite();
    const service = createSitesService({ db: db.db, env: { NODE_ENV: 'test' } });
    const revoked = await seedLegacyAccessLink(db.db, siteId);
    const claim = await service.claimAccessLink(siteId, { linkId: revoked.linkId, token: revoked.secret });
    await service.revokeAccessLink(owner, revoked.linkId);
    expect(await service.authorize(siteId, claim.cookie)).toBeNull();

    const next = await seedLegacyAccessLink(db.db, siteId);
    const nextClaim = await service.claimAccessLink(siteId, { linkId: next.linkId, token: next.secret });
    const publicSite = await service.patch(owner, { accessMode: 'public', baseRevision: 1 });
    expect(publicSite.accessMode).toBe('public');
    expect(await service.listAccessLinks(owner)).toEqual({ links: [], nextCursor: null });
    expect(await service.authorize(siteId, nextClaim.cookie)).toMatchObject({ accessMode: 'public' });
    await expect(service.patch(owner, { accessMode: 'private_link', baseRevision: publicSite.revision })).rejects.toMatchObject({ code: 'gone' });

    await db.db.executor.updateTable('public_sites').set({ access_mode: 'private_link' }).where('id', '=', siteId).execute();
    const final = await seedLegacyAccessLink(db.db, siteId);
    await service.claimAccessLink(siteId, { linkId: final.linkId, token: final.secret });
    await service.unpublish(owner, publicSite.revision);
    expect(await db.db.executor.selectFrom('public_site_access_links').selectAll().where('site_id', '=', siteId).execute()).toEqual([]);
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

  it('pages a legacy inventory of more than fifty links without a total cap', async () => {
    const { siteId } = await publishedPrivateSite();
    const service=createSitesService({db:db.db,env:{NODE_ENV:'test'}});
    for (let index=0;index<51;index++) await seedLegacyAccessLink(db.db, siteId);
    const first=await service.listAccessLinks(owner,{limit:25});
    expect(first.links).toHaveLength(25);
    expect(first.nextCursor).not.toBeNull();
    const second=await service.listAccessLinks(owner,{limit:25,cursor:first.nextCursor!});
    expect(second.links).toHaveLength(25);
    expect(second.nextCursor).not.toBeNull();
    const third=await service.listAccessLinks(owner,{limit:25,cursor:second.nextCursor!});
    expect(third.links).toHaveLength(1);
    expect(third.nextCursor).toBeNull();
    expect(new Set([...first.links,...second.links,...third.links].map(link=>link.id))).toHaveProperty('size',51);
  });

  it('rejects an expired browser session even when its hash remains valid', async () => {
    const {siteId}=await publishedPrivateSite();
    const service=createSitesService({db:db.db,env:{NODE_ENV:'test'}});
    const seeded=await seedLegacyAccessLink(db.db, siteId);
    const claim=await service.claimAccessLink(siteId,{linkId:seeded.linkId,token:seeded.secret});
    await db.db.executor.updateTable('public_site_access_links').set({session_expires_at:'2026-01-01T00:00:00.000Z'}).where('id','=',seeded.linkId).execute();
    expect(await service.authorize(siteId,claim.cookie)).toBeNull();
  });
});
