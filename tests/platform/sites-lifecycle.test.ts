import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import type { PlatformDB } from '../../packages/platform/src/db.js';
import { AccountDeletionRepository } from '../../packages/platform/src/account-deletion/repository.js';
import { createSitesService } from '../../packages/platform/src/sites/service.js';
import { createAccountDeletionAdapters } from '../../packages/platform/src/account-deletion/adapters.js';
import { eraseOwnerSites, eraseOwnerSiteRegistry } from '../../packages/platform/src/sites/account-lifecycle.js';
let db: PlatformDB;
const env = { ACCOUNT_DELETION_SECRET: 'site-account-deletion-secret-123456789' };
const owner = { ownerId: 'user_deleting', machineId: 'lifecycle-machine', appSlug: 'launch' };
const deployment = { title: 'Launch', slug: 'delete-launch', config: {}, files: [{ path: 'index.html', contentType: 'text/html', body: Buffer.from('<h1>Launch</h1>').toString('base64') }] };
beforeAll(async () => { db = (await createTestPlatformDb()).db; });
beforeEach(async () => { await db.executor.deleteFrom('account_deletion_jobs').execute(); await db.executor.deleteFrom('public_sites').execute(); await db.executor.deleteFrom('public_site_aliases').execute(); });
afterAll(async () => { await destroyTestPlatformDb(db); });
it('immediately hides pending deletion sites and rejects writes and public form admissions during grace', async () => {
    const service = createSitesService({ db, env, storage: { async putObject() { return {}; }, async getObject() { return { body: null }; } } });
    const site = await service.deploy(owner, deployment);
    const repository = new AccountDeletionRepository(db.kysely, { secret: env.ACCOUNT_DELETION_SECRET });
    await repository.accept({ clerkUserId: owner.ownerId, appleTokens: [] }, false);
    expect(await service.resolve(site.id)).toBeNull();
    expect(await service.resolve('delete-launch')).toBeNull();
    await expect(service.deploy(owner, { ...deployment, baseRevision: site.revision })).rejects.toThrow();
    await expect(service.patch(owner, { title: 'Still public', baseRevision: site.revision })).rejects.toThrow();
    let submitted = false;
    await expect(service.admitted(site.id, async () => { submitted = true; })).rejects.toThrow();
    expect(submitted).toBe(false);
});
it('cleans all owner objects including failed candidates and removes owner registry/versions while retaining anonymous alias reservations', async () => {
    const objects = new Map<string, Uint8Array>();
    const service = createSitesService({ db, env, storage: { async putObject(key, body) { objects.set(key, body as Uint8Array); return {}; }, async getObject() { return { body: null }; } } });
    const site = await service.deploy(owner, deployment);
    expect([...objects.keys()][0]).toContain(`sites/owners/${owner.ownerId}/${site.id}/`);
    objects.set(`sites/owners/${owner.ownerId}/orphan/candidate/index.html`, new Uint8Array([1]));
    objects.set('sites/owners/user_other/private/index.html', new Uint8Array([2]));
    const aborted: string[] = [];
    await eraseOwnerSites(db, owner.ownerId, {
        async listObjects(prefix) { return { keys: [...objects.keys()].filter(k => k.startsWith(prefix)), nextCursor: null }; },
        async deleteObject(key) { objects.delete(key); }, async abortOwnerMultipartUploads(prefix) { aborted.push(prefix); },
    }, env);
    expect(aborted).toContain(`sites/owners/${owner.ownerId}/`);
    expect([...objects.keys()]).toEqual(['sites/owners/user_other/private/index.html']);
    expect(await service.resolve(site.id)).toBeNull();
    await eraseOwnerSiteRegistry(db, owner.ownerId);
    expect(await db.executor.selectFrom('public_sites').selectAll().execute()).toEqual([]);
    expect(await db.executor.selectFrom('public_site_versions').selectAll().execute()).toEqual([]);
    expect(await db.executor.selectFrom('public_site_aliases').selectAll().execute()).toEqual([{slug:'delete-launch',site_id:null}]);
    await expect(service.deploy({...owner,ownerId:'user_other',machineId:'other-machine'},deployment)).rejects.toThrow('conflict');
});
it('fails closed and retains retry inventory if dedicated site storage cleanup is missing or crosses ownership', async () => {
    const service = createSitesService({ db, storage: { async putObject() { return {}; }, async getObject() { return { body: null }; } } });
    await service.deploy(owner, deployment);
    await expect(eraseOwnerSites(db, owner.ownerId, undefined, env)).rejects.toThrow('storage');
    await expect(eraseOwnerSites(db, owner.ownerId, { async listObjects() { return { keys: ['sites/owners/user_other/private'], nextCursor: null }; }, async deleteObject() { throw Error('must not delete'); }, async abortOwnerMultipartUploads() { } }, env)).rejects.toThrow('ownership');
    expect(await db.executor.selectFrom('public_sites').selectAll().execute()).toHaveLength(1);
});
it('wires site storage erasure and routing cleanup into the existing account deletion steps', async () => {
    const objects = new Map<string, Uint8Array>();
    const service = createSitesService({ db, storage: { async putObject(key, body) { objects.set(key, body as Uint8Array); return {}; }, async getObject() { return { body: null }; } } });
    const site = await service.deploy(owner, deployment);
    const syncStore = { async listObjects() { return { keys: [], nextCursor: null }; }, async deleteObject() { }, async abortOwnerMultipartUploads() { } };
    const adapters = createAccountDeletionAdapters({ db, clerkSecretKey: 'test', r2PrefixRoot: 'matrixos-sync', objectStore: syncStore,
        sitesObjectStore: { async listObjects(prefix) { return { keys: [...objects.keys()].filter(key => key.startsWith(prefix)), nextCursor: null }; }, async deleteObject(key) { objects.delete(key); }, async abortOwnerMultipartUploads() { } }, env,
    });
    const context = { clerkUserId: owner.ownerId, appleTokens: [] };
    await adapters.storage(context);
    expect(objects.size).toBe(0);
    expect(await service.resolve(site.id)).toBeNull();
    await adapters.data(context);
    expect(await db.executor.selectFrom('public_sites').selectAll().execute()).toEqual([]);
});
