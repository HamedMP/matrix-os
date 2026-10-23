import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createSitesService } from '../../packages/platform/src/sites/service.js';
import { eraseOwnerSites, eraseOwnerSiteRegistry } from '../../packages/platform/src/sites/account-lifecycle.js';
import { createSitePublicRoutes } from '../../packages/platform/src/sites/public-routes.js';
import { JSDOM } from 'jsdom';
let db: PlatformDB;
const owner = { ownerId: 'review_owner', machineId: '6ca1865c-25c2-46bc-93b6-0273ef7c5527', appSlug: 'review' };
const deployment = { title: 'Review', config: { data: { greeting: 'live' }, forms: [] }, files: [{ path: 'index.html', contentType: 'text/html', body: Buffer.from('live asset').toString('base64') }] };
beforeAll(async () => { db = (await createTestPlatformDb()).db;
 await insertUserMachine(db, { machineId: owner.machineId, clerkUserId: owner.ownerId, handle: 'review-sites', status: 'running', provisionedAt: new Date().toISOString() });
});
afterAll(async () => { await destroyTestPlatformDb(db); });
function storage() {
 const objects = new Map<string, Uint8Array>();
 return { objects, async putObject(key: string, body: unknown) { objects.set(key, body as Uint8Array); return {}; }, async deleteObject(key: string) { objects.delete(key); }, async getObject(key: string) { const bytes = objects.get(key); return { body: bytes ? new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }) : null }; } };
}
it('projects bounded history metadata and only the active configuration', async () => {
 const service = createSitesService({ db, storage: storage() });
 const first = await service.deploy(owner, deployment);
 await service.deploy(owner, { ...deployment, config: { data: { greeting: 'next' }, forms: [] }, baseRevision: first.revision });
 const queries: string[] = [];
 const original = db.executor.selectFrom.bind(db.executor);
 const spy = vi.spyOn(db.executor, 'selectFrom').mockImplementation(((...args: Parameters<typeof original>) => {
  const query = original(...args);
  if (args[0] === 'public_site_versions') {
   // Observe the final builder using Kysely's query plugin, rather than executing this initial builder.
   return query.withPlugin({ transformQuery(args) { queries.push(JSON.stringify(args.node)); return args.node; }, async transformResult(args) { return args.result; } });
  }
  return query;
 }) as typeof db.executor.selectFrom);
 try {
  const result = await service.get(owner);
  expect(result?.versions).toHaveLength(2);
  expect(result?.config.data.greeting).toBe('next');
  expect(queries).toHaveLength(2);
  expect(queries[0]).not.toContain('SelectAll');
  expect(queries[0]).not.toContain('"name":"config"');
  expect(queries[1]).not.toContain('SelectAll');
  expect(queries[1]).toContain('"name":"config"');
 } finally { spy.mockRestore(); }
});
it('keeps committed assets when the transaction commit acknowledgement fails', async () => {
 const store = storage();
 const ambiguousDb: PlatformDB = { ...db, async transaction(fn) { const result = await db.transaction(fn); if ((result as { status?: string })?.status === 'published') throw new Error('commit acknowledgement lost'); return result; } };
 const service = createSitesService({ db: ambiguousDb, storage: store });
 await expect(service.deploy({ ...owner, appSlug: 'ambiguous' }, deployment)).rejects.toThrow('commit acknowledgement lost');
 const live = createSitesService({ db, storage: store });
 const site = await live.get({ ...owner, appSlug: 'ambiguous' });
 expect(site?.status).toBe('published');
 expect((await live.asset(site!.id, site!.activeVersion!, 'index.html')).body.toString()).toBe('live asset');
});
it('cleans candidate uploads when activation fails before callback completion', async () => {
 const store = storage();
 const failing = { ...store, async putObject(key: string, body: unknown) { await store.putObject(key, body); throw new Error('upload failed'); } };
 await expect(createSitesService({ db, storage: failing }).deploy({ ...owner, appSlug: 'failed' }, deployment)).rejects.toThrow('upload failed');
 expect(store.objects.size).toBe(0);
});
it('retains a durable owner inventory after the first upload and cleanup both fail', async () => {
 const store = storage(), failedOwner = { ...owner, appSlug: 'failed-first-upload' };
 const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
 try {
  const failing = { ...store, async putObject(key: string, body: unknown) { await store.putObject(key, body); throw Error('upload acknowledgement lost'); }, async deleteObject() { throw Error('cleanup unavailable'); } };
  const service = createSitesService({ db, storage: failing });
  await expect(service.deploy(failedOwner, deployment)).rejects.toThrow('upload acknowledgement lost');
  const pending = await service.get(failedOwner);
  expect(pending).toMatchObject({ status: 'unpublished', activeVersion: null, versions: [] });
  expect(store.objects.size).toBe(1);
  await expect(eraseOwnerSites(db, owner.ownerId, undefined)).rejects.toThrow('Sites storage cleanup unavailable');
  expect(await service.get(failedOwner)).not.toBeNull();
  await eraseOwnerSites(db, owner.ownerId, { async listObjects(prefix) { return { keys: [...store.objects.keys()].filter(key => key.startsWith(prefix)), nextCursor: null }; }, async deleteObject(key) { store.objects.delete(key); }, async abortOwnerMultipartUploads() {} });
  expect(store.objects.size).toBe(0);
  await eraseOwnerSiteRegistry(db, owner.ownerId);
  expect(await service.get(failedOwner)).toBeNull();
 } finally { warning.mockRestore(); }
});
it('injects version-bound public controls into linked HTML pages and preserves their relative paths', async () => {
 const store = storage(), publisher = { ...owner, appSlug: 'linked-html' };
 const service = createSitesService({ db, storage: store });
 const html = '<html><head><script>window.appData=window.MatrixOS.site.data.greeting</script></head><body><a href="./contact.html">Contact</a></body></html>';
 const files = [...deployment.files, { path: 'pages/about.html', contentType: 'text/html', body: Buffer.from(html).toString('base64') }];
 const first = await service.deploy(publisher, { ...deployment, files });
 await service.deploy(publisher, { ...deployment, files, config: { data: { greeting: 'new-version' }, forms: [] }, baseRevision: first.revision });
 const edgeSecret = 'linked-html-edge-secret-at-least-32';
 const app = createSitePublicRoutes({ service, edgeSecret, submit: async () => ({ accepted: true }) });
 const response = await app.request(`/${first.id}/assets/${first.activeVersion}/pages/about.html`, { headers: { 'x-matrix-sites-edge': edgeSecret } });
 expect(response.status).toBe(200);
 expect(response.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
 const dom = new JSDOM(await response.text(), { url: `https://matrix.page/${first.id}/assets/${first.activeVersion}/pages/about.html`, runScripts: 'dangerously', beforeParse(window) { Object.defineProperty(window, 'TextDecoder', { value: TextDecoder }); } });
 try {
  expect((dom.window as unknown as { appData: string }).appData).toBe('live');
  expect(dom.window.document.querySelector('a')!.href).toBe(`https://matrix.page/${first.id}/assets/${first.activeVersion}/pages/contact.html`);
  expect((dom.window as unknown as { MatrixOS: { site: { submit: unknown } } }).MatrixOS.site.submit).toBeTypeOf('function');
 } finally { dom.window.close(); }
});
