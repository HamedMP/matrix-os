import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { insertUserMachine, updateUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createConfiguredAccountDeletionRuntime } from '../../packages/platform/src/account-deletion/wiring.js';
import { createSitesService } from '../../packages/platform/src/sites/service.js';
const objects = vi.hoisted(() => new Map<string, Uint8Array>());
const sitesStore = vi.hoisted(() => ({
    listObjects: vi.fn(async (prefix: string) => ({ keys: [...objects.keys()].filter(key => key.startsWith(prefix)), nextCursor: null })),
    deleteObject: vi.fn(async (key: string) => { objects.delete(key); }), abortOwnerMultipartUploads: vi.fn(async () => { }), destroy: vi.fn(),
}));
const syncStore = vi.hoisted(() => ({ listObjects: vi.fn(async () => ({ keys: [], nextCursor: null })), deleteObject: vi.fn(), abortOwnerMultipartUploads: vi.fn(), destroy: vi.fn() }));
const configured = vi.hoisted(() => vi.fn((config: {
    bucket: string;
}) => config.bucket === 'private-sites' ? sitesStore : syncStore));
vi.mock('../../packages/platform/src/account-deletion/storage.js', async (original) => ({ ...await original<object>(), createAccountDeletionObjectStore: configured }));
vi.mock('../../packages/platform/src/customer-vps-hetzner.js', () => ({ createHetznerClient: () => ({ async listServersByLabel() { return []; }, async getServer() { return null; } }) }));
let db: PlatformDB;
const env = { ACCOUNT_DELETION_ENABLED: 'true', ACCOUNT_DELETION_SECRET: 'sites-deletion-wiring-secret-123456', CLERK_SECRET_KEY: 'test', R2_ACCESS_KEY_ID: 'sync-key', R2_SECRET_ACCESS_KEY: 'sync-secret',
    R2_SITES_BUCKET: 'private-sites', R2_SITES_ACCESS_KEY_ID: 'sites-key', R2_SITES_SECRET_ACCESS_KEY: 'sites-secret', R2_SITES_ENDPOINT: 'https://private-sites.example.test' };
beforeAll(async () => { db = (await createTestPlatformDb()).db;
    await insertUserMachine(db, { machineId: 'test-machine', clerkUserId: 'user_sites_delete_wiring', handle: 'deletion-wiring', status: 'running', provisionedAt: new Date().toISOString() });
});
beforeEach(async () => { objects.clear(); vi.clearAllMocks(); await db.executor.deleteFrom('account_deletion_jobs').execute(); await db.executor.deleteFrom('public_sites').execute(); await db.executor.deleteFrom('public_site_aliases').execute(); });
afterAll(async () => { vi.restoreAllMocks(); await destroyTestPlatformDb(db); });
it('configured deletion revokes site immediately and durably erases dedicated assets and routing', async () => {
    const owner = { ownerId: 'user_sites_delete_wiring', machineId: 'test-machine', appSlug: 'event' };
    const service = createSitesService({ db, env, storage: { async putObject(key, body) { objects.set(key, body as Uint8Array); return {}; }, async getObject() { return { body: null }; } } });
    const site = await service.deploy(owner, { title: 'Event', slug: 'erase-event', config: {}, files: [{ path: 'index.html', contentType: 'text/html', body: Buffer.from('Event').toString('base64') }] });
    objects.set('sites/owners/user_foreign/keep/index.html', new Uint8Array([1]));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        if (String(url).includes('organization_memberships'))
            return Response.json({ data: [], total_count: 0 });
        if (String(url).includes('/users/'))
            return init?.method === 'DELETE' ? Response.json({ deleted: true }) : Response.json({ external_accounts: [] });
        throw Error('Unexpected outbound request');
    });
    const customerVpsService = { async delete(machineId: string) {
        // Simulate completed runtime revocation whose sync-upload URLs expired.
        await updateUserMachine(db, machineId, { status: 'deleted', deletedAt: '2020-01-01T00:00:00.000Z' });
        return { machineId, status: 'deleted' as const };
    } } as Parameters<typeof createConfiguredAccountDeletionRuntime>[0]['customerVpsService'];
    const runtime = await createConfiguredAccountDeletionRuntime({ db, env, customerVpsService, backgroundWorkersEnabled: false });
    try {
        expect(configured).toHaveBeenCalledWith(expect.objectContaining({ bucket: 'private-sites', accessKeyId: 'sites-key', secretAccessKey: 'sites-secret' }));
        await runtime!.service.schedule(owner.ownerId);
        expect(await service.resolve(site.id)).toBeNull();
        await db.executor.updateTable('account_deletion_jobs').set({ due_at: '2020-01-01', next_attempt_at: '2020-01-01' }).execute();
        await runtime!.service.reconcile();
        expect(await runtime!.service.get(owner.ownerId)).toMatchObject({ status: 'completed' });
        expect([...objects.keys()]).toEqual(['sites/owners/user_foreign/keep/index.html']);
        expect(await db.executor.selectFrom('public_site_aliases').selectAll().execute()).toEqual([{slug:'erase-event',site_id:null}]);
        expect(await db.executor.selectFrom('public_site_versions').selectAll().execute()).toEqual([]);
    }
    finally {
        runtime?.stop();
        await runtime?.drain();
        runtime?.close();
    }
    expect(sitesStore.destroy).toHaveBeenCalledOnce();
    expect(syncStore.destroy).toHaveBeenCalledOnce();
});
it('refuses partial or shared dedicated sites credentials before starting cleanup', async () => {
    await expect(createConfiguredAccountDeletionRuntime({ db, env: { ...env, R2_SITES_SECRET_ACCESS_KEY: '' }, backgroundWorkersEnabled: false })).rejects.toThrow('Dedicated sites');
    await expect(createConfiguredAccountDeletionRuntime({ db, env: { ...env, R2_SITES_BUCKET: 'matrixos-sync' }, backgroundWorkersEnabled: false })).rejects.toThrow('Dedicated sites');
});
