import { Hono } from 'hono';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { insertUserMachine, updateUserMachine, type PlatformDB, type NewUserMachine } from '../../packages/platform/src/db.js';
import { buildPlatformSyncVerificationToken } from '../../packages/platform/src/platform-token.js';
import { createSitesService } from '../../packages/platform/src/sites/service.js';
import { createSiteManagementRoutes } from '../../packages/platform/src/sites/management-routes.js';

const secret = 'publish-admission-platform-secret-32';
const identity = { handle: 'publisher', machineId: '6ca1865c-25c2-46bc-93b6-0273ef7c5527', runtimeSlot: 'primary' };
const owner = { ownerId: 'user_publisher', machineId: identity.machineId, appSlug: 'event' };
const deployment = { title: 'Event', config: {}, files: [{ path: 'index.html', contentType: 'text/html', body: Buffer.from('Event').toString('base64') }] };
let db: PlatformDB;
beforeEach(async () => {
  db = (await createTestPlatformDb()).db;
  await insertUserMachine(db, { ...identity, clerkUserId: owner.ownerId, status: 'running', runtimeTokenEpoch: 2, provisionedAt: new Date().toISOString() });
});
afterEach(async () => { vi.restoreAllMocks(); await destroyTestPlatformDb(db); });

it.each([
  ['replacement', { machineId: 'f973bb98-2538-4f9f-a10d-1be5920a7bf7' }],
  ['epoch rotation', { runtimeTokenEpoch: 3 }],
  ['slot reassignment', { runtimeSlot: 'secondary' }],
  ['handle reassignment', { handle: 'other-publisher' }],
  ['runtime stopped', { status: 'failed' }],
  ['runtime authorization revoked', { activationState: 'awaiting_billing' }],
  ['owner reassignment', { clerkUserId: 'user_other' }],
  ['restricted runtime', { provisioningClass: 'preview' }],
  ['shared delegation', { accessClerkUserIds: ['user_other'] }],
  ['runtime deletion', { deletedAt: new Date().toISOString() }],
] as [string, Partial<NewUserMachine>][] )('rejects a first publish after %s changes between HTTP auth and locked admission', async (_, change) => {
  const upload = vi.fn(async () => ({}));
  const service = createSitesService({ db, storage: { putObject: upload, async getObject() { return { body: null }; } } });
  const original = service.deploy;
  const began = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  service.deploy = async (...args) => { began.resolve(); await finish.promise; return original(...args); };
  const app = new Hono();
  app.route('/internal/containers/:handle/sites', createSiteManagementRoutes({ db, platformSecret: secret, service }));
  const request = app.request('/internal/containers/publisher/sites/event?runtimeSlot=primary', { method: 'POST',
    headers: { authorization: `Bearer ${buildPlatformSyncVerificationToken(identity, secret, 2)}`, 'content-type': 'application/json' }, body: JSON.stringify(deployment) });
  await began.promise;
  await updateUserMachine(db, identity.machineId, change);
  finish.resolve();
  expect((await request).status).toBe(503);
  expect(upload).not.toHaveBeenCalled();
  expect(await db.executor.selectFrom('public_sites').selectAll().execute()).toEqual([]);
});

it('denies a second publish for the owner before it takes another DB transaction, then releases the admission', async () => {
  const began = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const upload = vi.fn(async () => { began.resolve(); await finish.promise; return {}; });
  const service = createSitesService({ db, storage: { putObject: upload, async getObject() { return { body: null }; } } });
  const transactions = vi.spyOn(db, 'transaction');
  const first = service.deploy(owner, deployment);
  await began.promise;
  const second = service.deploy({ ...owner, appSlug: 'second-event' }, deployment);
  const secondOutcome = second.then(() => 'accepted', () => 'denied');
  try {
    expect(await Promise.race([secondOutcome, new Promise(resolve => setTimeout(() => resolve('waiting'), 50))])).toBe('denied');
    expect(transactions).toHaveBeenCalledOnce();
    expect(upload).toHaveBeenCalledOnce();
  } finally { finish.resolve(); await Promise.allSettled([first, second]); }
  const next = await service.deploy({ ...owner, appSlug: 'after-finish' }, deployment);
  expect(next.status).toBe('published');
});

