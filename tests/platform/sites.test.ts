import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import type { PlatformDB } from '../../packages/platform/src/db.js';
import { createSitesService } from '../../packages/platform/src/sites/service.js';
import { createSitePublicRoutes } from '../../packages/platform/src/sites/public-routes.js';
let db: PlatformDB;
let service: ReturnType<typeof createSitesService>;
let objects: Map<string, Uint8Array>;
let uploadSignals: AbortSignal[];
const owner = { ownerId: 'user_sites', machineId: '6ca1865c-25c2-46bc-93b6-0273ef7c5527', appSlug: 'launch' };
const deployment = { title: 'Launch', slug: 'matrix-launch', config: { data: { greeting: 'Hello' }, forms: [] }, files: [
        { path: 'index.html', contentType: 'text/html', body: Buffer.from('<!doctype html><div>Hello launch</div>').toString('base64') },
        { path: 'assets/main.js', contentType: 'text/javascript', body: Buffer.from('console.log("launch")').toString('base64') },
    ] };
beforeAll(async () => { db = (await createTestPlatformDb()).db; });
beforeEach(async () => {
    await db.executor.deleteFrom('public_sites').execute(); await db.executor.deleteFrom('public_site_aliases').execute();
    objects = new Map();
    uploadSignals = [];
    service = createSitesService({ db, storage: {
            async putObject(key, body, options) { uploadSignals.push(options!.signal!); objects.set(key, typeof body === 'string' ? Buffer.from(body) : body as Uint8Array); return {}; },
            async getObject(key) { const body = objects.get(key); return { body: body ? new ReadableStream({ start(c) { c.enqueue(body); c.close(); } }) : null }; },
        } });
});
afterAll(async () => { await destroyTestPlatformDb(db); });
it('deploys checked assets, keeps immutable ID and reserves aliases across rename', async () => {
    const first = await service.deploy(owner, deployment);
    expect(first.url).toBe('https://matrix.page/matrix-launch');
    const second = await service.patch(owner, { title: 'Updated', slug: 'launch-2026', baseRevision: first.revision });
    expect(second.id).toBe(first.id);
    expect((await service.resolve('matrix-launch'))?.id).toBe(first.id);
    await expect(service.deploy({ ...owner, ownerId: 'other', machineId: 'other' }, deployment)).rejects.toThrow('conflict');
});
it('serves a sandboxed public frame and revokes all versions and aliases', async () => {
    const site = await service.deploy(owner, deployment);
    const app = createSitePublicRoutes({ service, edgeSecret: 'verified-edge-proof-secret-1234567890', submit: async () => ({ accepted: true }) });
    const page = await app.request('/matrix-launch', { headers: { 'x-matrix-sites-edge': 'verified-edge-proof-secret-1234567890' } });
    expect(await page.text()).toContain('sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"');
    const frame = await app.request(`/${site.id}/frame`, { headers: { 'x-matrix-sites-edge': 'verified-edge-proof-secret-1234567890' } });
    expect(frame.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
    expect(await frame.text()).toContain('Hello launch');
    await service.unpublish(owner, site.revision);
    expect((await app.request('/matrix-launch', { headers: { 'x-matrix-sites-edge': 'verified-edge-proof-secret-1234567890' } })).status).toBe(404);
    expect((await app.request(`/${site.id}/assets/${site.activeVersion}/assets/main.js`, { headers: { 'x-matrix-sites-edge': 'verified-edge-proof-secret-1234567890' } })).status).toBe(404);
});
it('rejects stale revisions and preserves live deployment after storage failure', async () => {
    const first = await service.deploy(owner, deployment);
    await expect(service.patch(owner, { baseRevision: 0, title: 'Oops' })).rejects.toThrow('conflict');
    const broken = createSitesService({ db, storage: { async putObject() { throw new Error('storage failed'); }, async getObject() { return { body: null }; } } });
    await expect(broken.deploy(owner, { ...deployment, baseRevision: first.revision })).rejects.toThrow();
    expect((await service.get(owner))?.activeVersion).toBe(first.activeVersion);
});
it('rolls back both code and public configuration without changing permanent ID', async () => {
    const first = await service.deploy(owner, deployment);
    const second = await service.deploy(owner, { ...deployment, config: { data: { greeting: 'second' }, forms: [] }, baseRevision: first.revision });
    const rolled = await service.rollback(owner, first.activeVersion!, second.revision);
    expect(rolled.config.data.greeting).toBe('Hello');
    expect(rolled.id).toBe(first.id);
});
it('validates exact public form fields and never reaches submission transport after revoke', async () => {
    const site = await service.deploy(owner, { ...deployment, config: { data: {}, forms: [{ id: 'rsvp', title: 'RSVP', fields: { email: { type: 'email', required: true } } }] } });
    let submitted = 0;
    const app = createSitePublicRoutes({ service, edgeSecret: 'verified-edge-proof-secret-1234567890', submit: async () => { submitted++; return { accepted: true }; } });
    const request = (fields: unknown) => app.request(`/${site.id}/forms/rsvp`, { method: 'POST', headers: { 'x-matrix-sites-edge': 'verified-edge-proof-secret-1234567890', 'content-type': 'application/json' }, body: JSON.stringify({ fields, idempotencyKey: 'valid-idempotency-key' }) });
    expect((await request({ email: 'guest@example.com', private: true })).status).toBe(400);
    expect((await request({ email: 'guest@example.com' })).status).toBe(200);
    expect(submitted).toBe(1);
    await service.unpublish(owner, site.revision);
    expect((await request({ email: 'guest@example.com' })).status).toBe(404);
    expect(submitted).toBe(1);
});
it('serializes stale updates', async () => {
    const site = await service.deploy(owner, deployment);
    const changes = await Promise.allSettled([
        service.patch(owner, { title: 'One', baseRevision: site.revision }),
        service.patch(owner, { title: 'Two', baseRevision: site.revision }),
    ]);
    expect(changes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(changes.filter(r => r.status === 'rejected')).toHaveLength(1);
});
it('uses one bounded deployment deadline across all asset uploads', async () => {
    await service.deploy(owner, deployment);
    expect(uploadSignals).toHaveLength(2);
    expect(uploadSignals[0]).toBe(uploadSignals[1]);
});
it('rejects oversized public submission bodies before parsing or forwarding', async () => {
    const site = await service.deploy(owner, deployment);
    const app = createSitePublicRoutes({ service, edgeSecret: 'verified-edge-proof-secret-1234567890', submit: async () => ({ accepted: true }) });
    const response = await app.request(`/${site.id}/forms/rsvp`, { method: 'POST', headers: { 'x-matrix-sites-edge': 'verified-edge-proof-secret-1234567890', 'content-type': 'application/json' }, body: JSON.stringify({ fields: { name: 'a'.repeat(18 * 1024) }, idempotencyKey: 'valid-idempotency-key' }) });
    expect(response.status).toBe(413);
});
