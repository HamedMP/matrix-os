import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPlatformDb, getUserMachine, insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createSitesService } from '../../packages/platform/src/sites/service.js';
import { createSiteSubmissionTransport } from '../../packages/platform/src/sites/submission-transport.js';
import { createCustomerVpsService } from '../../packages/platform/src/customer-vps.js';
import { loadCustomerVpsConfig } from '../../packages/platform/src/customer-vps-config.js';
import { createMockCustomerVpsSystemStore, createMockHetznerClient } from './customer-vps-fixtures.js';

const connectionString = process.env.MATRIX_TEST_POSTGRES_URL;
describe.skipIf(!connectionString)('publication recovery across independent PostgreSQL sessions', () => {
  const schema = `sites_recovery_${randomUUID().replaceAll('-', '')}`;
  const secret = 'sites-recovery-race-secret-at-least-32';
  const owner = { ownerId: 'user_sites_recovery', machineId: 'live-sites-runtime', appSlug: 'event' };
  let admin: pg.Pool;
  let dbA: PlatformDB;
  let dbB: PlatformDB;
  beforeAll(async () => {
    vi.stubEnv('ACCOUNT_DELETION_SECRET', secret);
    admin = new pg.Pool({ connectionString, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    function url(name: string) {
      const target = new URL(connectionString!);
      if (!target.pathname.includes('test')) throw Error('Test database required');
      target.searchParams.set('options', `-c search_path=${schema},public -c statement_timeout=5000`);
      target.searchParams.set('application_name', name);
      return target.toString();
    }
    dbA = createPlatformDb(url('sites-live-form')); await dbA.ready;
    dbB = createPlatformDb(url('sites-recovery')); await dbB.ready;
  });
  afterAll(async () => {
    vi.unstubAllEnvs(); vi.unstubAllGlobals();
    await Promise.all([dbA?.destroy(), dbB?.destroy()]);
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); }
  });
  it('waits for the admitted live form before atomically remapping the machine and all publication references', async () => {
    await insertUserMachine(dbA, { machineId: owner.machineId, clerkUserId: owner.ownerId, handle: 'sites-live', runtimeSlot: 'primary',
      status: 'running', hetznerServerId: 50, publicIPv4: '93.184.216.34', serverType: 'cpx22', provisionedAt: new Date().toISOString() });
    const sites = createSitesService({ db: dbA, storage: { async putObject() { return {}; }, async getObject() { return { body: null }; } } });
    const site = await sites.deploy(owner, { title: 'Event', slug: 'live-recovery-event', config: { forms: [{ id: 'rsvp', title: 'RSVP', fields: { email: { type: 'email', required: true } } }] },
      files: [{ path: 'index.html', contentType: 'text/html', body: Buffer.from('Event').toString('base64') }] });
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    vi.stubGlobal('fetch', vi.fn(async () => { started.resolve(); await finish.promise; return Response.json({ accepted: true }); }));
    const submit = createSiteSubmissionTransport({ platformSecret: secret });
    const admission = sites.admitted(site.id, (record, trx) => submit(record, trx, 'rsvp', { fields: { email: 'guest@example.com' }, idempotencyKey: 'live-recovery-request' }));
    await started.promise;
    const customer = createCustomerVpsService({ db: dbB, hetzner: createMockHetznerClient(), systemStore: createMockCustomerVpsSystemStore({ hasDbLatest: async () => true }),
      config: loadCustomerVpsConfig({ PLATFORM_SECRET: secret, HETZNER_API_TOKEN: 'test', S3_ACCESS_KEY_ID: 'test', S3_SECRET_ACCESS_KEY: 'test', S3_ENDPOINT: 'https://r2.example', R2_BUCKET: 'test' }),
      machineIdFactory: () => 'recovered-sites-runtime' });
    let recovered = false;
    const recovery = customer.recover({ clerkUserId: owner.ownerId }).then(result => { recovered = true; return result; });
    try {
      let blocked = false;
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const result = await admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name='sites-recovery' AND wait_event_type='Lock'");
        if (result.rows[0].count > 0) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true); expect(recovered).toBe(false);
      expect(await getUserMachine(dbB, owner.machineId)).toMatchObject({ status: 'running' });
    } finally { finish.resolve(); await admission; await recovery; }
    expect(await sites.get({ ...owner, machineId: 'recovered-sites-runtime' })).toEqual(site);
    expect(await sites.get(owner)).toBeNull();
    expect(await sites.resolve('live-recovery-event')).toEqual(site);
    await expect(sites.admitted(site.id, (record, trx) => submit(record, trx, 'rsvp', { fields: {}, idempotencyKey: 'after-recovery-request' }))).rejects.toThrow('unavailable');
  });
});
