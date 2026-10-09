import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPlatformDb, insertUserMachine, updateUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { withAccountDeletionOwnerLock } from '../../packages/platform/src/account-deletion/admission.js';
import { buildPlatformSyncVerificationToken } from '../../packages/platform/src/platform-token.js';
import { createSitesService } from '../../packages/platform/src/sites/service.js';
import { createSiteManagementRoutes } from '../../packages/platform/src/sites/management-routes.js';

const connectionString = process.env.MATRIX_TEST_POSTGRES_URL;
describe.skipIf(!connectionString)('first publication recovery admission across PostgreSQL sessions', () => {
  const schema = `sites_publish_${randomUUID().replaceAll('-', '')}`;
  const secret = 'sites-first-publish-race-secret-at-least-32';
  const identity = { handle: 'publisher', machineId: '6ca1865c-25c2-46bc-93b6-0273ef7c5527', runtimeSlot: 'primary' };
  let admin: pg.Pool;
  let dbA: PlatformDB;
  let dbB: PlatformDB;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    function url(name: string) {
      const target = new URL(connectionString!);
      if (!target.pathname.includes('test')) throw Error('Test database required');
      target.searchParams.set('options', `-c search_path=${schema},public -c statement_timeout=5000`);
      target.searchParams.set('application_name', name);
      return target.toString();
    }
    dbA = createPlatformDb(url('sites-first-publish')); await dbA.ready;
    dbB = createPlatformDb(url('sites-first-recovery')); await dbB.ready;
  });
  afterAll(async () => {
    await Promise.all([dbA?.destroy(), dbB?.destroy()]);
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); }
  });
  it('authenticates the old machine before recovery commits, then rejects it after acquiring owner admission', async () => {
    const ownerId = 'user_first_publisher';
    const env = { ACCOUNT_DELETION_SECRET: secret };
    await insertUserMachine(dbA, { ...identity, clerkUserId: ownerId, status: 'running', runtimeTokenEpoch: 2, provisionedAt: new Date().toISOString() });
    const upload = vi.fn(async () => ({}));
    const service = createSitesService({ db: dbA, env, storage: { putObject: upload, async getObject() { return { body: null }; } } });
    const app = new Hono();
    app.route('/internal/containers/:handle/sites', createSiteManagementRoutes({ db: dbA, platformSecret: secret, service }));
    const claimed = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const recovery = withAccountDeletionOwnerLock(dbB, ownerId, async trx => {
      await trx.executor.selectFrom('user_machines').select('machine_id').where('machine_id', '=', identity.machineId).forUpdate().executeTakeFirstOrThrow();
      claimed.resolve(); await finish.promise;
      await updateUserMachine(trx, identity.machineId, { machineId: 'f973bb98-2538-4f9f-a10d-1be5920a7bf7' });
    }, env);
    await claimed.promise;
    const publication = app.request('/internal/containers/publisher/sites/event?runtimeSlot=primary', { method: 'POST',
      headers: { authorization: `Bearer ${buildPlatformSyncVerificationToken(identity, secret, 2)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Event', config: {}, files: [{ path: 'index.html', contentType: 'text/html', body: Buffer.from('Event').toString('base64') }] }) });
    try {
      let blocked = false;
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const result = await admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name='sites-first-publish' AND wait_event_type='Lock'");
        if (result.rows[0].count > 0) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
    } finally { finish.resolve(); await recovery; }
    expect((await publication).status).toBe(503);
    expect(upload).not.toHaveBeenCalled();
    expect(await dbA.executor.selectFrom('public_sites').selectAll().execute()).toEqual([]);
  });
});
