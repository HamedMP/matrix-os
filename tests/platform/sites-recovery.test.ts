import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { sql } from 'kysely';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { createMockCustomerVpsSystemStore, createMockHetznerClient } from './customer-vps-fixtures.js';
import { getUserMachine, insertUserMachine, updateUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createCustomerVpsService } from '../../packages/platform/src/customer-vps.js';
import { loadCustomerVpsConfig } from '../../packages/platform/src/customer-vps-config.js';
import { hashRegistrationToken } from '../../packages/platform/src/customer-vps-auth.js';
import { CustomerVpsError } from '../../packages/platform/src/customer-vps-errors.js';
import { buildPlatformSyncVerificationToken } from '../../packages/platform/src/platform-token.js';
import { createSitesService } from '../../packages/platform/src/sites/service.js';
import { createSiteManagementRoutes } from '../../packages/platform/src/sites/management-routes.js';
import { createSiteSubmissionTransport } from '../../packages/platform/src/sites/submission-transport.js';

const secret = 'sites-recovery-platform-secret-32-chars';
const owner = { ownerId: 'user_recovery', machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112', appSlug: 'event' };
const replacementId = 'f973bb98-2538-4f9f-a10d-1be5920a7bf7';
const identity = { handle: 'recovery', machineId: owner.machineId, runtimeSlot: 'primary' };
let db: PlatformDB;
let sites: ReturnType<typeof createSitesService>;
let customer: ReturnType<typeof createCustomerVpsService>;
let hetzner: ReturnType<typeof createMockHetznerClient>;
let systemStore: ReturnType<typeof createMockCustomerVpsSystemStore>;
let now: Date;
let nextMachineId: string;
const deployment = { title: 'Launch', slug: 'recovery-event', config: { forms: [{ id: 'rsvp', title: 'RSVP', fields: { email: { type: 'email', required: true } } }] },
  files: [{ path: 'index.html', contentType: 'text/html', body: Buffer.from('<h1>Launch</h1>').toString('base64') }] };
beforeEach(async () => {
  db = (await createTestPlatformDb()).db;
  now = new Date('2026-10-09T00:00:00.000Z');
  nextMachineId = replacementId;
  await insertUserMachine(db, { ...identity, clerkUserId: owner.ownerId, status: 'running', runtimeTokenEpoch: 2,
    hetznerServerId: 50, publicIPv4: '93.184.216.34', serverType: 'cpx22', imageVersion: 'stable', provisionedAt: now.toISOString() });
  sites = createSitesService({ db, storage: { async putObject() { return {}; }, async getObject() { return { body: null }; } } });
  hetzner = createMockHetznerClient({ getServer: vi.fn(async id => id === 50 ? { id: 50, status: 'running' } : null) });
  systemStore = createMockCustomerVpsSystemStore({ hasDbLatest: vi.fn(async () => true) });
  customer = createCustomerVpsService({ db, hetzner, systemStore,
    config: loadCustomerVpsConfig({ PLATFORM_SECRET: secret, HETZNER_API_TOKEN: 'test', S3_ACCESS_KEY_ID: 'test', S3_SECRET_ACCESS_KEY: 'test',
      S3_ENDPOINT: 'https://r2.example', R2_BUCKET: 'test', CUSTOMER_VPS_RECONCILIATION_STALE_AFTER_MS: '1000' }),
    machineIdFactory: () => nextMachineId, now: () => now,
    postgresPasswordFactory: () => 'test-postgres-password',
    tokenFactory: () => ({ token: 'registration-token', hash: hashRegistrationToken('registration-token'), expiresAt: '2099-01-01T00:00:00.000Z' }),
  });
});
afterEach(async () => { vi.unstubAllGlobals(); await destroyTestPlatformDb(db); });

it('preserves permanent IDs, aliases and versions and signs submissions for the recovered runtime', async () => {
  const site = await sites.deploy(owner, deployment);
  const secondary = await sites.deploy({ ...owner, machineId: 'secondary' }, { ...deployment, slug: 'secondary-event' });
  const otherOwner = await sites.deploy({ ...owner, ownerId: 'user_other' }, { ...deployment, slug: 'other-owner-event' });
  const recovered = await customer.recover({ clerkUserId: owner.ownerId });
  expect(vi.mocked(hetzner.createServer).mock.calls[0][0].userData).toContain(`MATRIX_SYNC_RUNTIME_TOKEN=${buildPlatformSyncVerificationToken({ ...identity, machineId: recovered.machineId }, secret, 2)}`);
  const currentOwner = { ...owner, machineId: recovered.machineId };
  expect(await sites.get(currentOwner)).toEqual(site);
  expect(await sites.get(owner)).toBeNull();
  expect(await sites.resolve('recovery-event')).toEqual(site);
  expect((await db.executor.selectFrom('public_sites').select('machine_id').where('id', '=', secondary.id).executeTakeFirstOrThrow()).machine_id).toBe('secondary');
  expect((await db.executor.selectFrom('public_sites').select('machine_id').where('id', '=', otherOwner.id).executeTakeFirstOrThrow()).machine_id).toBe(owner.machineId);

  const forward = vi.fn(async () => Response.json({ accepted: true }));
  vi.stubGlobal('fetch', forward);
  const submit = createSiteSubmissionTransport({ platformSecret: secret });
  const input = { fields: { email: 'guest@example.com' }, idempotencyKey: 'preserved-rsvp-request' };
  await expect(sites.admitted(site.id, (record, trx) => submit(record, trx, 'rsvp', input))).rejects.toThrow('unavailable');
  expect(forward).not.toHaveBeenCalled();
  await customer.register('registration-token', { machineId: recovered.machineId, hetznerServerId: 123456, publicIPv4: '93.184.216.35',
    imageVersion: 'stable', bundleSha256: '0'.repeat(64), healthy: true });
  await expect(sites.admitted(site.id, (record, trx) => submit(record, trx, 'rsvp', input))).resolves.toEqual({ accepted: true });
  const [url, request] = forward.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe(`https://93.184.216.35:443/api/internal/sites/${site.id}/submit`);
  const machine = (await getUserMachine(db, recovered.machineId))!;
  const headers = new Headers(request.headers);
  expect(headers.get('x-matrix-site-signature')).toBe(createHmac('sha256', buildPlatformSyncVerificationToken({ ...identity, machineId: recovered.machineId }, secret, machine.runtimeTokenEpoch))
    .update(`${headers.get('x-matrix-site-timestamp')}.${request.body}`).digest('hex'));
  expect(JSON.parse(request.body as string)).toMatchObject({ siteId: site.id, versionId: site.activeVersion, idempotencyKey: input.idempotencyKey });

  const app = new Hono();
  app.route('/internal/containers/:handle/sites', createSiteManagementRoutes({ db, platformSecret: secret, service: sites }));
  const endpoint = '/internal/containers/recovery/sites/event?runtimeSlot=primary';
  expect((await app.request(endpoint, { headers: { authorization: `Bearer ${buildPlatformSyncVerificationToken(identity, secret, 2)}` } })).status).toBe(401);
  const response = await app.request(endpoint, { headers: { authorization: `Bearer ${buildPlatformSyncVerificationToken({ ...identity, machineId: recovered.machineId }, secret, machine.runtimeTokenEpoch)}` } });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(site);
  const updated = await sites.deploy(currentOwner, { ...deployment, baseRevision: site.revision });
  expect(updated.id).toBe(site.id);
  expect(updated.versions).toHaveLength(2);
});

it('restores publication ownership after a definite recovery create rejection', async () => {
  const site = await sites.deploy(owner, deployment);
  vi.mocked(hetzner.createServer).mockImplementation(async () => {
    expect(await sites.get({ ...owner, machineId: replacementId })).toEqual(site);
    throw new CustomerVpsError(429, 'quota_exceeded', 'Provisioning capacity unavailable');
  });
  await expect(customer.recover({ clerkUserId: owner.ownerId })).rejects.toThrow();
  expect(await sites.get(owner)).toEqual(site);
  expect(await sites.get({ ...owner, machineId: replacementId })).toBeNull();
  expect(await getUserMachine(db, owner.machineId)).toMatchObject({ status: 'running' });
});

it('restores publication ownership on deferred expiry rollback without changing public links', async () => {
  const site = await sites.deploy(owner, deployment);
  const recovered = await customer.recover({ clerkUserId: owner.ownerId });
  expect(await sites.get({ ...owner, machineId: recovered.machineId })).toEqual(site);
  await updateUserMachine(db, recovered.machineId, { registrationTokenExpiresAt: '2020-01-01T00:00:00.000Z', provisionedAt: '2020-01-01T00:00:00.000Z' });
  now = new Date('2026-10-09T00:02:00.000Z');
  await customer.reconcileProvisioning();
  expect(await getUserMachine(db, owner.machineId)).toMatchObject({ status: 'running' });
  expect(await sites.get(owner)).toEqual(site);
  expect(await sites.get({ ...owner, machineId: recovered.machineId })).toBeNull();
  expect(await sites.resolve('recovery-event')).toEqual(site);
});

it('rejects a stale recovery pre-read rather than replacing the newly recovered machine', async () => {
  const site = await sites.deploy(owner, deployment);
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<boolean>();
  vi.mocked(systemStore.hasDbLatest).mockImplementationOnce(async () => { started.resolve(); return finish.promise; });
  const stale = customer.recover({ clerkUserId: owner.ownerId });
  await started.promise;
  try {
    const current = await customer.recover({ clerkUserId: owner.ownerId });
    await customer.register('registration-token', { machineId: current.machineId, hetznerServerId: 123456,
      publicIPv4: '93.184.216.35', imageVersion: 'stable', bundleSha256: '0'.repeat(64), healthy: true });
  } finally { finish.resolve(true); }
  await expect(stale).rejects.toThrow();
  expect(hetzner.createServer).toHaveBeenCalledOnce();
  expect(await sites.get({ ...owner, machineId: replacementId })).toEqual(site);
  expect(await getUserMachine(db, replacementId)).toMatchObject({ status: 'running' });
});

it('rolls back the machine claim when publication remapping fails', async () => {
  const site = await sites.deploy(owner, deployment);
  await sql`CREATE FUNCTION reject_site_remap() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'test remap failure'; END $$`.execute(db.executor);
  await sql`CREATE TRIGGER reject_site_remap BEFORE UPDATE OF machine_id ON public_sites
    FOR EACH ROW EXECUTE FUNCTION reject_site_remap()`.execute(db.executor);
  await expect(customer.recover({ clerkUserId: owner.ownerId })).rejects.toThrow('test remap failure');
  expect(hetzner.createServer).not.toHaveBeenCalled();
  expect(await getUserMachine(db, owner.machineId)).toMatchObject({ status: 'running' });
  expect(await getUserMachine(db, replacementId)).toBeUndefined();
  expect(await sites.get(owner)).toEqual(site);
});

it.each(['same-machine', 'different-machine'])('keeps a superseding %s recovery intact when an earlier provider request fails late', async race => {
  const site = await sites.deploy(owner, deployment);
  let supersedingIntent: string | null = null;
  vi.mocked(hetzner.createServer).mockResolvedValueOnce({ id: 123455, status: 'starting', publicIPv4: '93.184.216.35', createActionId: 9004 });
  vi.mocked(hetzner.getAction).mockResolvedValueOnce({ id: 9004, status: 'error', command: 'create_server' });
  // Compensation waits for provider deletion outside the admission transaction.
  // A reconciliation and a second recovery can complete during this await.
  vi.mocked(hetzner.deleteServer).mockImplementationOnce(async () => {
    await updateUserMachine(db, replacementId, { registrationTokenExpiresAt: '2020-01-01T00:00:00.000Z', provisionedAt: '2020-01-01T00:00:00.000Z' });
    now = new Date('2026-10-09T00:02:00.000Z');
    await customer.reconcileProvisioning();
    expect(await sites.get(owner)).toEqual(site);
    if (race === 'different-machine') nextMachineId = '30000000-0000-4000-8000-000000000026';
    await customer.recover({ clerkUserId: owner.ownerId });
    supersedingIntent = (await getUserMachine(db, nextMachineId))!.recoveryEncryptedPayload;
  });
  await expect(customer.recover({ clerkUserId: owner.ownerId })).rejects.toThrow();
  expect(await getUserMachine(db, nextMachineId)).toMatchObject({ status: 'recovering', recoveryEncryptedPayload: supersedingIntent });
  expect(await getUserMachine(db, owner.machineId)).toBeUndefined();
  expect(await sites.get({ ...owner, machineId: nextMachineId })).toEqual(site);
});
