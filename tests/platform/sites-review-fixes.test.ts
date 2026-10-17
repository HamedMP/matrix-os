import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createSitesService } from '../../packages/platform/src/sites/service.js';
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
 const ambiguousDb: PlatformDB = { ...db, async transaction(fn) { await db.transaction(fn); throw new Error('commit acknowledgement lost'); } };
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
