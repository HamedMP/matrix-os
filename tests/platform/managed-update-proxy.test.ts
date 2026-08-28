import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { insertUserMachine, type PlatformDB } from '../../packages/platform/src/db';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper';
import { allowManagedUpdateProxy } from '../../packages/platform/src/managed-update-proxy';
import { setMachineOverride } from '../../packages/platform/src/backend-management-repository';
import { createApp } from '../../packages/platform/src/main';
import { createClerkAuth } from '../../packages/platform/src/clerk-auth';
import { stubOrchestrator } from './proxy-routing-test-utils';
describe('platform protection for legacy gateways', () => {
  let db: PlatformDB;
  beforeEach(async () => { ({ db } = await createTestPlatformDb()); await insertUserMachine(db, { machineId: 'machine_1', clerkUserId: 'user_1', handle: 'person', status: 'running', publicIPv4: '95.216.1.2', provisionedAt: new Date().toISOString() }); });
  afterEach(async () => { vi.restoreAllMocks(); await destroyTestPlatformDb(db); });
  it('blocks every update alias before the shared machine bearer is injected', async () => {
    for (const path of ['/api/system/update', '/api/system/upgrade', '/api/internal/upgrade', '/vm/person/api/system/update/repair', '/api%2fsystem%2fupdate']) {
      expect(await allowManagedUpdateProxy(db, 'machine_1', 'POST', path)).toBe(false);
    }
    expect(await allowManagedUpdateProxy(db, 'machine_1', 'GET', '/api/system/info')).toBe(true);
    expect(await allowManagedUpdateProxy(db, 'machine_1', 'POST', '/api/apps')).toBe(true);
    expect(await allowManagedUpdateProxy(db, 'machine_1', 'POST', '/api/%broken')).toBe(false);
  });
  it('allows a reviewed expiring support override', async () => {
    await setMachineOverride(db, 'machine_1', { until: new Date(Date.now() + 60_000).toISOString(), reason: 'Debugging', allowVersionSelection: true });
    expect(await allowManagedUpdateProxy(db, 'machine_1', 'POST', '/api/system/update')).toBe(true);
  });
  it('protects legacy hosts through the actual session and explicit-VM proxy paths', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('ok'));
    const app = createApp({ db, orchestrator: stubOrchestrator(), platformSecret: 'platform-secret',
      clerkAuth: createClerkAuth({ verifyToken: vi.fn().mockResolvedValue({ sub: 'user_1' }) }) });
    const request = { method: 'POST', headers: { host: 'app.matrix-os.com', authorization: 'Bearer customer', 'x-matrix-customer-proxy': '0' }, body: '{}' };
    for (const path of ['/api/system/update', '/api/internal/upgrade', '/vm/person/api/system/upgrade']) {
      expect((await app.request(path, request)).status).toBe(403);
    }
    expect(fetch).not.toHaveBeenCalled();
    await setMachineOverride(db, 'machine_1', { until: new Date(Date.now() + 60_000).toISOString(), reason: 'Debugging', allowVersionSelection: true });
    for (const path of ['/api/system/update', '/vm/person/api/system/update']) {
      expect((await app.request(path, request)).status).toBe(200);
      const headers = fetch.mock.lastCall?.[1]?.headers as Headers;
      expect(headers.get('x-matrix-customer-proxy')).toBe('1');
      expect(headers.get('authorization')).not.toBe('Bearer customer');
    }
  });
});