it('caps all owners at four in-flight publish transactions and releases capacity after completion', async () => {
  const finish = Promise.withResolvers<void>();
  const owners = Array.from({ length: 5 }, (_, index) => ({ ownerId: `user_publisher_${index}`, machineId: `publish-machine-${index}`, appSlug: 'event' }));
  for (const publisher of owners) await insertUserMachine(db, { machineId: publisher.machineId, clerkUserId: publisher.ownerId, handle: `publisher-${publisher.ownerId.slice(-1)}`,
    status: 'running', provisionedAt: new Date().toISOString() });
  const service = createSitesService({ db, storage: { async putObject() { await finish.promise; return {}; }, async getObject() { return { body: null }; } } });
  const transactions = vi.spyOn(db, 'transaction');
  const accepted = owners.slice(0, 4).map(publisher => service.deploy(publisher, deployment));
  const denied = service.deploy(owners[4], deployment);
  const deniedOutcome = denied.then(() => 'accepted', () => 'denied');
  try {
    expect(await Promise.race([deniedOutcome, new Promise(resolve => setTimeout(() => resolve('waiting'), 50))])).toBe('denied');
    expect(transactions).toHaveBeenCalledTimes(4);
  } finally { finish.resolve(); await Promise.allSettled([...accepted, denied]); }
  expect((await service.deploy(owners[4], deployment)).status).toBe('published');
});

it('releases admission after validation and upload failures without retaining a partial site', async () => {
  const service = createSitesService({ db, storage: { putObject: vi.fn().mockRejectedValueOnce(new Error('upload failed')).mockResolvedValue({}), async getObject() { return { body: null }; } } });
  await expect(service.deploy(owner, {})).rejects.toThrow('invalid_request');
  await expect(service.deploy(owner, deployment)).rejects.toThrow('upload failed');
  expect(await service.get(owner)).toBeNull();
  expect((await service.deploy(owner, deployment)).status).toBe('published');
});

it('rejects a missing runtime for direct service callers before creating registry or uploading assets', async () => {
  const upload = vi.fn(async () => ({}));
  const service = createSitesService({ db, storage: { putObject: upload, async getObject() { return { body: null }; } } });
  await expect(service.deploy({ ...owner, machineId: 'absent-runtime' }, deployment)).rejects.toThrow('unavailable');
  expect(upload).not.toHaveBeenCalled();
  expect(await db.executor.selectFrom('public_sites').selectAll().execute()).toEqual([]);
});

it('retains the owner admission while failed candidate cleanup is still running', async () => {
  const cleanupBegan = Promise.withResolvers<void>();
  const cleanupFinish = Promise.withResolvers<void>();
  const transactions = vi.spyOn(db, 'transaction');
  const upload = vi.fn().mockRejectedValueOnce(new Error('upload failed')).mockResolvedValue({});
  const service = createSitesService({ db, storage: { putObject: upload, async getObject() { return { body: null }; },
    async deleteObject() { cleanupBegan.resolve(); await cleanupFinish.promise; } } });
  const first = service.deploy(owner, deployment);
  const firstOutcome = first.then(() => 'accepted', () => 'failed');
  await cleanupBegan.promise;
  try {
    await expect(service.deploy({ ...owner, appSlug: 'during-cleanup' }, deployment)).rejects.toThrow('unavailable');
    expect(transactions).toHaveBeenCalledOnce();
  } finally { cleanupFinish.resolve(); await firstOutcome; }
  expect((await service.deploy(owner, deployment)).status).toBe('published');
});
