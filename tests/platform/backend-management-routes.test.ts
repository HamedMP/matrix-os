import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { insertUserMachine, type PlatformDB } from '../../packages/platform/src/db';
import { buildPlatformVerificationToken } from '../../packages/platform/src/platform-token';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper';
import { createBackendManagementRoutes, createClientPolicyRoutes } from '../../packages/platform/src/backend-management-routes';
import { setMachineOverride, clearMachineOverride, readBackendPolicy, updateBackendPolicy } from '../../packages/platform/src/backend-management-repository';
const secret = 'platform-admin-secret';
describe('backend management route boundaries', () => {
  let db: PlatformDB;
  beforeEach(async () => { ({ db } = await createTestPlatformDb()); });
  afterEach(async () => { vi.restoreAllMocks(); await destroyTestPlatformDb(db); });
  it('requires operator auth, validates input and rejects stale policy writes', async () => {
    const app = createBackendManagementRoutes({ db, platformSecret: secret });
    expect((await app.request('/status')).status).toBe(401);
    const request = (body: unknown) => app.request('/policy', { method: 'PUT', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await request({ revision: 0, config: { enabled: false } })).status).toBe(200);
    expect((await request({ revision: 0, config: { enabled: false } })).status).toBe(409);
    expect((await request({ revision: 1, config: { batchSize: 1000 } })).status).toBe(400);
    expect((await request({ padding: 'x'.repeat(33_000) })).status).toBe(413);
    const status = await app.request('/status', { headers: { authorization: `Bearer ${secret}` } });
    expect(status.status).toBe(200); expect(await status.json()).toMatchObject({ policy: { revision: 1 }, machines: [] });
  });
  it('keeps client policy public and no-store, with unknown clients allowed during migration', async () => {
    const app = createClientPolicyRoutes({ db });
    const response = await app.request('/?target=mobile-ios');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.json()).toEqual({ schemaVersion: 1, revision: 0, policy: null });
    expect((await app.request('/?target=invalid')).status).toBe(400);
  });
  it('rejects nonexistent canaries and unknown bridge artifacts without changing policy', async () => {
    const app = createBackendManagementRoutes({ db, platformSecret: secret });
    for (const config of [{ enabled: true, canaryMachineIds: ['missing'] }, { bootstrapVersion: 'v2026.01.01-1' }]) {
      expect((await app.request('/policy', { method: 'PUT', headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify({ revision: 0, config }) })).status).toBe(400);
    }
  });
  it('scopes support policy to a machine bearer and lets operators revoke a hold', async () => {
    await insertUserMachine(db, { machineId: 'machine_1', clerkUserId: 'user_1', handle: 'person', status: 'running', provisionedAt: new Date().toISOString() });
    const app = createBackendManagementRoutes({ db, platformSecret: secret });
    const admin = { authorization: `Bearer ${secret}` };
    const machine = { authorization: `Bearer ${buildPlatformVerificationToken('person', secret)}` };
    expect((await app.request('/machines/machine_1/policy', { headers: admin })).status).toBe(401);
    expect((await app.request('/machines/machine_1/override', { method: 'PUT', headers: admin, body: JSON.stringify({ until: new Date(Date.now() + 60_000).toISOString(), reason: 'Debugging', allowVersionSelection: true }) })).status).toBe(200);
    expect(await (await app.request('/machines/machine_1/policy', { headers: machine })).json()).toMatchObject({ versionSelectionAllowed: true });
    expect((await app.request('/machines/machine_1/override', { method: 'DELETE', headers: admin })).status).toBe(200);
    expect((await app.request('/machines/machine_1/override', { method: 'DELETE', headers: admin })).status).toBe(200);
    expect(await (await app.request('/machines/machine_1/policy', { headers: machine })).json()).toMatchObject({ versionSelectionAllowed: false, holdUntil: null });
    await db.executor.updateTable('backend_management_machines').set({ status: 'offline' }).where('machine_id', '=', 'machine_1').execute();
    expect((await app.request('/machines/machine_1/retry', { method: 'POST', headers: admin, body: '{}' })).status).toBe(200);
    expect((await app.request('/machines/machine_1/retry', { method: 'POST', headers: admin, body: '{}' })).status).toBe(409);
    expect((await app.request('/machines/missing/override', { method: 'DELETE', headers: admin })).status).toBe(404);
    expect((await app.request('/machines/machine_1/override', { method: 'PUT', headers: admin, body: JSON.stringify({ until: '2020-01-01T00:00:00.000Z', reason: 'Expired', allowVersionSelection: true }) })).status).toBe(400);
    expect((await app.request('/machines/missing/override', { method: 'PUT', headers: admin, body: JSON.stringify({ until: new Date(Date.now() + 60_000).toISOString(), reason: 'Missing', allowVersionSelection: true }) })).status).toBe(404);
  });
  it('preserves channel polling until enrollment and keeps enrolled machines paused', async () => {
    await insertUserMachine(db, { machineId: 'machine_1', clerkUserId: 'user_1', handle: 'person', status: 'running', provisionedAt: new Date().toISOString() });
    const app = createBackendManagementRoutes({ db, platformSecret: secret });
    const headers = { authorization: `Bearer ${buildPlatformVerificationToken('person', secret)}` };
    const policy = async () => (await app.request('/machines/machine_1/policy', { headers })).json();
    expect(await policy()).toMatchObject({ passiveUpdatesAllowed: true });
    const initial = await readBackendPolicy(db);
    await updateBackendPolicy(db, { ...initial.config, enabled: true }, initial.revision);
    expect(await policy()).toMatchObject({ passiveUpdatesAllowed: true });
    // A support-only row is not enrollment, but its live hold still stops polling.
    await setMachineOverride(db, 'machine_1', { until: new Date(Date.now() + 60_000).toISOString(), reason: 'Debugging', allowVersionSelection: false });
    expect(await policy()).toMatchObject({ passiveUpdatesAllowed: false });
    await clearMachineOverride(db, 'machine_1');
    expect(await policy()).toMatchObject({ passiveUpdatesAllowed: true });
    await db.executor.updateTable('backend_management_machines').set({ desired_version: 'v2026.08.28-1' }).where('machine_id', '=', 'machine_1').execute();
    expect(await policy()).toMatchObject({ passiveUpdatesAllowed: false });
    await updateBackendPolicy(db, initial.config, initial.revision + 1);
    expect(await policy()).toMatchObject({ passiveUpdatesAllowed: false });
  });
  it('keeps configuration and database failures generic instead of reporting missing data', async () => {
    const missing = createBackendManagementRoutes({ db, platformSecret: '' });
    expect((await missing.request('/status')).status).toBe(503);
    expect((await missing.request('/machines/machine_1/policy')).status).toBe(503);
    vi.spyOn(db.executor, 'selectFrom').mockImplementation(() => { throw new Error('private database failure'); });
    for (const response of [await createClientPolicyRoutes({ db }).request('/?target=mobile-ios'), await createBackendManagementRoutes({ db, platformSecret: secret }).request('/status', { headers: { authorization: `Bearer ${secret}` } })]) {
      expect(response.status).toBe(503); expect(await response.text()).not.toContain('private');
    }
  });
});
